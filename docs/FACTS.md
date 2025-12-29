# FACTS

## Local Runtime Assumptions

- Ollama is expected at `http://127.0.0.1:11434`. Evidence:
  `curl -sf http://127.0.0.1:11434/api/tags`
- Embeddings model expected: `mxbai-embed-large`. Evidence: `ollama list`
- Qdrant is expected at `http://127.0.0.1:6333`. Evidence:
  `curl -sf http://127.0.0.1:6333/collections`
