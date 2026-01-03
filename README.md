<p align="center">
  <img src="assets/logo.png" alt="Prefrontal logo">
</p>

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

## Features & rationale

Prefrontal exists to solve coordination drift in multi-agent (or multi-human) workflows: duplicated work, conflicting edits, and a lack of shared situational awareness across worktrees. It provides a single MCP server that acts as:

- **Coordination blackboard**: tasks, locks, and activity events that let agents claim work, avoid collisions, and understand what changed recently.
- **Derived semantic index (“memory”)**: a fast, searchable map of repo/docs chunks to locate relevant context without treating it as source of truth.

The design intentionally separates **authoritative reality** (the repo and tracked docs) from **derived memory**, so agents can move quickly while still verifying decisions against real files.

This MCP server is a good fit if all of the following are true:

✅ You use multiple coding assistants on the same project
✅ Your coding assistants are working asynchronously
✅ Your coding assistants are in separate worktrees
✅ Your git workflow is highly automated

Do *not* use prefrontal if you are working with a single coding assistant in a synchronous environment with zero automation. Instead, refer to this project's AGENTS.md for a baseline memory & planning system which provides the same benefits with significantly less overhead. Prefrontal is a perfect example of a project that *should not* use prefrontal due to size and simplicity. 

## CLI (single entrypoint)

Install into your PATH:

```bash
deno install -A -n prefrontal src/cli/main.ts
```

Examples (run from inside any repo/worktree to use that project’s scoped prefix):

```bash
prefrontal tui
prefrontal mcp --transport=http
prefrontal stats
prefrontal memories search "smoke"
prefrontal locks list
```

Codex `codex exec` MCP config example:

```bash
codex exec -c 'mcp_servers.prefrontal.command="prefrontal"' -c 'mcp_servers.prefrontal.args=["mcp","--transport=stdio"]' "{PROMPT}"
```

## Memories example

Following `AGENTS.example.md`, if you ask your agent to create memories about that file, they will execute `memory_upsert_chunks` with some facts about that file. Executing `prefrontal memories search "agent" --human` will yield results like the following:
```
results:
  - score: 0.43748978
    chunk:
      chunk_id: agents-example-usage-1
      kind: guardrail
      path: AGENTS.example.md
      commit: null
      authority: 2
      content_hash: null
      chunk:
        start_line: 6
        end_line: 20
        byte_start: null
        byte_end: null
      text: "Memory is derived, never a source of truth for code facts; verify in repo
        files. Authority order: repo reality, docs/FACTS.md, docs/adr/*,
        everything else (including memory)."
  - score: 0.42365688
    chunk:
      chunk_id: agents-example-usage-2
      kind: guardrail
      path: AGENTS.example.md
      commit: null
      authority: 2
      content_hash: null
      chunk:
        start_line: 29
        end_line: 60
        byte_start: null
        byte_end: null
      text: "Coordination flow: start with activity_digest, tasks_search_similar,
        tasks_list_active, locks_list. Then create/claim tasks; acquire locks
        before edits; update progress at milestones; complete task, release
        locks, post activity summary."
```

The search is vector-store based and very flexible. Omitting the `--human` arg will output JSON that can be used in an automation pipeline. Once you set up the AGENTS.md file you can bootstrap adherence to this system in a similar fashion.

## Locks automation (post-commit)

Locks have TTLs, but you can also automatically clear locks after a successful
commit.

Recommended pattern:

- Ensure your runner sets a stable `PREFRONTAL_AGENT_ID` per worktree/agent (so
  the hook knows who to release).
- Add a `post-commit` hook that releases locks for the files changed in the
  commit:

```bash
#!/usr/bin/env bash
set -euo pipefail

: "${PREFRONTAL_AGENT_ID:?PREFRONTAL_AGENT_ID must be set}"

prefrontal locks release-changed --agent-id "$PREFRONTAL_AGENT_ID" --base HEAD~1 --head HEAD >/dev/null || true
```

Doing this saves your agent from the responsibility of clearing locks, otherwise you would have them manually clear their own locks or rely on TTL.

## Project identity (worktree-safe)

By default, the MCP server derives a per-repo Qdrant prefix from your git repository’s **common git dir**, so starting the server from any worktree directory (even sibling worktrees outside the repo root) still shares the same “brain”.

## Path normalization (worktree-safe)

All file paths stored in tasks, activity, memory, stats, and locks are normalized to **repo-relative paths**. Absolute paths are converted using git worktree roots, so the same file is represented consistently across different worktrees.

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
