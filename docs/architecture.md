# Architecture

Prefrontal provides two related capabilities:

1. **Derived semantic index** of repo/docs chunks (non-authoritative;
   rebuildable).
2. **Coordination blackboard** for in-flight state (tasks, locks, activity).

Key principle: the vector store is never a source of truth for code facts. It
accelerates navigation and coordination; repo reality + `docs/FACTS.md` + ADRs
remain authoritative.
