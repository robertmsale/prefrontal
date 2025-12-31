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
deno task serve
```

Defaults:

- MCP: `http://127.0.0.1:8787/mcp`
- Qdrant: `http://127.0.0.1:6333`
- Ollama: `http://127.0.0.1:11434` using `mxbai-embed-large`

## Project identity (worktree-safe)

By default, the MCP server derives a per-repo Qdrant prefix from your git
repository’s **common git dir**, so starting the server from any worktree
directory (even sibling worktrees outside the repo root) still shares the same
“brain”.

Override behavior (highest priority first):

- `PREFRONTAL_PROJECT_ID`: explicit project id / Qdrant prefix
- `QDRANT_PREFIX`: explicit Qdrant prefix (legacy / fallback)

## Environment

Copy `.env.example` to `.env` if you want to override defaults.

## Human TUI client (read-only)

```bash
deno task tui
```
