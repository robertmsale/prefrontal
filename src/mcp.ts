import { FastMCP } from "@punkpeye/fastmcp";
import { z } from "@zod/zod";
import * as path from "@std/path";
import { loadConfig } from "./config.ts";
import { embedDocument, embedQuery } from "./ollama.ts";
import { QdrantRestClient } from "./qdrant.ts";
import {
  ActivityDigestParams,
  ActivityEventSchema,
  ActivityLatestByAgentParams,
  ActivityPostParams,
  LocksAcquireParams,
  LockSchema,
  LocksListParams,
  LocksReleaseAllParams,
  LocksReleaseParams,
  MemoryGetFileContextParams,
  MemorySearchInFileParams,
  MemorySearchParams,
  MemoryUpsertChunksParams,
  StatsGetParams,
  TaskSchema,
  TasksClaimParams,
  TasksCompleteParams,
  TasksCreateAndClaimParams,
  TasksCreateParams,
  TasksListActiveParams,
  TasksSearchActiveParams,
  TasksSearchSimilarParams,
  TasksUpdateParams,
} from "./schemas.ts";

const TASK_VECTOR_SIZE = 1024;
const LOCK_VECTOR_SIZE = 1;
const ACTIVITY_VECTOR_SIZE = 1;
const REPO_CHUNK_VECTOR_SIZE = 1024;

type TaskStatus =
  | "open"
  | "claimed"
  | "in_progress"
  | "blocked"
  | "done"
  | "abandoned";

type TransportMode = "auto" | "stdio" | "http";

function nowMs(): number {
  return Date.now();
}

async function stableUuid(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const b = hash.slice(0, 16);
  // UUID v5-ish (deterministic), variant RFC4122.
  b[6] = (b[6] & 0x0f) | 0x50;
  b[8] = (b[8] & 0x3f) | 0x80;

  const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${
    hex.slice(16, 20)
  }-${hex.slice(20)}`;
}

function ok<T>(value: T) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }] as any[],
  };
}

function qdrantCollections(prefix: string) {
  return {
    tasks: `${prefix}_tasks`,
    locks: `${prefix}_locks`,
    activity: `${prefix}_activity`,
    repoChunks: `${prefix}_repo_chunks`,
  };
}

async function gitTopLevel(cwd: string): Promise<string | null> {
  try {
    const cmd = new Deno.Command("git", {
      cwd,
      args: ["rev-parse", "--show-toplevel"],
      stdin: "null",
      stdout: "piped",
      stderr: "null",
    });
    const out = await cmd.output();
    if (!out.success) return null;
    const txt = new TextDecoder().decode(out.stdout).trim();
    if (!txt) return null;
    return path.resolve(cwd, txt);
  } catch {
    return null;
  }
}

async function gitWorktreeRoots(cwd: string): Promise<string[]> {
  const roots = new Set<string>();
  const top = await gitTopLevel(cwd);
  if (top) roots.add(path.normalize(top));
  try {
    const cmd = new Deno.Command("git", {
      cwd,
      args: ["worktree", "list", "--porcelain"],
      stdin: "null",
      stdout: "piped",
      stderr: "null",
    });
    const out = await cmd.output();
    if (out.success) {
      const text = new TextDecoder().decode(out.stdout);
      for (const line of text.split("\n")) {
        if (!line.startsWith("worktree ")) continue;
        const wt = line.slice("worktree ".length).trim();
        if (wt.length === 0) continue;
        const abs = path.isAbsolute(wt) ? wt : path.resolve(cwd, wt);
        roots.add(path.normalize(abs));
      }
    }
  } catch {
    // ignore
  }
  return Array.from(roots);
}

function normalizeRepoPath(
  input: string,
  repoRoots: string[] | null,
): string {
  let s = input.trim();
  if (s.startsWith("file://")) {
    try {
      s = new URL(s).pathname;
    } catch {
      // ignore
    }
  }

  // Convert absolute paths under this repo root into repo-relative paths.
  if (repoRoots && path.isAbsolute(s)) {
    const abs = path.normalize(s);
    for (const root of repoRoots) {
      const prefix = root.endsWith("/") || root.endsWith("\\")
        ? root
        : `${root}/`;
      if (abs === root) return ".";
      if (abs.startsWith(prefix)) {
        const rel = path.relative(root, abs);
        return rel.replaceAll("\\", "/").replace(/^\.\/+/, "");
      }
    }
  }

  // Keep relative paths stable.
  const norm = path.normalize(s).replaceAll("\\", "/");
  return norm.replace(/^\.\/+/, "");
}

function normalizePaths(
  paths: string[] | null | undefined,
  repoRoots: string[] | null,
): string[] | undefined {
  if (!paths) return undefined;
  return paths.map((p) => normalizeRepoPath(p, repoRoots));
}

function normalizeTaskPaths(
  task: z.infer<typeof TaskSchema>,
  repoRoots: string[] | null,
): z.infer<typeof TaskSchema> {
  return {
    ...task,
    related_paths: normalizePaths(task.related_paths, repoRoots) ?? [],
  };
}

function normalizeActivityPaths(
  event: z.infer<typeof ActivityEventSchema>,
  repoRoots: string[] | null,
): z.infer<typeof ActivityEventSchema> {
  const next = normalizePaths(event.related_paths, repoRoots);
  return {
    ...event,
    related_paths: next,
  };
}

function formatInvalidParamsErrorMessage(issues: z.ZodIssue[]): string {
  const parts = issues.map((issue) => {
    const pathLabel = issue.path?.length ? issue.path.join(".") : "root";
    return `${pathLabel}: ${issue.message}`;
  });
  return `Invalid tool parameters: ${parts.join("; ")}`;
}

function chunkProvenance(chunk: any): string {
  const pathPart = typeof chunk?.path === "string" ? chunk.path : "?";
  const start = chunk?.chunk?.start_line;
  const end = chunk?.chunk?.end_line;
  let linePart = "";
  if (typeof start === "number") {
    linePart = `#L${start}`;
    if (typeof end === "number" && end !== start) {
      linePart += `-L${end}`;
    }
  }
  const commit = typeof chunk?.commit === "string" && chunk.commit.length > 0
    ? chunk.commit
    : null;
  const commitPart = commit ? `@${commit.slice(0, 8)}` : "";
  return `${pathPart}${linePart}${commitPart}`;
}

function normalizeChunkPayload(
  payload: any,
  repoRoots: string[] | null,
  includeProvenance: boolean,
) {
  if (!payload || typeof payload !== "object") return payload;
  const normalizedPath = typeof payload.path === "string"
    ? normalizeRepoPath(payload.path, repoRoots)
    : payload.path;
  const normalized = { ...payload, path: normalizedPath };
  if (!includeProvenance) return normalized;
  return { ...normalized, provenance: chunkProvenance(normalized) };
}

export async function startPrefrontalMcpServer(
  opts?: { transport?: TransportMode },
) {
  const config = await loadConfig();
  const collections = qdrantCollections(config.qdrantPrefix);

  const qdrant = new QdrantRestClient(config.qdrantUrl, config.qdrantApiKey);
  const repoRoots = await gitWorktreeRoots(Deno.cwd());
  const repoRootsOrNull = repoRoots.length ? repoRoots : null;

  // Sanity check: embedding dimensionality must match collection schema.
  const dimProbe = await embedQuery(
    config.ollamaUrl,
    config.ollamaModel,
    "prefrontal-dim-probe",
  );
  if (dimProbe.vector.length !== TASK_VECTOR_SIZE) {
    throw new Error(
      `Embedding dimension mismatch: expected ${TASK_VECTOR_SIZE} but got ${dimProbe.vector.length} from Ollama model '${config.ollamaModel}'.`,
    );
  }

  await qdrant.createCollectionIfMissing(collections.tasks, {
    size: TASK_VECTOR_SIZE,
    distance: "Cosine",
  });
  await qdrant.createCollectionIfMissing(collections.repoChunks, {
    size: REPO_CHUNK_VECTOR_SIZE,
    distance: "Cosine",
  });
  await qdrant.createCollectionIfMissing(collections.locks, {
    size: LOCK_VECTOR_SIZE,
    distance: "Cosine",
  });
  await qdrant.createCollectionIfMissing(collections.activity, {
    size: ACTIVITY_VECTOR_SIZE,
    distance: "Cosine",
  });

  await qdrant.createPayloadIndex(collections.tasks, "status", "keyword").catch(
    () => {},
  );
  await qdrant.createPayloadIndex(collections.tasks, "task_id", "keyword")
    .catch(
      () => {},
    );
  await qdrant.createPayloadIndex(collections.tasks, "version", "integer")
    .catch(
      () => {},
    );
  await qdrant.createPayloadIndex(
    collections.tasks,
    "last_update_at",
    "integer",
  ).catch(() => {});
  await qdrant.createPayloadIndex(collections.activity, "ts", "integer").catch(
    () => {},
  );
  await qdrant.createPayloadIndex(collections.activity, "agent_id", "keyword")
    .catch(
      () => {},
    );
  await qdrant.createPayloadIndex(collections.locks, "agent_id", "keyword")
    .catch(
      () => {},
    );
  await qdrant.createPayloadIndex(collections.locks, "mode", "keyword").catch(
    () => {},
  );
  await qdrant.createPayloadIndex(collections.locks, "path", "keyword").catch(
    () => {},
  );
  await qdrant.createPayloadIndex(collections.locks, "expires_at", "integer")
    .catch(() => {});

  const server = new FastMCP({
    name: "prefrontal",
    version: "0.1.0",
    utils: {
      formatInvalidParamsErrorMessage,
    },
  });

  // --- stats (read-only) ---
  server.addTool({
    name: "stats_get",
    description:
      "Get basic usage stats for the coordination database (counts and optional file path references).",
    parameters: StatsGetParams,
    annotations: { readOnlyHint: true },
    execute: async (args) => {
      const counts = {
        repo_chunks: await qdrant.count(collections.repoChunks),
        tasks: await qdrant.count(collections.tasks),
        locks: await qdrant.count(collections.locks),
        activity: await qdrant.count(collections.activity),
      };

      const now = nowMs();
      const activeStatuses = ["open", "claimed", "in_progress", "blocked"];
      const locksExpiringWithinSeconds = args.locks_expiring_within_seconds ??
        15 * 60;
      const tasksStaleAfterSeconds = args.tasks_stale_after_seconds ??
        24 * 60 * 60;

      const [expiringLocksCount, staleTasksCount] = await Promise.all([
        qdrant.count(collections.locks, {
          filter: {
            must: [{
              key: "expires_at",
              range: {
                gte: now,
                lte: now + locksExpiringWithinSeconds * 1000,
              },
            }],
          },
        }),
        qdrant.count(collections.tasks, {
          filter: {
            must: [
              { key: "status", match: { any: activeStatuses } },
              {
                key: "last_update_at",
                range: { lte: now - tasksStaleAfterSeconds * 1000 },
              },
            ],
          },
        }),
      ]);

      const age = {
        locks_expiring_soon: {
          count: expiringLocksCount,
          window_seconds: locksExpiringWithinSeconds,
          window_ends_at: now + locksExpiringWithinSeconds * 1000,
        },
        tasks_stale: {
          count: staleTasksCount,
          threshold_seconds: tasksStaleAfterSeconds,
          stale_before_ts: now - tasksStaleAfterSeconds * 1000,
        },
      };

      const includePaths = args.include_paths;
      const includeAgentStats = args.include_agent_stats ?? true;
      const maxPoints = args.max_points ?? 5000;
      const sampleCount = args.sample_paths ?? 20;

      const uniquePaths = new Set<string>();
      const tasksByAgent: Record<string, number> = {};
      const locksByAgent: Record<string, number> = {};
      let taskScanTruncated = false;
      let lockScanTruncated = false;
      let repoScan = { scanned: 0, truncated: false };
      let taskScan = { scanned: 0, truncated: false };
      let lockScan = { scanned: 0, truncated: false };
      let activityScan = { scanned: 0, truncated: false };

      async function collectPaths(
        collection: string,
        addFromPayload: (payload: any, out: Set<string>) => void,
      ): Promise<{ scanned: number; truncated: boolean }> {
        const paths = new Set<string>();
        let scanned = 0;
        let offset: unknown | undefined = undefined;
        let truncated = false;

        while (scanned < maxPoints) {
          const limit = Math.min(256, maxPoints - scanned);
          const page = await qdrant.scrollPage(collection, {
            limit,
            offset,
            with_payload: true,
            with_vectors: false,
          });
          for (const p of page.points) {
            const payload = p?.payload;
            if (payload) addFromPayload(payload, paths);
          }
          scanned += page.points.length;
          if (!page.next_offset) break;
          offset = page.next_offset;
          if (page.points.length === 0) break;
          if (scanned >= maxPoints) truncated = true;
        }

        for (const path of paths) uniquePaths.add(path);
        return { scanned, truncated };
      }

      async function scanTasksAndAgents() {
        let scanned = 0;
        let offset: unknown | undefined = undefined;
        let truncated = false;
        while (scanned < maxPoints) {
          const limit = Math.min(256, maxPoints - scanned);
          const page = await qdrant.scrollPage(collections.tasks, {
            limit,
            offset,
            with_payload: true,
            with_vectors: false,
          });
          for (const p of page.points) {
            const payload = p?.payload;
            if (!payload || typeof payload !== "object") continue;
            if (includePaths) {
              const v = (payload as any)?.related_paths;
              if (Array.isArray(v)) {
                for (const x of v) {
                  if (typeof x === "string" && x.length > 0) {
                    uniquePaths.add(normalizeRepoPath(x, repoRootsOrNull));
                  }
                }
              }
            }
            if (includeAgentStats) {
              const status = (payload as any)?.status;
              const claimed = (payload as any)?.claimed_by;
              const agentId = claimed?.agent_id;
              if (
                typeof agentId === "string" &&
                activeStatuses.includes(status)
              ) {
                tasksByAgent[agentId] = (tasksByAgent[agentId] ?? 0) + 1;
              }
            }
          }
          scanned += page.points.length;
          if (!page.next_offset) break;
          offset = page.next_offset;
          if (page.points.length === 0) break;
          if (scanned >= maxPoints) truncated = true;
        }
        taskScan = { scanned, truncated };
        taskScanTruncated = truncated;
      }

      async function scanLocksAndAgents() {
        let scanned = 0;
        let offset: unknown | undefined = undefined;
        let truncated = false;
        while (scanned < maxPoints) {
          const limit = Math.min(256, maxPoints - scanned);
          const page = await qdrant.scrollPage(collections.locks, {
            limit,
            offset,
            with_payload: true,
            with_vectors: false,
          });
          for (const p of page.points) {
            const payload = p?.payload;
            if (!payload || typeof payload !== "object") continue;
            if (includePaths) {
              const v = (payload as any)?.path;
              if (typeof v === "string" && v.length > 0) {
                uniquePaths.add(normalizeRepoPath(v, repoRootsOrNull));
              }
            }
            if (includeAgentStats) {
              const expiresAt = (payload as any)?.expires_at;
              const agentId = (payload as any)?.agent_id;
              if (
                typeof agentId === "string" &&
                typeof expiresAt === "number" &&
                expiresAt > now
              ) {
                locksByAgent[agentId] = (locksByAgent[agentId] ?? 0) + 1;
              }
            }
          }
          scanned += page.points.length;
          if (!page.next_offset) break;
          offset = page.next_offset;
          if (page.points.length === 0) break;
          if (scanned >= maxPoints) truncated = true;
        }
        lockScan = { scanned, truncated };
        lockScanTruncated = truncated;
      }

      if (includePaths) {
        repoScan = await collectPaths(collections.repoChunks, (p, out) => {
          const v = p?.path;
          if (typeof v === "string" && v.length > 0) {
            out.add(normalizeRepoPath(v, repoRootsOrNull));
          }
        });
        activityScan = await collectPaths(collections.activity, (p, out) => {
          const v = p?.related_paths;
          if (Array.isArray(v)) {
            for (const x of v) {
              if (typeof x === "string" && x.length > 0) {
                out.add(normalizeRepoPath(x, repoRootsOrNull));
              }
            }
          }
        });
      }

      if (includePaths || includeAgentStats) {
        await scanTasksAndAgents();
        await scanLocksAndAgents();
      }

      const response: Record<string, unknown> = { counts, age };

      if (includePaths) {
        const sample_paths = Array.from(uniquePaths).sort().slice(
          0,
          sampleCount,
        );
        const truncated = repoScan.truncated || taskScan.truncated ||
          lockScan.truncated || activityScan.truncated;
        response.file_refs = {
          unique_paths_count: uniquePaths.size,
          sample_paths,
        };
        response.scanned = {
          repo_chunks: repoScan.scanned,
          tasks: taskScan.scanned,
          locks: lockScan.scanned,
          activity: activityScan.scanned,
          truncated,
          max_points_per_collection: maxPoints,
        };
      } else if (includeAgentStats) {
        response.scanned = {
          tasks: taskScan.scanned,
          locks: lockScan.scanned,
          truncated: taskScanTruncated || lockScanTruncated,
          max_points_per_collection: maxPoints,
        };
      }

      if (includeAgentStats) {
        response.agent_stats = {
          tasks_by_agent: tasksByAgent,
          locks_by_agent: locksByAgent,
          truncated: taskScanTruncated || lockScanTruncated,
        };
      }

      return ok(response);
    },
  });

  async function latestActivityForAgent(agentId: string) {
    const points = await qdrant.scroll(collections.activity, {
      limit: 1,
      filter: { must: [{ key: "agent_id", match: { value: agentId } }] },
      order_by: { key: "ts", direction: "desc" },
      with_payload: true,
      with_vectors: false,
    });
    if (!points.length) return null;
    const payload = points[0]?.payload;
    if (!payload) return null;
    const parsed = ActivityEventSchema.parse(payload);
    return normalizeActivityPaths(parsed, repoRootsOrNull);
  }

  // --- activity ---
  server.addTool({
    name: "activity_post",
    description: "Append an activity event to the project digest stream.",
    parameters: ActivityPostParams,
    execute: async (args) => {
      const warnings: string[] = [];
      if (Array.isArray(args.related_paths)) {
        for (const rawPath of args.related_paths) {
          const normalized = normalizeRepoPath(rawPath, repoRootsOrNull);
          if (path.isAbsolute(normalized)) {
            warnings.push(`Non-repo path retained: ${rawPath}`);
          }
        }
      }
      const relatedPaths = normalizePaths(
        args.related_paths ?? undefined,
        repoRootsOrNull,
      );
      const event = ActivityEventSchema.parse({
        event_id: crypto.randomUUID(),
        ts: nowMs(),
        type: args.type,
        message: args.message,
        related_paths: relatedPaths ?? undefined,
        task_id: args.task_id ?? undefined,
      });

      await qdrant.upsert(collections.activity, [{
        id: event.event_id,
        vector: [0],
        payload: event as any,
      }], true);

      if (!warnings.length) return ok(event);
      return ok({ ...event, warnings });
    },
  });

  server.addTool({
    name: "activity_digest",
    description:
      "Get recent activity events since a cursor (milliseconds since epoch).",
    parameters: ActivityDigestParams,
    execute: async (args) => {
      const direction = args.direction ?? "asc";
      const since = args.since_cursor ?? null;
      const typeFilter = args.type ?? null;
      const prefix = args.related_path_prefix
        ? normalizeRepoPath(args.related_path_prefix, repoRootsOrNull)
        : null;
      const filter = typeFilter
        ? { must: [{ key: "type", match: { value: typeFilter } }] }
        : undefined;

      const want = args.limit;
      const events: z.infer<typeof ActivityEventSchema>[] = [];
      let offset: unknown | undefined = undefined;
      let first = true;
      const startFrom = (() => {
        if (since === null) return undefined;
        if (direction === "asc") return since + 1;
        const candidate = since - 1;
        return candidate < 0 ? 0 : candidate;
      })();

      while (events.length < want) {
        const limit = Math.min(200, want - events.length);
        const page = await qdrant.scrollPage(collections.activity, {
          limit,
          offset,
          filter,
          order_by: {
            key: "ts",
            direction,
            ...(first && typeof startFrom === "number"
              ? { start_from: startFrom }
              : {}),
          },
          with_payload: true,
          with_vectors: false,
        });
        first = false;
        if (!page.points.length) break;
        for (const p of page.points) {
          if (!p?.payload) continue;
          const parsed = ActivityEventSchema.parse(p.payload);
          const normalized = normalizeActivityPaths(parsed, repoRootsOrNull);
          if (prefix) {
            const paths = normalized.related_paths ?? [];
            if (!paths.some((p) => p.startsWith(prefix))) continue;
          }
          events.push(normalized);
          if (events.length >= want) break;
        }
        if (!page.next_offset) break;
        offset = page.next_offset;
      }

      const nextCursor = events.length
        ? events[events.length - 1].ts
        : (since ?? 0);
      return ok({ events, next_cursor: nextCursor });
    },
  });

  server.addTool({
    name: "activity_latest_by_agent",
    description: "Get the most recent activity event for a given agent.",
    parameters: ActivityLatestByAgentParams,
    execute: async (args) => {
      const event = await latestActivityForAgent(args.agent_id);
      return ok({ event });
    },
  });

  // --- tasks ---
  server.addTool({
    name: "tasks_create_and_claim",
    description: "Create a new coordination task and claim it immediately.",
    parameters: TasksCreateAndClaimParams,
    execute: async (args) => {
      const taskId = crypto.randomUUID();
      const relatedPaths =
        normalizePaths(args.related_paths, repoRootsOrNull) ?? [];
      const taskText = `${args.title}\n${args.description}\n${
        relatedPaths.join("\n")
      }`;
      const vec = await embedDocument(
        config.ollamaUrl,
        config.ollamaModel,
        taskText,
      );

      const leaseUntil = nowMs() + args.lease_seconds * 1000;
      const claimedBy = {
        agent_id: args.agent_id,
        ...(args.worktree ? { worktree: args.worktree } : {}),
        ...(args.branch ? { branch: args.branch } : {}),
      };

      const task = TaskSchema.parse({
        task_id: taskId,
        title: args.title,
        description: args.description,
        status: "in_progress" as TaskStatus,
        claimed_by: claimedBy,
        related_paths: relatedPaths,
        base_commit: args.base_commit ?? undefined,
        last_update_at: nowMs(),
        lease_until: leaseUntil,
        version: 0,
        priority: args.priority ?? undefined,
        tags: args.tags ?? undefined,
      });

      await qdrant.upsert(collections.tasks, [{
        id: taskId,
        vector: vec.vector,
        payload: task as any,
      }], true);

      await qdrant.upsert(collections.activity, [{
        id: crypto.randomUUID(),
        vector: [0],
        payload: {
          event_id: crypto.randomUUID(),
          ts: nowMs(),
          type: "task_created",
          message: task.title,
          related_paths: task.related_paths,
          task_id: task.task_id,
          agent_id: args.agent_id,
        },
      }], true).catch(() => {});

      await qdrant.upsert(collections.activity, [{
        id: crypto.randomUUID(),
        vector: [0],
        payload: {
          event_id: crypto.randomUUID(),
          ts: nowMs(),
          type: "task_claimed",
          message: `${task.title} (claimed by ${args.agent_id})`,
          related_paths: task.related_paths,
          task_id: task.task_id,
          agent_id: args.agent_id,
        },
      }], true).catch(() => {});

      return ok({ task_id: taskId, claimed: true });
    },
  });

  server.addTool({
    name: "tasks_create",
    description: "Create a new coordination task.",
    parameters: TasksCreateParams,
    execute: async (args) => {
      const taskId = crypto.randomUUID();
      const relatedPaths =
        normalizePaths(args.related_paths, repoRootsOrNull) ??
          [];
      const taskText = `${args.title}\n${args.description}\n${
        relatedPaths.join("\n")
      }`;
      const vec = await embedDocument(
        config.ollamaUrl,
        config.ollamaModel,
        taskText,
      );

      const task = TaskSchema.parse({
        task_id: taskId,
        title: args.title,
        description: args.description,
        status: "open" as TaskStatus,
        claimed_by: null,
        related_paths: relatedPaths,
        base_commit: args.base_commit ?? undefined,
        last_update_at: nowMs(),
        lease_until: null,
        version: 0,
        priority: args.priority ?? undefined,
        tags: args.tags ?? undefined,
      });

      await qdrant.upsert(collections.tasks, [{
        id: taskId,
        vector: vec.vector,
        payload: task as any,
      }], true);

      await qdrant.upsert(collections.activity, [{
        id: crypto.randomUUID(),
        vector: [0],
        payload: {
          event_id: crypto.randomUUID(),
          ts: nowMs(),
          type: "task_created",
          message: task.title,
          related_paths: task.related_paths,
          task_id: task.task_id,
        },
      }], true).catch(() => {});

      return ok({ task_id: taskId });
    },
  });

  server.addTool({
    name: "tasks_list_active",
    description: "List active tasks (structured, not semantic).",
    parameters: TasksListActiveParams,
    execute: async (args) => {
      const statuses = args.status_in ??
        ["open", "claimed", "in_progress", "blocked"];
      const points = await qdrant.scroll(collections.tasks, {
        limit: args.limit,
        filter: {
          must: [{
            key: "status",
            match: { any: statuses },
          }],
        },
        with_payload: true,
        with_vectors: false,
      });
      const tasks = points.map((p) => p.payload).filter(Boolean).map((p: any) =>
        normalizeTaskPaths(TaskSchema.parse(p), repoRootsOrNull)
      );
      return ok({ tasks });
    },
  });

  server.addTool({
    name: "tasks_search_similar",
    description: "Semantic search for tasks that overlap with a query.",
    parameters: TasksSearchSimilarParams,
    execute: async (args) => {
      const statuses = args.status_in ??
        ["open", "claimed", "in_progress", "blocked"];
      const q = await embedQuery(
        config.ollamaUrl,
        config.ollamaModel,
        args.query,
      );
      const hits = await qdrant.search(collections.tasks, q.vector, args.k, {
        must: [{
          key: "status",
          match: { any: statuses },
        }],
      }, true);
      const results = hits.map((h: any) => ({
        score: h.score,
        task: normalizeTaskPaths(TaskSchema.parse(h.payload), repoRootsOrNull),
      }));
      return ok({ results });
    },
  });

  server.addTool({
    name: "tasks_search_active",
    description:
      "Semantic search among active tasks, returning results and active list.",
    parameters: TasksSearchActiveParams,
    execute: async (args) => {
      const statuses = ["open", "claimed", "in_progress", "blocked"];
      const q = await embedQuery(
        config.ollamaUrl,
        config.ollamaModel,
        args.query,
      );
      const hits = await qdrant.search(collections.tasks, q.vector, args.k, {
        must: [{
          key: "status",
          match: { any: statuses },
        }],
      }, true);
      const results = hits.map((h: any) => ({
        score: h.score,
        task: normalizeTaskPaths(TaskSchema.parse(h.payload), repoRootsOrNull),
      }));

      const points = await qdrant.scroll(collections.tasks, {
        limit: args.limit,
        filter: {
          must: [{
            key: "status",
            match: { any: statuses },
          }],
        },
        with_payload: true,
        with_vectors: false,
      });
      const tasks = points.map((p) => p.payload).filter(Boolean).map(
        (p: any) => normalizeTaskPaths(TaskSchema.parse(p), repoRootsOrNull),
      );
      return ok({ results, tasks });
    },
  });

  async function getTask(taskId: string) {
    const pts = await qdrant.retrieve(collections.tasks, [taskId], true, false);
    if (!pts.length) return null;
    const payload = pts[0].payload;
    if (!payload) return null;
    return normalizeTaskPaths(TaskSchema.parse(payload), repoRootsOrNull);
  }

  server.addTool({
    name: "tasks_claim",
    description:
      "Claim a task using optimistic concurrency via the task version field.",
    parameters: TasksClaimParams,
    execute: async (args) => {
      const task = await getTask(args.task_id);
      if (!task) return ok({ ok: false, conflict: true, reason: "not_found" });
      if (task.status === "done" || task.status === "abandoned") {
        return ok({ ok: false, conflict: true, reason: "not_claimable" });
      }

      const currentLeaseUntil = task.lease_until ?? 0;
      const leaseExpired = currentLeaseUntil !== 0 &&
        currentLeaseUntil < nowMs();
      const heldByOther = task.claimed_by &&
        task.claimed_by.agent_id !== args.agent_id && !leaseExpired;
      if (heldByOther) {
        return ok({
          ok: false,
          conflict: true,
          reason: "already_claimed",
          claimed_by: task.claimed_by,
          lease_until: task.lease_until ?? null,
        });
      }

      const nextVersion = task.version + 1;
      const leaseUntil = nowMs() + args.lease_seconds * 1000;
      const claimedBy = {
        agent_id: args.agent_id,
        ...(args.worktree ? { worktree: args.worktree } : {}),
        ...(args.branch ? { branch: args.branch } : {}),
      };

      await qdrant.setPayload(
        collections.tasks,
        {
          status: "in_progress",
          claimed_by: claimedBy,
          lease_until: leaseUntil,
          last_update_at: nowMs(),
          version: nextVersion,
        },
        {
          must: [
            { key: "task_id", match: { value: args.task_id } },
            { key: "version", match: { value: task.version } },
          ],
        },
        true,
      );

      const after = await getTask(args.task_id);
      const okClaim = after?.version === nextVersion &&
        after?.claimed_by?.agent_id === args.agent_id;

      if (!okClaim) {
        const latest = await getTask(args.task_id);
        return ok({
          ok: false,
          conflict: true,
          reason: "version_conflict",
          claimed_by: latest?.claimed_by ?? null,
          lease_until: latest?.lease_until ?? null,
        });
      }

      await qdrant.upsert(collections.activity, [{
        id: crypto.randomUUID(),
        vector: [0],
        payload: {
          event_id: crypto.randomUUID(),
          ts: nowMs(),
          type: "task_claimed",
          message: `${after!.title} (claimed by ${args.agent_id})`,
          related_paths: after!.related_paths,
          task_id: after!.task_id,
          agent_id: args.agent_id,
        },
      }], true).catch(() => {});

      return ok({ ok: true });
    },
  });

  server.addTool({
    name: "tasks_update",
    description: "Update task status/progress with optimistic concurrency.",
    parameters: TasksUpdateParams,
    execute: async (args) => {
      const task = await getTask(args.task_id);
      if (!task) return ok({ ok: false, reason: "not_found" });

      const nextVersion = task.version + 1;
      const nextLease = args.lease_extend_seconds
        ? (nowMs() + args.lease_extend_seconds * 1000)
        : task.lease_until;

      const patch: Record<string, unknown> = {
        version: nextVersion,
        last_update_at: nowMs(),
      };
      if (args.status) patch.status = args.status;
      if (args.related_paths) {
        patch.related_paths = normalizePaths(
          args.related_paths,
          repoRootsOrNull,
        );
      }
      if (typeof nextLease !== "undefined") patch.lease_until = nextLease;

      await qdrant.setPayload(collections.tasks, patch, {
        must: [
          { key: "task_id", match: { value: args.task_id } },
          { key: "version", match: { value: task.version } },
        ],
      }, true);

      const after = await getTask(args.task_id);
      if (!after || after.version !== nextVersion) {
        return ok({ ok: false, conflict: true, reason: "version_conflict" });
      }

      if (args.progress_note) {
        await qdrant.upsert(collections.activity, [{
          id: crypto.randomUUID(),
          vector: [0],
          payload: {
            event_id: crypto.randomUUID(),
            ts: nowMs(),
            type: "task_progress",
            message: `${after.title}: ${args.progress_note}`,
            related_paths: normalizePaths(after.related_paths, repoRootsOrNull),
            task_id: after.task_id,
          },
        }], true).catch(() => {});
      }

      return ok({ ok: true });
    },
  });

  server.addTool({
    name: "tasks_complete",
    description: "Mark a task done (optionally attaching a result commit).",
    parameters: TasksCompleteParams,
    execute: async (args) => {
      const task = await getTask(args.task_id);
      if (!task) return ok({ ok: false, reason: "not_found" });
      const nextVersion = task.version + 1;

      await qdrant.setPayload(collections.tasks, {
        status: "done",
        last_update_at: nowMs(),
        version: nextVersion,
        result_commit: args.result_commit ?? null,
      }, {
        must: [
          { key: "task_id", match: { value: args.task_id } },
          { key: "version", match: { value: task.version } },
        ],
      }, true);

      const after = await getTask(args.task_id);
      if (!after || after.version !== nextVersion) {
        return ok({ ok: false, conflict: true, reason: "version_conflict" });
      }

      await qdrant.upsert(collections.activity, [{
        id: crypto.randomUUID(),
        vector: [0],
        payload: {
          event_id: crypto.randomUUID(),
          ts: nowMs(),
          type: "task_done",
          message: `${after.title}${
            args.result_commit ? ` (commit ${args.result_commit})` : ""
          }`,
          related_paths: normalizePaths(after.related_paths, repoRootsOrNull),
          task_id: after.task_id,
        },
      }], true).catch(() => {});

      return ok({ ok: true });
    },
  });

  async function collectActiveLocks() {
    const now = nowMs();
    const activeAll = await qdrant.scroll(collections.locks, {
      limit: 500,
      filter: { must: [{ key: "expires_at", range: { gte: now } }] },
      with_payload: true,
      with_vectors: false,
    });
    return activeAll.map((p) => p.payload).filter(Boolean).map(
      (p: any) => LockSchema.safeParse(p),
    ).filter((r) => r.success).map((r: any) =>
      r.data as z.infer<typeof LockSchema>
    );
  }

  async function releaseLocks(paths: string[], agentId: string) {
    const results: Array<{ path: string; ok: boolean }> = [];
    const activeLocks = await collectActiveLocks();

    for (const rawPath of paths) {
      const repoPath = normalizeRepoPath(rawPath, repoRootsOrNull);

      // Release the canonical lock id (repo-relative path).
      const canonicalId = await stableUuid(`lock:${repoPath}:${agentId}`);
      const canonicalExisting = await qdrant.retrieve(
        collections.locks,
        [canonicalId],
        true,
        false,
      ).catch(() => []);

      const canonicalPayload = canonicalExisting.length
        ? canonicalExisting[0]?.payload
        : null;
      const canonicalParsed = canonicalPayload
        ? LockSchema.safeParse(canonicalPayload)
        : null;
      const canonicalHeld = canonicalParsed?.success
        ? canonicalParsed.data
        : null;
      if (canonicalHeld && canonicalHeld.agent_id === agentId) {
        const released = LockSchema.parse({
          path: canonicalHeld.path,
          agent_id: agentId,
          mode: canonicalHeld.mode,
          expires_at: 0,
        });
        await qdrant.upsert(
          collections.locks,
          [{ id: canonicalId, vector: [0], payload: released as any }],
          true,
        );
      }

      // Backward-compat: release any existing lock records held by this agent
      // whose normalized path matches, regardless of stored (absolute) path.
      const matches = activeLocks.filter((l) =>
        l.agent_id === agentId &&
        normalizeRepoPath(l.path, repoRootsOrNull) === repoPath
      );
      for (const held of matches) {
        const id = await stableUuid(`lock:${held.path}:${agentId}`);
        const released = LockSchema.parse({
          path: held.path,
          agent_id: agentId,
          mode: held.mode,
          expires_at: 0,
        });
        await qdrant.upsert(
          collections.locks,
          [{ id, vector: [0], payload: released as any }],
          true,
        );
      }

      results.push({ path: repoPath, ok: true });
    }
    return results;
  }

  // --- locks ---
  server.addTool({
    name: "locks_acquire",
    description:
      "Acquire best-effort locks for repo paths (soft/hard with TTL).",
    parameters: LocksAcquireParams,
    execute: async (args) => {
      const expiresAt = nowMs() + args.ttl_seconds * 1000;
      const results: Array<
        {
          path: string;
          ok: boolean;
          reason?: string;
          held_by?: string;
          expires_at?: number;
          blocking_lock?: {
            path: string;
            agent_id: string;
            mode: "soft" | "hard";
            expires_at: number;
          };
          last_activity?: z.infer<typeof ActivityEventSchema> | null;
        }
      > = [];

      const now = nowMs();
      // Keep this conservative; locks should be few. This lets us match legacy
      // absolute-path locks and normalize cross-worktree.
      const activeAll = await qdrant.scroll(collections.locks, {
        limit: 500,
        filter: {
          must: [{ key: "expires_at", range: { gte: now } }],
        },
        with_payload: true,
        with_vectors: false,
      });

      const activeLocksAll = activeAll.map((p) => p.payload).filter(Boolean)
        .map(
          (p: any) => LockSchema.safeParse(p),
        ).filter((r) => r.success).map((r: any) =>
          r.data as z.infer<
            typeof LockSchema
          >
        );

      const activityCache = new Map<
        string,
        z.infer<typeof ActivityEventSchema> | null
      >();

      for (const rawPath of args.paths) {
        const repoPath = normalizeRepoPath(rawPath, repoRootsOrNull);
        const activeLocks = activeLocksAll.filter((l) =>
          normalizeRepoPath(l.path, repoRootsOrNull) === repoPath
        );

        const blocking = activeLocks.find((l) =>
          l.agent_id !== args.agent_id && l.mode === "hard"
        );
        if (args.mode === "hard" && blocking) {
          let lastActivity = activityCache.get(blocking.agent_id);
          if (!activityCache.has(blocking.agent_id)) {
            lastActivity = await latestActivityForAgent(blocking.agent_id);
            activityCache.set(blocking.agent_id, lastActivity ?? null);
          }
          results.push({
            path: repoPath,
            ok: false,
            reason: "hard_locked",
            held_by: blocking.agent_id,
            expires_at: blocking.expires_at,
            blocking_lock: {
              path: normalizeRepoPath(blocking.path, repoRootsOrNull),
              agent_id: blocking.agent_id,
              mode: blocking.mode,
              expires_at: blocking.expires_at,
            },
            last_activity: lastActivity ?? null,
          });
          continue;
        }

        const id = await stableUuid(`lock:${repoPath}:${args.agent_id}`);
        const lock = LockSchema.parse({
          path: repoPath,
          agent_id: args.agent_id,
          mode: args.mode,
          expires_at: expiresAt,
        });
        await qdrant.upsert(
          collections.locks,
          [{ id, vector: [0], payload: lock as any }],
          true,
        );
        results.push({ path: repoPath, ok: true, expires_at: expiresAt });
      }

      await qdrant.upsert(collections.activity, [{
        id: crypto.randomUUID(),
        vector: [0],
        payload: {
          event_id: crypto.randomUUID(),
          ts: nowMs(),
          type: "locks_acquire",
          message: `${args.agent_id} acquired ${args.mode} locks`,
          related_paths: normalizePaths(args.paths, repoRootsOrNull),
          agent_id: args.agent_id,
        },
      }], true).catch(() => {});

      return ok({ results });
    },
  });

  server.addTool({
    name: "locks_release",
    description: "Release locks held by an agent for given paths.",
    parameters: LocksReleaseParams,
    execute: async (args) => {
      const results = await releaseLocks(args.paths, args.agent_id);
      return ok({ results });
    },
  });

  server.addTool({
    name: "locks_release_all",
    description: "Release all locks held by an agent (optionally by prefix).",
    parameters: LocksReleaseAllParams,
    execute: async (args) => {
      const limit = args.limit ?? 500;
      const now = nowMs();
      const points = await qdrant.scroll(collections.locks, {
        limit,
        filter: {
          must: [
            { key: "agent_id", match: { value: args.agent_id } },
            { key: "expires_at", range: { gte: now } },
          ],
        },
        with_payload: true,
        with_vectors: false,
      });
      const prefix = args.path_prefix
        ? normalizeRepoPath(args.path_prefix, repoRootsOrNull)
        : null;
      const paths = points.map((p) => p.payload).filter(Boolean).map((p: any) =>
        typeof p.path === "string"
          ? normalizeRepoPath(p.path, repoRootsOrNull)
          : null
      ).filter((p: string | null): p is string =>
        !!p && (prefix ? p.startsWith(prefix) : true)
      );

      if (!paths.length) {
        return ok({ ok: true, released: 0, results: [] });
      }
      const results = await releaseLocks(paths, args.agent_id);
      return ok({ ok: true, released: results.length, results });
    },
  });

  server.addTool({
    name: "locks_list",
    description:
      "List non-expired locks (optionally filtered by path prefix via client-side filtering).",
    parameters: LocksListParams,
    execute: async (args) => {
      const points = await qdrant.scroll(collections.locks, {
        limit: args.limit,
        with_payload: true,
        with_vectors: false,
      });
      const locks = points.map((p) => p.payload).filter(Boolean).map((p: any) =>
        LockSchema.safeParse(p)
      ).filter((r) => r.success).map((r: any) => r.data)
        .filter((l: any) => l.expires_at > nowMs())
        .map((l: any) => ({
          ...l,
          path: normalizeRepoPath(l.path, repoRootsOrNull),
        }));
      return ok({ locks });
    },
  });

  // --- memory (derived) ---
  server.addTool({
    name: "memory_upsert_chunks",
    description:
      "Upsert derived repo/doc chunks (intended for indexers, not workers).",
    parameters: MemoryUpsertChunksParams,
    execute: async (args) => {
      const points = [];
      for (const c of args.chunks) {
        const normalizedChunk = {
          ...c,
          path: normalizeRepoPath(c.path, repoRootsOrNull),
        };
        const vec = await embedDocument(
          config.ollamaUrl,
          config.ollamaModel,
          normalizedChunk.text,
        );
        const id = await stableUuid(`repo_chunk:${normalizedChunk.chunk_id}`);
        points.push({
          id,
          vector: vec.vector,
          payload: normalizedChunk as any,
        });
      }
      await qdrant.upsert(collections.repoChunks, points, true);
      return ok({ ok: true, upserted: points.length });
    },
  });

  server.addTool({
    name: "memory_search",
    description:
      "Semantic search over derived repo/doc chunks (non-authoritative).",
    parameters: MemorySearchParams,
    execute: async (args) => {
      const includeProvenance = args.include_provenance ?? false;
      const q = await embedQuery(
        config.ollamaUrl,
        config.ollamaModel,
        args.query,
      );
      const must: any[] = [];
      if (args.kind) must.push({ key: "kind", match: { value: args.kind } });
      if (args.path) {
        const normalizedPath = normalizeRepoPath(args.path, repoRootsOrNull);
        must.push({ key: "path", match: { value: normalizedPath } });
      }
      const hits = await qdrant.search(
        collections.repoChunks,
        q.vector,
        args.k,
        must.length ? { must } : undefined,
        true,
      );
      const results = hits.map((h: any) => ({
        score: h.score,
        chunk: h?.payload && typeof h.payload === "object"
          ? normalizeChunkPayload(
            h.payload,
            repoRootsOrNull,
            includeProvenance,
          )
          : h.payload,
      }));
      return ok({ results });
    },
  });

  server.addTool({
    name: "memory_search_in_file",
    description: "Semantic search within a specific file path.",
    parameters: MemorySearchInFileParams,
    execute: async (args) => {
      const normalizedPath = normalizeRepoPath(args.path, repoRootsOrNull);
      const includeProvenance = args.include_provenance ?? false;
      const q = await embedQuery(
        config.ollamaUrl,
        config.ollamaModel,
        args.query,
      );
      const hits = await qdrant.search(
        collections.repoChunks,
        q.vector,
        args.k,
        { must: [{ key: "path", match: { value: normalizedPath } }] },
        true,
      );
      const results = hits.map((h: any) => ({
        score: h.score,
        chunk: h?.payload && typeof h.payload === "object"
          ? normalizeChunkPayload(
            h.payload,
            repoRootsOrNull,
            includeProvenance,
          )
          : h.payload,
      }));
      return ok({ results });
    },
  });

  server.addTool({
    name: "memory_get_file_context",
    description:
      "Retrieve chunks for a specific file path (optionally ranked by a query).",
    parameters: MemoryGetFileContextParams,
    execute: async (args) => {
      const normalizedPath = normalizeRepoPath(args.path, repoRootsOrNull);
      const includeProvenance = args.include_provenance ?? false;
      if (args.query) {
        const q = await embedQuery(
          config.ollamaUrl,
          config.ollamaModel,
          args.query,
        );
        const hits = await qdrant.search(
          collections.repoChunks,
          q.vector,
          args.k,
          { must: [{ key: "path", match: { value: normalizedPath } }] },
          true,
        );
        return ok({
          results: hits.map((h: any) => ({
            score: h.score,
            chunk: h?.payload && typeof h.payload === "object"
              ? normalizeChunkPayload(
                h.payload,
                repoRootsOrNull,
                includeProvenance,
              )
              : h.payload,
          })),
        });
      }
      const points = await qdrant.scroll(collections.repoChunks, {
        limit: args.k,
        filter: { must: [{ key: "path", match: { value: normalizedPath } }] },
        with_payload: true,
        with_vectors: false,
      });
      const results = points.map((p) => p.payload).map((payload: any) =>
        payload && typeof payload === "object"
          ? normalizeChunkPayload(payload, repoRootsOrNull, includeProvenance)
          : payload
      );
      return ok({ results });
    },
  });

  const envTransport = (Deno.env.get("PREFRONTAL_TRANSPORT") ?? "auto")
    .toLowerCase();
  const transport = (opts?.transport ?? (envTransport as TransportMode)) ??
    "auto";
  const useStdio = transport === "stdio" ||
    (transport === "auto" && !Deno.stdin.isTerminal());

  if (useStdio) {
    await server.start({ transportType: "stdio" } as any);
    return;
  }

  await server.start({
    transportType: "httpStream",
    httpStream: {
      host: config.host,
      port: config.port,
      endpoint: config.endpoint,
      stateless: false,
    },
  } as any);
}
