import { load } from "@std/dotenv";
import * as path from "@std/path";
import { z } from "@zod/zod";

export type AppConfig = {
  host: string;
  port: number;
  endpoint: string;
  qdrantUrl: string;
  qdrantApiKey: string | null;
  qdrantPrefix: string;
  ollamaUrl: string;
  ollamaModel: string;
};

const ConfigSchema = z.object({
  host: z.string().default("127.0.0.1"),
  port: z.coerce.number().int().min(1).max(65535).default(8787),
  endpoint: z.string().default("/mcp"),
  qdrantUrl: z.string().default("http://127.0.0.1:6333"),
  qdrantApiKey: z.string().optional(),
  qdrantPrefix: z.string().optional(),
  ollamaUrl: z.string().default("http://127.0.0.1:11434"),
  ollamaModel: z.string().default("mxbai-embed-large"),
});

function cleanEnv(v: string | undefined | null): string | null {
  const t = (v ?? "").trim();
  return t.length ? t : null;
}

async function runGit(
  cwd: string,
  args: string[],
): Promise<{ ok: true; stdout: string } | { ok: false }> {
  try {
    const cmd = new Deno.Command("git", {
      cwd,
      args,
      stdin: "null",
      stdout: "piped",
      stderr: "null",
    });
    const out = await cmd.output();
    if (!out.success) return { ok: false };
    return { ok: true, stdout: new TextDecoder().decode(out.stdout).trim() };
  } catch {
    return { ok: false };
  }
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("");
}

function slugify(input: string): string {
  return input.toLowerCase().replaceAll(/[^a-z0-9]+/g, "_").replaceAll(
    /^_+|_+$/g,
    "",
  ) || "repo";
}

async function deriveQdrantPrefixFromGit(cwd: string): Promise<string | null> {
  const top = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
  const common = await runGit(cwd, ["rev-parse", "--git-common-dir"]);
  if (!top.ok || !common.ok) return null;

  const topLevel = path.resolve(cwd, top.stdout);
  const commonDir = path.isAbsolute(common.stdout)
    ? common.stdout
    : path.resolve(cwd, common.stdout);
  const commonAbs = path.normalize(commonDir);

  const repoName = slugify(path.basename(topLevel));
  const hash = (await sha256Hex(commonAbs)).slice(0, 12);
  return `prefrontal_${repoName}_${hash}`;
}

export async function loadConfig(): Promise<AppConfig> {
  const env = await load({ export: true });

  const explicitProjectId = cleanEnv(
    Deno.env.get("PREFRONTAL_PROJECT_ID") ?? env.PREFRONTAL_PROJECT_ID,
  );
  const explicitQdrantPrefix = cleanEnv(
    Deno.env.get("QDRANT_PREFIX") ?? env.QDRANT_PREFIX,
  );
  const derivedPrefix = await deriveQdrantPrefixFromGit(Deno.cwd());

  const cfg = ConfigSchema.parse({
    host: Deno.env.get("PREFRONTAL_HOST") ?? env.PREFRONTAL_HOST,
    port: Deno.env.get("PREFRONTAL_PORT") ?? env.PREFRONTAL_PORT,
    endpoint: Deno.env.get("PREFRONTAL_ENDPOINT") ?? env.PREFRONTAL_ENDPOINT,
    qdrantUrl: Deno.env.get("QDRANT_URL") ?? env.QDRANT_URL,
    qdrantApiKey: Deno.env.get("QDRANT_API_KEY") ?? env.QDRANT_API_KEY,
    qdrantPrefix: explicitProjectId ?? explicitQdrantPrefix ?? derivedPrefix,
    ollamaUrl: Deno.env.get("OLLAMA_URL") ?? env.OLLAMA_URL,
    ollamaModel: Deno.env.get("OLLAMA_MODEL") ?? env.OLLAMA_MODEL,
  });

  return {
    host: cfg.host,
    port: cfg.port,
    endpoint: cfg.endpoint.startsWith("/") ? cfg.endpoint : `/${cfg.endpoint}`,
    qdrantUrl: cfg.qdrantUrl.replace(/\/+$/, ""),
    qdrantApiKey: (cfg.qdrantApiKey ?? "").trim()
      ? (cfg.qdrantApiKey ?? "").trim()
      : null,
    qdrantPrefix: cfg.qdrantPrefix ?? "prefrontal",
    ollamaUrl: cfg.ollamaUrl.replace(/\/+$/, ""),
    ollamaModel: cfg.ollamaModel,
  };
}
