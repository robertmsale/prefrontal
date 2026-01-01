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

## CLI (single entrypoint)

Install into your PATH:

```bash
deno install -A -n prefrontal src/cli/main.ts
```

Examples (run from inside any repo/worktree to use that project’s scoped
prefix):

```bash
prefrontal tui
prefrontal mcp --transport=http
prefrontal stats
prefrontal memories search "smoke"
```

Codex `codex exec` MCP config example:

```bash
codex exec -c 'mcp_servers.prefrontal.command="prefrontal"' -c 'mcp_servers.prefrontal.args=["mcp","--transport=stdio"]' "{PROMPT}"
```

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

## npm / bun wrappers

This repo is Deno-first, but you can also launch via npm or bun scripts:

```bash
npm run dev
npm run serve
npm run smoke
npm run tui
```

```bash
bun run dev
bun run serve
bun run smoke
bun run tui
```

To smoke test a non-`deno` MCP launcher, set:

- `PREFRONTAL_MCP_COMMAND` (e.g. `npm` or `bun`)
- `PREFRONTAL_MCP_ARGS` (JSON array of args, e.g. `["run","dev","--silent"]`)
