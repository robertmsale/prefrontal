import { load } from "@std/dotenv";
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
  qdrantPrefix: z.string().default("prefrontal"),
  ollamaUrl: z.string().default("http://127.0.0.1:11434"),
  ollamaModel: z.string().default("mxbai-embed-large"),
});

export async function loadConfig(): Promise<AppConfig> {
  const env = await load({ export: true });

  const cfg = ConfigSchema.parse({
    host: Deno.env.get("PREFRONTAL_HOST") ?? env.PREFRONTAL_HOST,
    port: Deno.env.get("PREFRONTAL_PORT") ?? env.PREFRONTAL_PORT,
    endpoint: Deno.env.get("PREFRONTAL_ENDPOINT") ?? env.PREFRONTAL_ENDPOINT,
    qdrantUrl: Deno.env.get("QDRANT_URL") ?? env.QDRANT_URL,
    qdrantApiKey: Deno.env.get("QDRANT_API_KEY") ?? env.QDRANT_API_KEY,
    qdrantPrefix: Deno.env.get("QDRANT_PREFIX") ?? env.QDRANT_PREFIX,
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
    qdrantPrefix: cfg.qdrantPrefix,
    ollamaUrl: cfg.ollamaUrl.replace(/\/+$/, ""),
    ollamaModel: cfg.ollamaModel,
  };
}
