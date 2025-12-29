export type EmbeddingResult = {
  vector: number[];
};

const QUERY_PREFIX =
  "Represent this sentence for searching relevant passages: ";

async function postJson(url: string, body: unknown): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(
      `Ollama request failed: ${res.status} ${res.statusText}${
        txt ? `\n${txt}` : ""
      }`,
    );
  }
  return await res.json();
}

export async function embedDocument(
  ollamaUrl: string,
  model: string,
  text: string,
): Promise<EmbeddingResult> {
  const out = await postJson(`${ollamaUrl}/api/embeddings`, {
    model,
    prompt: text,
  });
  const embedding = Array.isArray(out?.embedding) ? out.embedding : null;
  if (!embedding) {
    throw new Error("Ollama embeddings response missing 'embedding'.");
  }
  return { vector: embedding };
}

export async function embedQuery(
  ollamaUrl: string,
  model: string,
  query: string,
): Promise<EmbeddingResult> {
  const out = await postJson(`${ollamaUrl}/api/embeddings`, {
    model,
    prompt: `${QUERY_PREFIX}${query}`,
  });
  const embedding = Array.isArray(out?.embedding) ? out.embedding : null;
  if (!embedding) {
    throw new Error("Ollama embeddings response missing 'embedding'.");
  }
  return { vector: embedding };
}
