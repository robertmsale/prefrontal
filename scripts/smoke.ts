import { load } from "@std/dotenv";

type CountResult = { count: number };

const env = await load({ export: true });

const qdrantUrl =
  (Deno.env.get("QDRANT_URL") ?? env.QDRANT_URL ?? "http://127.0.0.1:6333")
    .replace(
      /\/+$/,
      "",
    );
const qdrantPrefix = Deno.env.get("QDRANT_PREFIX") ?? env.QDRANT_PREFIX ??
  "prefrontal";

const collections = {
  tasks: `${qdrantPrefix}_tasks`,
  locks: `${qdrantPrefix}_locks`,
  activity: `${qdrantPrefix}_activity`,
  repoChunks: `${qdrantPrefix}_repo_chunks`,
};

async function run(
  cmd: string,
  args: string[],
  opts?: { cwd?: string; env?: Record<string, string> },
) {
  const out = await new Deno.Command(cmd, {
    args,
    cwd: opts?.cwd,
    env: opts?.env,
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (!out.success) throw new Error(`Command failed: ${cmd} ${args.join(" ")}`);
}

async function runCapture(
  cmd: string,
  args: string[],
  opts?: { cwd?: string; env?: Record<string, string> },
) {
  const out = await new Deno.Command(cmd, {
    args,
    cwd: opts?.cwd,
    env: opts?.env,
    stdout: "piped",
    stderr: "inherit",
  }).output();
  if (!out.success) throw new Error(`Command failed: ${cmd} ${args.join(" ")}`);
  return new TextDecoder().decode(out.stdout);
}

async function fetchJson(url: string, init?: RequestInit): Promise<any> {
  const res = await fetch(url, init);
  const txt = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(
      `HTTP ${res.status} ${res.statusText}${txt ? `\n${txt}` : ""}`,
    );
  }
  return txt ? JSON.parse(txt) : null;
}

async function countPoints(collection: string): Promise<number> {
  const base = `${qdrantUrl}/collections/${
    encodeURIComponent(collection)
  }/points/count`;
  try {
    const out = await fetchJson(base, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ exact: true }),
    });
    return (out?.result?.count ?? out?.count ?? 0) as number;
  } catch {
    const out = await fetchJson(base, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ exact: true, filter: { must: [] } }),
    });
    return (out?.result?.count ?? out?.count ?? 0) as number;
  }
}

async function sampleVectorDim(collection: string): Promise<number> {
  const out = await fetchJson(
    `${qdrantUrl}/collections/${encodeURIComponent(collection)}/points/scroll`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        limit: 1,
        with_payload: false,
        with_vectors: true,
      }),
    },
  );
  const points = out?.result?.points ?? out?.points ?? [];
  if (!points.length) return 0;
  const v = points[0]?.vector;
  if (Array.isArray(v)) return v.length;
  return 0;
}

async function ensureTooling() {
  await run("deno", ["task", "ensure:ollama"]);
  await run("docker", ["compose", "up", "-d", "qdrant"]);
  await run("deno", ["task", "ensure:qdrant"]);
  await run("deno", ["task", "check"]);

  const codexPath = await runCapture("bash", [
    "-lc",
    "command -v codex || true",
  ]);
  if (!codexPath.trim()) {
    throw new Error(
      "codex CLI not found in PATH; required for `deno task smoke`.",
    );
  }
}

async function codexExec(prompt: string) {
  await run("codex", [
    "exec",
    "-c",
    'mcp_servers.prefrontal.command="deno"',
    "-c",
    'mcp_servers.prefrontal.args=["task","dev"]',
    prompt,
  ]);
}

function promptHappyPath(runId: string) {
  return [
    "You have access to MCP tools from server 'prefrontal'.",
    "Goal: prove tool usability by exercising tasks, locks, activity, and memory.",
    "",
    "Do these steps STRICTLY by calling the named tools (no placeholders):",
    `1) tasks_create with title 'smoke-${runId}', description 'smoke test', related_paths ['docs/FACTS.md','src/server.ts']`,
    "2) tasks_list_active and confirm the created task appears",
    "3) tasks_claim that task_id with agent_id 'smoke-agent-1', lease_seconds 120",
    "4) tasks_update with progress_note 'implemented smoke tool calls'",
    "5) locks_acquire with paths ['docs/FACTS.md'], agent_id 'smoke-agent-1', ttl_seconds 120, mode 'soft'",
    "6) activity_post with type 'smoke', message including the runId, related_paths ['docs/FACTS.md']",
    `7) memory_upsert_chunks with a single chunk_id 'smoke-chunk-${runId}', kind 'facts', path 'docs/FACTS.md', authority 2, text 'smoke memory chunk ${runId}'`,
    `8) memory_search query '${runId}' k 5 and report how many results you got`,
    "9) locks_release paths ['docs/FACTS.md'] agent_id 'smoke-agent-1'",
    "10) tasks_complete for that task_id",
    "",
    "Finish by printing a single JSON object with keys: task_id, chunk_id, memory_results_count.",
  ].join("\n");
}

function promptConflicts(runId: string) {
  return [
    "You have access to MCP tools from server 'prefrontal'.",
    "Goal: exercise conflict scenarios (task claim + hard lock).",
    "",
    "Do these steps STRICTLY by calling the named tools:",
    `1) tasks_create with title 'smoke-conflict-${runId}', description 'conflict test', related_paths ['docs/FACTS.md']`,
    "2) tasks_claim with agent_id 'smoke-agent-A', lease_seconds 120 (expect ok: true)",
    "3) tasks_claim again for same task_id with agent_id 'smoke-agent-B', lease_seconds 120 (expect ok: false/conflict: true)",
    "4) locks_acquire with paths ['docs/FACTS.md'], agent_id 'smoke-agent-A', ttl_seconds 120, mode 'hard' (expect ok: true)",
    "5) locks_acquire with same paths, agent_id 'smoke-agent-B', ttl_seconds 120, mode 'hard' (expect ok: false for that path)",
    "6) activity_post type 'smoke_conflict' message including runId",
    "",
    "Finish by printing a single JSON object with keys: task_id, claim_conflict_ok (boolean), hard_lock_conflict_ok (boolean).",
  ].join("\n");
}

function promptMemoryOnly(runId: string) {
  return [
    "You have access to MCP tools from server 'prefrontal'.",
    "Goal: ensure memory tooling works.",
    "",
    "Do these steps STRICTLY by calling the named tools:",
    `1) memory_upsert_chunks with a single chunk_id 'smoke-chunk-${runId}', kind 'facts', path 'docs/FACTS.md', authority 2, text 'smoke memory chunk ${runId}'`,
    `2) memory_search query '${runId}' k 5 and report how many results you got`,
    "",
    "Finish by printing a single JSON object with keys: chunk_id, memory_results_count.",
  ].join("\n");
}

async function main() {
  const runId = crypto.randomUUID().slice(0, 8);
  console.log(`Running smoke suite: ${runId}`);

  await ensureTooling();

  await codexExec(promptHappyPath(runId));
  await codexExec(promptConflicts(runId));

  const tasksCount = await countPoints(collections.tasks);
  const locksCount = await countPoints(collections.locks);
  const activityCount = await countPoints(collections.activity);
  let repoChunksCount = await countPoints(collections.repoChunks);

  if (repoChunksCount < 1) {
    await codexExec(promptMemoryOnly(runId));
    repoChunksCount = await countPoints(collections.repoChunks);
  }

  const tasksDim = await sampleVectorDim(collections.tasks);
  const repoChunksDim = await sampleVectorDim(collections.repoChunks);

  // Heuristic assertions: agent tool usage should create at least one task, activity event, and memory chunk.
  if (tasksCount < 1) {
    throw new Error(`Expected tasks count >= 1, got ${tasksCount}`);
  }
  if (activityCount < 1) {
    throw new Error(`Expected activity count >= 1, got ${activityCount}`);
  }
  if (repoChunksCount < 1) {
    throw new Error(`Expected repo_chunks count >= 1, got ${repoChunksCount}`);
  }

  // Confirm embeddings are being stored (vector length should be 1024).
  if (tasksDim !== 1024) {
    throw new Error(`Expected tasks vector dim 1024, got ${tasksDim}`);
  }
  if (repoChunksDim !== 1024) {
    throw new Error(
      `Expected repo_chunks vector dim 1024, got ${repoChunksDim}`,
    );
  }

  console.log("Smoke OK");
  console.log(
    JSON.stringify(
      {
        qdrantUrl,
        collections,
        counts: {
          tasks: tasksCount,
          locks: locksCount,
          activity: activityCount,
          repo_chunks: repoChunksCount,
        },
        vector_dims: { tasks: tasksDim, repo_chunks: repoChunksDim },
      },
      null,
      2,
    ),
  );
}

await main();
