import { loadConfig } from "../config.ts";
import { startPrefrontalMcpServer } from "../mcp.ts";
import { runTui } from "../tui/main.ts";
import { Client } from "npm:@modelcontextprotocol/sdk@1.25.1/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "npm:@modelcontextprotocol/sdk@1.25.1/client/stdio.js";
import { fromFileUrl, join } from "@std/path";

type TransportMode = "auto" | "stdio" | "http";

type Launcher = { command: string; args: string[] };

const enc = new TextEncoder();

function out(line: string) {
  Deno.stdout.writeSync(enc.encode(line.endsWith("\n") ? line : line + "\n"));
}

function err(line: string) {
  Deno.stderr.writeSync(enc.encode(line.endsWith("\n") ? line : line + "\n"));
}

function cleanEnv(v: string | undefined | null): string | null {
  const t = (v ?? "").trim();
  return t.length ? t : null;
}

async function findExecutableInPath(command: string): Promise<string | null> {
  const envPath = Deno.env.get("PATH") ?? "";
  const delimiter = Deno.build.os === "windows" ? ";" : ":";
  for (const dir of envPath.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, command);
    try {
      const stat = await Deno.stat(candidate);
      if (stat.isFile) return candidate;
    } catch {
      // ignore
    }
  }
  return null;
}

function tryParseJsonArray(value: string): string[] | null {
  try {
    const v = JSON.parse(value);
    if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v;
    return null;
  } catch {
    return null;
  }
}

function parseStatusList(value: string | undefined): string[] | null {
  if (!value) return null;
  const json = tryParseJsonArray(value);
  if (json) return json;
  const items = value.split(",").map((s) => s.trim()).filter(Boolean);
  return items.length ? items : null;
}

function parseFlags(args: string[]) {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  let stopParsing = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (stopParsing) {
      positional.push(a);
      continue;
    }
    if (a === "--") {
      stopParsing = true;
      continue;
    }
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    if (eq !== -1) {
      flags[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const key = a.slice(2);
    const next = args[i + 1];
    if (typeof next === "string" && !next.startsWith("--")) {
      flags[key] = next;
      i++;
      continue;
    }
    flags[key] = "true";
  }
  return { flags, positional };
}

function usage() {
  out(
    [
      "prefrontal <command> [args]",
      "",
      "Commands:",
      "  prefrontal tui",
      "  prefrontal mcp [--transport=stdio|http|auto]",
      "  prefrontal stats",
      "  prefrontal memories search <query> [--k=10] [--kind=...] [--path=...]",
      "  prefrontal memories file <path> [--query=...] [--k=10]",
      "  prefrontal tasks list-active [--limit=100] [--status-in=open,claimed,in_progress,blocked]",
      "  prefrontal activity digest [--limit=50] [--since-cursor=...] [--direction=asc|desc] [--type=...] [--path-prefix=...]",
      "  prefrontal locks list [--limit=200]",
      "  prefrontal locks release <path...> --agent-id=...",
      "  prefrontal locks clear --agent-id=... [--path-prefix=...] [--limit=500]",
      "  prefrontal locks release-changed --agent-id=... [--base=HEAD~1] [--head=HEAD]",
      "",
      "Env overrides:",
      "  PREFRONTAL_PROJECT_ID / QDRANT_PREFIX  (project scoping)",
      "  QDRANT_URL / OLLAMA_URL / OLLAMA_MODEL (backends)",
      "  PREFRONTAL_MCP_COMMAND / PREFRONTAL_MCP_ARGS (CLI client launcher)",
    ].join("\n"),
  );
}

async function gitNamesChanged(base: string, head: string): Promise<string[]> {
  const p = new Deno.Command("git", {
    args: ["diff", "--name-only", `${base}..${head}`],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  });
  const o = await p.output();
  if (!o.success) {
    const msg = new TextDecoder().decode(o.stderr).trim();
    throw new Error(`git diff failed: ${msg || `exit ${o.code}`}`);
  }
  const txt = new TextDecoder().decode(o.stdout);
  return txt.split("\n").map((s) => s.trim()).filter(Boolean);
}

async function ensureQdrantReachable(qdrantUrl: string) {
  const base = qdrantUrl.replace(/\/+$/, "");
  for (let attempt = 1; attempt <= 30; attempt++) {
    try {
      const res = await fetch(`${base}/collections`, {
        headers: { accept: "application/json" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return;
    } catch (e) {
      if (attempt === 30) throw e;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

async function ensureOllamaModel(ollamaUrl: string, model: string) {
  const base = ollamaUrl.replace(/\/+$/, "");
  const tagsRes = await fetch(`${base}/api/tags`, {
    headers: { accept: "application/json" },
  });
  if (!tagsRes.ok) {
    const body = await tagsRes.text().catch(() => "");
    throw new Error(
      `Ollama not reachable at ${base}: ${tagsRes.status} ${tagsRes.statusText}${
        body ? `\n${body}` : ""
      }`,
    );
  }
  const tags = await tagsRes.json().catch(() => ({}));
  const models: Array<{ name?: string; model?: string }> = Array.isArray(
      (tags as any)?.models,
    )
    ? (tags as any).models
    : [];
  const present = models.some((m) =>
    (m.name ?? m.model ?? "").startsWith(`${model}:`) ||
    (m.name ?? m.model) === model
  );
  if (present) return;

  const pull = new Deno.Command("ollama", {
    args: ["pull", model],
    stdout: "inherit",
    stderr: "inherit",
  });
  const outp = await pull.output();
  if (!outp.success) {
    throw new Error(`Failed to pull Ollama model '${model}'`);
  }
}

function selfModulePaths() {
  const rootUrl = new URL("../../", import.meta.url);
  return {
    configPath: fromFileUrl(new URL("deno.json", rootUrl)),
    cliPath: fromFileUrl(new URL("src/cli/main.ts", rootUrl)),
  };
}

async function detectMcpLauncher(): Promise<Launcher> {
  const cmd = cleanEnv(Deno.env.get("PREFRONTAL_MCP_COMMAND"));
  const argsRaw = cleanEnv(Deno.env.get("PREFRONTAL_MCP_ARGS"));
  const parsedArgs = argsRaw ? tryParseJsonArray(argsRaw) : null;
  if (cmd) {
    return { command: cmd, args: parsedArgs ?? ["mcp", "--transport=stdio"] };
  }

  const prefrontalPath = await findExecutableInPath("prefrontal");
  if (prefrontalPath) {
    return { command: prefrontalPath, args: ["mcp", "--transport=stdio"] };
  }

  const { configPath, cliPath } = selfModulePaths();
  return {
    command: Deno.execPath(),
    args: ["run", "-A", "-c", configPath, cliPath, "mcp", "--transport=stdio"],
  };
}

async function withMcpClient<T>(
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const launcher = await detectMcpLauncher();
  const client = new Client({ name: "prefrontal-cli", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: launcher.command,
    args: launcher.args,
    cwd: Deno.cwd(),
    env: {
      ...getDefaultEnvironment(),
      ...Deno.env.toObject(),
      PREFRONTAL_TRANSPORT: "stdio",
    },
    stderr: "inherit",
  });
  await client.connect(transport as any);
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

function firstTextContent(result: any): string | null {
  const content = result?.content;
  if (!Array.isArray(content)) return null;
  for (const c of content) {
    if (c?.type === "text" && typeof c?.text === "string") return c.text;
  }
  return null;
}

function parseToolJson<T>(result: any): T {
  const txt = firstTextContent(result);
  if (!txt) throw new Error("Tool did not return text content");
  return JSON.parse(txt) as T;
}

async function cmdStats() {
  const data = await withMcpClient(async (client) => {
    const res = await client.callTool({
      name: "stats_get",
      arguments: { include_paths: true, max_points: null, sample_paths: 20 },
    });
    return parseToolJson<any>(res);
  });
  out(JSON.stringify(data, null, 2));
}

async function cmdMemoriesSearch(query: string, flags: Record<string, string>) {
  const k = Number(flags.k ?? "10");
  const kind = flags.kind ?? null;
  const path = flags.path ?? null;
  const data = await withMcpClient(async (client) => {
    const res = await client.callTool({
      name: "memory_search",
      arguments: { query, kind, path, k },
    });
    return parseToolJson<any>(res);
  });
  out(JSON.stringify(data, null, 2));
}

async function cmdMemoriesFile(pathArg: string, flags: Record<string, string>) {
  const k = Number(flags.k ?? "10");
  const query = flags.query ?? null;
  const data = await withMcpClient(async (client) => {
    const res = await client.callTool({
      name: "memory_get_file_context",
      arguments: { path: pathArg, query, k },
    });
    return parseToolJson<any>(res);
  });
  out(JSON.stringify(data, null, 2));
}

async function cmdTasksListActive(flags: Record<string, string>) {
  const limit = Number(flags.limit ?? "100");
  const statusRaw = flags["status-in"] ?? flags.status_in;
  const statusIn = parseStatusList(statusRaw ?? undefined);
  const data = await withMcpClient(async (client) => {
    const res = await client.callTool({
      name: "tasks_list_active",
      arguments: { status_in: statusIn ?? null, limit },
    });
    return parseToolJson<any>(res);
  });
  out(JSON.stringify(data, null, 2));
}

async function cmdActivityDigest(flags: Record<string, string>) {
  const limit = Number(flags.limit ?? "50");
  const sinceRaw = flags["since-cursor"] ?? flags.since_cursor ?? null;
  const sinceCursor = sinceRaw === null ? null : Number(sinceRaw);
  const direction = flags.direction ? flags.direction.toLowerCase() : null;
  const type = flags.type ?? null;
  const pathPrefix = flags["path-prefix"] ?? flags.path_prefix ?? null;
  if (direction && !["asc", "desc"].includes(direction)) {
    err("Invalid --direction (use asc|desc).");
    Deno.exit(2);
  }
  const data = await withMcpClient(async (client) => {
    const res = await client.callTool({
      name: "activity_digest",
      arguments: {
        since_cursor: Number.isFinite(sinceCursor) ? sinceCursor : null,
        direction,
        type,
        related_path_prefix: pathPrefix,
        limit,
      },
    });
    return parseToolJson<any>(res);
  });
  out(JSON.stringify(data, null, 2));
}

async function cmdLocksList(flags: Record<string, string>) {
  const limit = Number(flags.limit ?? "200");
  const data = await withMcpClient(async (client) => {
    const res = await client.callTool({
      name: "locks_list",
      arguments: { limit },
    });
    return parseToolJson<any>(res);
  });
  out(JSON.stringify(data, null, 2));
}

async function cmdLocksRelease(paths: string[], agentId: string) {
  if (!paths.length) return;
  const data = await withMcpClient(async (client) => {
    const res = await client.callTool({
      name: "locks_release",
      arguments: { paths, agent_id: agentId },
    });
    return parseToolJson<any>(res);
  });
  out(JSON.stringify(data, null, 2));
}

async function cmdLocksClear(
  agentId: string,
  flags: Record<string, string>,
) {
  const limit = Number(flags.limit ?? "500");
  const prefix = flags["path-prefix"] ?? flags.path_prefix ?? null;
  const data = await withMcpClient(async (client) => {
    const res = await client.callTool({
      name: "locks_release_all",
      arguments: { agent_id: agentId, path_prefix: prefix, limit },
    });
    return parseToolJson<any>(res);
  });
  out(JSON.stringify(data, null, 2));
}

async function cmdLocksReleaseChanged(flags: Record<string, string>) {
  const agentId = cleanEnv(flags["agent-id"] ?? flags.agent_id) ??
    cleanEnv(Deno.env.get("PREFRONTAL_AGENT_ID"));
  if (!agentId) {
    err("Missing --agent-id (or set PREFRONTAL_AGENT_ID).");
    Deno.exit(2);
  }
  const base = flags.base ?? "HEAD~1";
  const head = flags.head ?? "HEAD";
  const paths = await gitNamesChanged(base, head);
  if (!paths.length) {
    out(JSON.stringify({ ok: true, released: 0 }, null, 2));
    return;
  }
  await cmdLocksRelease(paths, agentId);
}

async function cmdMcp(mode: TransportMode) {
  const cfg = await loadConfig();
  if (mode === "http") {
    await ensureQdrantReachable(cfg.qdrantUrl);
    await ensureOllamaModel(cfg.ollamaUrl, cfg.ollamaModel);
  }
  await startPrefrontalMcpServer({ transport: mode });
}

async function main(argv: string[]) {
  const [command, ...rest] = argv;
  if (!command || command === "-h" || command === "--help") {
    usage();
    return;
  }

  if (command === "tui") {
    await runTui(rest);
    return;
  }

  if (command === "mcp") {
    const { flags } = parseFlags(rest);
    const mode = (flags.transport ?? "http").toLowerCase() as TransportMode;
    if (!["auto", "stdio", "http"].includes(mode)) {
      err("Invalid --transport; use stdio|http|auto");
      Deno.exit(2);
    }
    await cmdMcp(mode);
    return;
  }

  if (command === "stats") {
    await cmdStats();
    return;
  }

  if (command === "memories") {
    const [sub, ...tail] = rest;
    if (sub === "search") {
      const { flags, positional } = parseFlags(tail);
      const q = positional.join(" ").trim();
      if (!q) {
        err("Usage: prefrontal memories search <query>");
        Deno.exit(2);
      }
      await cmdMemoriesSearch(q, flags);
      return;
    }
    if (sub === "file") {
      const { flags, positional } = parseFlags(tail);
      const p = positional[0];
      if (!p) {
        err("Usage: prefrontal memories file <path>");
        Deno.exit(2);
      }
      await cmdMemoriesFile(p, flags);
      return;
    }
    err("Unknown memories subcommand (use: search, file)");
    Deno.exit(2);
  }

  if (command === "tasks") {
    const [sub, ...tail] = rest;
    if (sub === "list-active") {
      const { flags } = parseFlags(tail);
      await cmdTasksListActive(flags);
      return;
    }
    err("Unknown tasks subcommand (use: list-active)");
    Deno.exit(2);
  }

  if (command === "activity") {
    const [sub, ...tail] = rest;
    if (sub === "digest") {
      const { flags } = parseFlags(tail);
      await cmdActivityDigest(flags);
      return;
    }
    err("Unknown activity subcommand (use: digest)");
    Deno.exit(2);
  }

  if (command === "locks") {
    const [sub, ...tail] = rest;
    if (sub === "list") {
      const { flags } = parseFlags(tail);
      await cmdLocksList(flags);
      return;
    }
    if (sub === "release") {
      const { flags, positional } = parseFlags(tail);
      const agentId = cleanEnv(flags["agent-id"] ?? flags.agent_id) ??
        cleanEnv(Deno.env.get("PREFRONTAL_AGENT_ID"));
      if (!agentId) {
        err("Missing --agent-id (or set PREFRONTAL_AGENT_ID).");
        Deno.exit(2);
      }
      if (!positional.length) {
        err("Usage: prefrontal locks release <path...> --agent-id=...");
        Deno.exit(2);
      }
      await cmdLocksRelease(positional, agentId);
      return;
    }
    if (sub === "clear") {
      const { flags } = parseFlags(tail);
      const agentId = cleanEnv(flags["agent-id"] ?? flags.agent_id) ??
        cleanEnv(Deno.env.get("PREFRONTAL_AGENT_ID"));
      if (!agentId) {
        err("Missing --agent-id (or set PREFRONTAL_AGENT_ID).");
        Deno.exit(2);
      }
      await cmdLocksClear(agentId, flags);
      return;
    }
    if (sub === "release-changed") {
      const { flags } = parseFlags(tail);
      await cmdLocksReleaseChanged(flags);
      return;
    }
    err(
      "Unknown locks subcommand (use: list, release, clear, release-changed)",
    );
    Deno.exit(2);
  }

  err(`Unknown command: ${command}`);
  usage();
  Deno.exit(2);
}

if (import.meta.main) {
  await main(Deno.args);
}
