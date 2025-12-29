import { load } from "@std/dotenv";

const env = await load({ export: true });

const qdrantUrl =
  (Deno.env.get("QDRANT_URL") ?? env.QDRANT_URL ?? "http://127.0.0.1:6333")
    .replace(/\/+$/, "");

try {
  const res = await fetch(`${qdrantUrl}/collections`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  console.log(`Qdrant OK: reachable (${qdrantUrl})`);
} catch (err) {
  console.error(`Qdrant not reachable at ${qdrantUrl}.`);
  console.error("Start it with: `docker compose up -d qdrant`");
  console.error(String(err));
  Deno.exit(1);
}
