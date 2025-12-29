import { load } from "@std/dotenv";

const env = await load({ export: true });

const ollamaUrl =
  (Deno.env.get("OLLAMA_URL") ?? env.OLLAMA_URL ?? "http://127.0.0.1:11434")
    .replace(/\/+$/, "");
const model = Deno.env.get("OLLAMA_MODEL") ?? env.OLLAMA_MODEL ??
  "mxbai-embed-large";

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Request failed: ${res.status} ${res.statusText}${
        body ? `\n${body}` : ""
      }`,
    );
  }
  return await res.json();
}

function assertModelPresent(tags: any, expectedModel: string): boolean {
  const models: Array<{ name?: string; model?: string }> =
    Array.isArray(tags?.models) ? tags.models : [];
  return models.some((m) =>
    (m.name ?? m.model ?? "").startsWith(`${expectedModel}:`) ||
    (m.name ?? m.model) === expectedModel
  );
}

try {
  const tags = await fetchJson(`${ollamaUrl}/api/tags`);
  if (assertModelPresent(tags, model)) {
    console.log(`Ollama OK: model present (${model})`);
    Deno.exit(0);
  }
  console.log(`Ollama reachable but model missing; pulling ${model}...`);
} catch (err) {
  console.error(
    `Ollama not reachable at ${ollamaUrl}. Start it first (e.g. \`ollama serve\`).`,
  );
  console.error(String(err));
  Deno.exit(1);
}

const cmd = new Deno.Command("ollama", {
  args: ["pull", model],
  stdout: "inherit",
  stderr: "inherit",
});
const out = await cmd.output();
if (!out.success) Deno.exit(out.code);
