import { load } from "@std/dotenv";

const env = await load({ export: true });

const qdrantUrl =
  (Deno.env.get("QDRANT_URL") ?? env.QDRANT_URL ?? "http://127.0.0.1:6333")
    .replace(/\/+$/, "");

try {
  const maxAttempts = 30;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(`${qdrantUrl}/collections`, {
        headers: { accept: "application/json" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      console.log(`Qdrant OK: reachable (${qdrantUrl})`);
      Deno.exit(0);
    } catch (_err) {
      if (attempt === maxAttempts) throw _err;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
} catch (err) {
  console.error(`Qdrant not reachable at ${qdrantUrl}.`);
  console.error("Start it with: `docker compose up -d qdrant`");
  console.error(String(err));
  Deno.exit(1);
}
