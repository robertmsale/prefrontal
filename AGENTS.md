# Agent Contract (keep this file short)

This repo is intentionally run with a **low-contradiction** workflow.

If you need architecture context, prefer:

- `docs/FACTS.md` (verifiable facts with evidence)
- `docs/adr/` (append-only decisions)
- `docs/architecture.md` (high-level overview)

## Authority Order (what wins)

1. **Repo reality** (code, manifests, scripts)
2. `docs/FACTS.md` (facts with evidence)
3. `docs/adr/` (workflow/contract decisions)
4. Everything else (may be stale; update it or delete it)

## External Dependencies / API Docs

When relying on external APIs/dependencies, look up usage via the `context7` MCP
docs source (avoid guesswork).
