# Prefrontal MCP Server — Agent Usage Guide (Example)

This file is a **baseline prompt/contract** you can copy into a project’s
`AGENTS.md` (or embed into your runner prompt) so Codex agents coordinate using
the Prefrontal MCP server.

Prefrontal provides:

- A **coordination blackboard**: tasks, locks, activity digest.
- A **derived semantic index**: searchable `repo_chunks` (“memory”).

Key principle:

> **Memory is never a source of truth for code facts.**\
> Use it to _find_ where the truth lives, then open and verify the real files
> before acting.

## Authority order (what wins)

1. **Repo reality** (files in the working tree)
2. `docs/FACTS.md` (if present)
3. `docs/adr/*` (if present)
4. Everything else (including memory results)

## Tools (what to use)

Prefrontal MCP tool names are underscore-based:

- Activity: `activity_digest`, `activity_post`
- Tasks: `tasks_create`, `tasks_list_active`, `tasks_search_similar`,
  `tasks_claim`, `tasks_update`, `tasks_complete`
- Locks: `locks_acquire`, `locks_list`, `locks_release`
- Memory: `memory_search`, `memory_get_file_context` (indexer-only:
  `memory_upsert_chunks`)
- Stats (read-only): `stats_get`

All tool schemas are **strict**:

- Do **not** add extra fields.
- If a field is nullable, pass `null` when you don’t have a value (don’t invent
  placeholders).

## Coordination protocol (required)

### 1) Turn start (before deciding what to edit)

1. `activity_digest` to see what changed since your last checkpoint.
2. `tasks_search_similar` using your assignment summary.
3. `tasks_list_active` to see current ownership/leases.
4. `locks_list` to detect hot paths (treat `mode="hard"` as “do not touch”).

If there is an existing active task for your work, prefer continuing it over
creating duplicates.

### 2) Claim or create a task (before editing)

If you’re continuing work:

- `tasks_claim` the task using your `agent_id`, plus `worktree`/`branch` if you
  know them.

If no suitable task exists:

- `tasks_create` with:
  - `title` and `description` (clear and specific)
  - `related_paths` (best-effort; update later if it changes)

Then `tasks_claim` it.

### 3) Acquire locks (before touching files)

Call `locks_acquire` with:

- `paths`: the files/dirs you expect to edit (best-effort)
- `mode`: use `"soft"` by default; use `"hard"` for high-conflict / high-risk
  areas
- `ttl_seconds`: long enough to finish a milestone (extend via task updates if
  needed)

If a blocking `hard` lock exists:

- Do **not** edit those files.
- Post an `activity_post` explaining what you need and choose a different task
  or wait for coordination.

### 4) Checkpoint updates (no polling loops)

Update at natural milestones:

- After you form a plan: `tasks_update(status="in_progress", progress_note="…")`
- After implementation: `tasks_update(progress_note="…")`
- After tests: `tasks_update(progress_note="…")`
- If blocked: `tasks_update(status="blocked", progress_note="…")` +
  `activity_post`

### 5) Completion and cleanup

- `tasks_complete` (attach `result_commit` if applicable)
- `locks_release` for any paths you locked
- `activity_post` summarizing outcome and touched paths

## Using memory safely (derived index)

Use `memory_search` / `memory_get_file_context` to quickly locate relevant
guardrails, decisions, or docs.

Then:

- Open the real files and verify before acting.
- Prefer citing the authoritative file path/section in your reasoning (“verified
  in `docs/…`”).

Never:

- Treat a memory chunk as definitive if it conflicts with the repo.
- “Update” reality by editing memory. Memory is derived.

## Minimal example flow (pseudo)

1. `activity_digest(since_cursor=null, limit=50)`
2. `tasks_search_similar(query="<assignment>", status_in=null, k=10)`
3. `tasks_create(title="…", description="…", related_paths=[…], priority=null, tags=null, base_commit=null)`
4. `tasks_claim(task_id="…", agent_id="…", worktree=null, branch=null, lease_seconds=1800)`
5. `locks_acquire(paths=[…], agent_id="…", ttl_seconds=1800, mode="soft")`
6. Work + repo edits
7. `tasks_update(task_id="…", status=null, progress_note="implemented X; tests next", related_paths=null, lease_extend_seconds=1800)`
8. `tasks_complete(task_id="…", result_commit=null)`
9. `locks_release(paths=[…], agent_id="…")`
