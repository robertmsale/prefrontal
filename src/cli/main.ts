import { loadConfig } from "../config.ts";
import { startPrefrontalMcpServer } from "../mcp.ts";
import { runTui } from "../tui/main.ts";
import { Client } from "npm:@modelcontextprotocol/sdk@1.25.1/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "npm:@modelcontextprotocol/sdk@1.25.1/client/stdio.js";

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

async function commandExists(command: string): Promise<boolean> {
  try {
    const p = new Deno.Command("bash", {
      args: ["-lc", `command -v ${command} >/dev/null 2>&1`],
      stdin: "null",
      stdout: "null",
      stderr: "null",
    });
    const o = await p.output();
    return o.success;
  } catch {
    return false;
  }
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

function parseFlags(args: string[]) {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (const a of args) {
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    if (eq !== -1) {
      flags[a.slice(2, eq)] = a.slice(eq + 1);
    } else {
      flags[a.slice(2)] = "true";
    }
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
      "",
      "Env overrides:",
      "  PREFRONTAL_PROJECT_ID / QDRANT_PREFIX  (project scoping)",
      "  QDRANT_URL / OLLAMA_URL / OLLAMA_MODEL (backends)",
      "  PREFRONTAL_MCP_COMMAND / PREFRONTAL_MCP_ARGS (CLI client launcher)",
    ].join("\n"),
  );
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

async function detectMcpLauncher(): Promise<Launcher> {
  const cmd = cleanEnv(Deno.env.get("PREFRONTAL_MCP_COMMAND"));
  const argsRaw = cleanEnv(Deno.env.get("PREFRONTAL_MCP_ARGS"));
  const parsedArgs = argsRaw ? tryParseJsonArray(argsRaw) : null;
  if (cmd) {
    return { command: cmd, args: parsedArgs ?? ["mcp", "--transport=stdio"] };
  }

  if (await commandExists("prefrontal")) {
    return { command: "prefrontal", args: ["mcp", "--transport=stdio"] };
  }

  // Repo-local fallback (useful when running from the prefrontal repo without installing).
  return { command: "deno", args: ["task", "dev"] };
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

  err(`Unknown command: ${command}`);
  usage();
  Deno.exit(2);
}

if (import.meta.main) {
  await main(Deno.args);
}
