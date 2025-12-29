# ADR 0001: Qdrant-backed coordination blackboard + semantic index

Date: 2025-12-29

## Decision

- Use Qdrant as the per-project store.
- Use local embeddings via Ollama with `mxbai-embed-large`.
- Run a Deno MCP server exposing tools for tasks, locks, activity, and derived
  memory.

## Rationale

- Qdrant provides vector search with structured payload filtering, which matches
  both “semantic overlap” queries and reliable listing/filtering.
- Ollama keeps embeddings local and fast.

## Non-goals

- The vector store is not a source of truth for repo facts.
