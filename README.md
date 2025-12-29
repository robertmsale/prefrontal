# Prefrontal

Coordination blackboard + derived semantic index for agent swarms.

## Quickstart (local)

1. Start Qdrant:

```bash
docker compose up -d qdrant
```

2. Ensure Ollama + embeddings model:

```bash
deno task ensure:ollama
```

3. Run the MCP server (HTTP streaming):

```bash
deno task dev
```

Defaults:

- MCP: `http://127.0.0.1:8787/mcp`
- Qdrant: `http://127.0.0.1:6333`
- Ollama: `http://127.0.0.1:11434` using `mxbai-embed-large`

## Environment

Copy `.env.example` to `.env` if you want to override defaults.
