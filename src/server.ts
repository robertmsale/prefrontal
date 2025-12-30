import { FastMCP } from "@punkpeye/fastmcp";
import { z } from "@zod/zod";
import { loadConfig } from "./config.ts";
import { embedDocument, embedQuery } from "./ollama.ts";
import { QdrantRestClient } from "./qdrant.ts";

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

const ClaimedBySchema = z.object({
  agent_id: z.string(),
  worktree: z.string().optional(),
  branch: z.string().optional(),
});

const TaskSchema = z.object({
  task_id: z.string(),
  title: z.string(),
  description: z.string(),
  status: z.enum([
    "open",
    "claimed",
    "in_progress",
    "blocked",
    "done",
    "abandoned",
  ]),
  claimed_by: ClaimedBySchema.nullable().optional(),
  related_paths: z.array(z.string()).default([]),
  base_commit: z.string().optional(),
  last_update_at: z.number().int(),
  lease_until: z.number().int().nullable().optional(),
  version: z.number().int(),
  priority: z.number().int().optional(),
  tags: z.array(z.string()).optional(),
});

const LockSchema = z.object({
  path: z.string(),
  agent_id: z.string(),
  mode: z.enum(["soft", "hard"]).default("soft"),
  expires_at: z.number().int(),
});

const ActivityEventSchema = z.object({
  event_id: z.string(),
  ts: z.number().int(),
  type: z.string(),
  message: z.string(),
  related_paths: z.array(z.string()).optional(),
  task_id: z.string().optional(),
});

const RepoChunkSchema = z.object({
  chunk_id: z.string().min(1),
  kind: z.string().min(1),
  path: z.string().min(1),
  commit: z.string().min(1).nullable(),
  authority: z.number().int().min(1).max(5).nullable(),
  content_hash: z.string().min(1).nullable(),
  chunk: z.object({
    start_line: z.number().int().nullable(),
    end_line: z.number().int().nullable(),
    byte_start: z.number().int().nullable(),
    byte_end: z.number().int().nullable(),
  }).strict().nullable(),
  text: z.string().min(1),
}).strict();

async function main() {
  const config = await loadConfig();
  const collections = qdrantCollections(config.qdrantPrefix);

  const qdrant = new QdrantRestClient(config.qdrantUrl, config.qdrantApiKey);

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
  });

  // --- activity ---
  server.addTool({
    name: "activity_post",
    description: "Append an activity event to the project digest stream.",
    parameters: z.object({
      type: z.string().min(1),
      message: z.string().min(1),
      related_paths: z.array(z.string()).nullable(),
      task_id: z.string().min(1).nullable(),
    }).strict(),
    execute: async (args) => {
      const event = ActivityEventSchema.parse({
        event_id: crypto.randomUUID(),
        ts: nowMs(),
        type: args.type,
        message: args.message,
        related_paths: args.related_paths ?? undefined,
        task_id: args.task_id ?? undefined,
      });

      await qdrant.upsert(collections.activity, [{
        id: event.event_id,
        vector: [0],
        payload: event as any,
      }], true);

      return ok(event);
    },
  });

  server.addTool({
    name: "activity_digest",
    description:
      "Get recent activity events since a cursor (milliseconds since epoch).",
    parameters: z.object({
      since_cursor: z.number().int().nullable(),
      limit: z.number().int().min(1).max(200),
    }).strict(),
    execute: async (args) => {
      const since = args.since_cursor ?? 0;
      const points = await qdrant.scroll(collections.activity, {
        limit: args.limit,
        order_by: { key: "ts", direction: "asc", start_from: since + 1 },
        with_payload: true,
        with_vectors: false,
      });

      const events = points.map((p) => p.payload).filter(Boolean).map((
        p: any,
      ) => ActivityEventSchema.parse(p));
      const nextCursor = events.length ? events[events.length - 1].ts : since;
      return ok({ events, next_cursor: nextCursor });
    },
  });

  // --- tasks ---
  server.addTool({
    name: "tasks_create",
    description: "Create a new coordination task.",
    parameters: z.object({
      title: z.string().min(1),
      description: z.string().min(1),
      related_paths: z.array(z.string()),
      priority: z.number().int().nullable(),
      tags: z.array(z.string()).nullable(),
      base_commit: z.string().min(1).nullable(),
    }).strict(),
    execute: async (args) => {
      const taskId = crypto.randomUUID();
      const taskText = `${args.title}\n${args.description}\n${
        args.related_paths.join("\n")
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
        related_paths: args.related_paths,
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
    parameters: z.object({
      status_in: z.array(
        z.enum([
          "open",
          "claimed",
          "in_progress",
          "blocked",
          "done",
          "abandoned",
        ]),
      ).nullable(),
      limit: z.number().int().min(1).max(200),
    }).strict(),
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
        TaskSchema.parse(p)
      );
      return ok({ tasks });
    },
  });

  server.addTool({
    name: "tasks_search_similar",
    description: "Semantic search for tasks that overlap with a query.",
    parameters: z.object({
      query: z.string().min(1),
      status_in: z.array(
        z.enum([
          "open",
          "claimed",
          "in_progress",
          "blocked",
          "done",
          "abandoned",
        ]),
      ).nullable(),
      k: z.number().int().min(1).max(50),
    }).strict(),
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
        task: TaskSchema.parse(h.payload),
      }));
      return ok({ results });
    },
  });

  async function getTask(taskId: string) {
    const pts = await qdrant.retrieve(collections.tasks, [taskId], true, false);
    if (!pts.length) return null;
    const payload = pts[0].payload;
    if (!payload) return null;
    return TaskSchema.parse(payload);
  }

  server.addTool({
    name: "tasks_claim",
    description:
      "Claim a task using optimistic concurrency via the task version field.",
    parameters: z.object({
      task_id: z.string().min(1),
      agent_id: z.string().min(1),
      worktree: z.string().min(1).nullable(),
      branch: z.string().min(1).nullable(),
      lease_seconds: z.number().int().min(30).max(60 * 60 * 24),
    }).strict(),
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
        return ok({ ok: false, conflict: true, reason: "version_conflict" });
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
        },
      }], true).catch(() => {});

      return ok({ ok: true });
    },
  });

  server.addTool({
    name: "tasks_update",
    description: "Update task status/progress with optimistic concurrency.",
    parameters: z.object({
      task_id: z.string().min(1),
      status: z.enum([
        "open",
        "claimed",
        "in_progress",
        "blocked",
        "done",
        "abandoned",
      ]).nullable(),
      progress_note: z.string().min(1).nullable(),
      related_paths: z.array(z.string()).nullable(),
      lease_extend_seconds: z.number().int().min(30).max(60 * 60 * 24)
        .nullable(),
    }).strict(),
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
      if (args.related_paths) patch.related_paths = args.related_paths;
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
            related_paths: after.related_paths,
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
    parameters: z.object({
      task_id: z.string().min(1),
      result_commit: z.string().min(1).nullable(),
    }).strict(),
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
          related_paths: after.related_paths,
          task_id: after.task_id,
        },
      }], true).catch(() => {});

      return ok({ ok: true });
    },
  });

  // --- locks ---
  server.addTool({
    name: "locks_acquire",
    description:
      "Acquire best-effort locks for repo paths (soft/hard with TTL).",
    parameters: z.object({
      paths: z.array(z.string()).min(1),
      agent_id: z.string().min(1),
      ttl_seconds: z.number().int().min(30).max(60 * 60 * 24),
      mode: z.enum(["soft", "hard"]),
    }).strict(),
    execute: async (args) => {
      const expiresAt = nowMs() + args.ttl_seconds * 1000;
      const results: Array<
        {
          path: string;
          ok: boolean;
          reason?: string;
          held_by?: string;
          expires_at?: number;
        }
      > = [];

      for (const path of args.paths) {
        const active = await qdrant.scroll(collections.locks, {
          limit: 200,
          filter: {
            must: [
              { key: "path", match: { value: path } },
              { key: "expires_at", range: { gte: nowMs() } },
            ],
          },
          with_payload: true,
          with_vectors: false,
        });

        const activeLocks = active.map((p) => p.payload).filter(Boolean).map(
          (p: any) => LockSchema.safeParse(p),
        ).filter((r) => r.success).map((r: any) =>
          r.data as z.infer<
            typeof LockSchema
          >
        );

        const blocking = activeLocks.find((l) =>
          l.agent_id !== args.agent_id && l.mode === "hard"
        );
        if (args.mode === "hard" && blocking) {
          results.push({
            path,
            ok: false,
            reason: "hard_locked",
            held_by: blocking.agent_id,
            expires_at: blocking.expires_at,
          });
          continue;
        }

        const id = await stableUuid(`lock:${path}:${args.agent_id}`);
        const lock = LockSchema.parse({
          path,
          agent_id: args.agent_id,
          mode: args.mode,
          expires_at: expiresAt,
        });
        await qdrant.upsert(
          collections.locks,
          [{ id, vector: [0], payload: lock as any }],
          true,
        );
        results.push({ path, ok: true, expires_at: expiresAt });
      }

      await qdrant.upsert(collections.activity, [{
        id: crypto.randomUUID(),
        vector: [0],
        payload: {
          event_id: crypto.randomUUID(),
          ts: nowMs(),
          type: "locks_acquire",
          message: `${args.agent_id} acquired ${args.mode} locks`,
          related_paths: args.paths,
        },
      }], true).catch(() => {});

      return ok({ results });
    },
  });

  server.addTool({
    name: "locks_release",
    description: "Release locks held by an agent for given paths.",
    parameters: z.object({
      paths: z.array(z.string()).min(1),
      agent_id: z.string().min(1),
    }).strict(),
    execute: async (args) => {
      const results: Array<{ path: string; ok: boolean }> = [];
      for (const path of args.paths) {
        const id = await stableUuid(`lock:${path}:${args.agent_id}`);
        const existing = await qdrant.retrieve(
          collections.locks,
          [id],
          true,
          false,
        )
          .catch(() => []);
        const cur = existing.length ? existing[0]?.payload : null;
        const parsed = cur ? LockSchema.safeParse(cur) : null;
        const held = parsed?.success ? parsed.data : null;
        if (!held) {
          results.push({ path, ok: true });
          continue;
        }
        if (held.agent_id !== args.agent_id) {
          results.push({ path, ok: false });
          continue;
        }
        const released = LockSchema.parse({
          path,
          agent_id: args.agent_id,
          mode: held.mode,
          expires_at: 0,
        });
        await qdrant.upsert(
          collections.locks,
          [{ id, vector: [0], payload: released as any }],
          true,
        );
        results.push({ path, ok: true });
      }
      return ok({ results });
    },
  });

  server.addTool({
    name: "locks_list",
    description:
      "List non-expired locks (optionally filtered by path prefix via client-side filtering).",
    parameters: z.object({
      limit: z.number().int().min(1).max(500),
    }).strict(),
    execute: async (args) => {
      const points = await qdrant.scroll(collections.locks, {
        limit: args.limit,
        with_payload: true,
        with_vectors: false,
      });
      const locks = points.map((p) => p.payload).filter(Boolean).map((p: any) =>
        LockSchema.safeParse(p)
      ).filter((r) => r.success).map((r: any) => r.data)
        .filter((l: any) => l.expires_at > nowMs());
      return ok({ locks });
    },
  });

  // --- memory (derived) ---
  server.addTool({
    name: "memory_upsert_chunks",
    description:
      "Upsert derived repo/doc chunks (intended for indexers, not workers).",
    parameters: z.object({
      chunks: z.array(RepoChunkSchema).min(1),
    }).strict(),
    execute: async (args) => {
      const points = [];
      for (const c of args.chunks) {
        const vec = await embedDocument(
          config.ollamaUrl,
          config.ollamaModel,
          c.text,
        );
        const id = await stableUuid(`repo_chunk:${c.chunk_id}`);
        points.push({ id, vector: vec.vector, payload: c as any });
      }
      await qdrant.upsert(collections.repoChunks, points, true);
      return ok({ ok: true, upserted: points.length });
    },
  });

  server.addTool({
    name: "memory_search",
    description:
      "Semantic search over derived repo/doc chunks (non-authoritative).",
    parameters: z.object({
      query: z.string().min(1),
      kind: z.string().min(1).nullable(),
      path: z.string().min(1).nullable(),
      k: z.number().int().min(1).max(50),
    }).strict(),
    execute: async (args) => {
      const q = await embedQuery(
        config.ollamaUrl,
        config.ollamaModel,
        args.query,
      );
      const must: any[] = [];
      if (args.kind) must.push({ key: "kind", match: { value: args.kind } });
      if (args.path) must.push({ key: "path", match: { value: args.path } });
      const hits = await qdrant.search(
        collections.repoChunks,
        q.vector,
        args.k,
        must.length ? { must } : undefined,
        true,
      );
      const results = hits.map((h: any) => ({
        score: h.score,
        chunk: h.payload,
      }));
      return ok({ results });
    },
  });

  server.addTool({
    name: "memory_get_file_context",
    description:
      "Retrieve chunks for a specific file path (optionally ranked by a query).",
    parameters: z.object({
      path: z.string().min(1),
      query: z.string().min(1).nullable(),
      k: z.number().int().min(1).max(50),
    }).strict(),
    execute: async (args) => {
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
          { must: [{ key: "path", match: { value: args.path } }] },
          true,
        );
        return ok({
          results: hits.map((h: any) => ({ score: h.score, chunk: h.payload })),
        });
      }
      const points = await qdrant.scroll(collections.repoChunks, {
        limit: args.k,
        filter: { must: [{ key: "path", match: { value: args.path } }] },
        with_payload: true,
        with_vectors: false,
      });
      return ok({ results: points.map((p) => p.payload) });
    },
  });

  const transport = (Deno.env.get("PREFRONTAL_TRANSPORT") ?? "auto")
    .toLowerCase();
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

await main();
