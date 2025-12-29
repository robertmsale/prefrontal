## Agent Instructions (Docs Scope)

Scope: `docs/**`

Purpose: Keep documentation **low-contradiction** and **auditable**.

Rules:

- Prefer repo reality: if a doc conflicts with manifests/scripts, update the
  doc.
- If you add a “fact”, ensure it is verifiable and add it to `docs/FACTS.md`
  with an Evidence pointer.
- If you change a workflow (scripts, build/test entrypoints, server interfaces),
  add/update an ADR under `docs/adr/`.
- Do not invent missing files/paths in docs. Mark them as Unknown and list them
  under `docs/FACTS.md` → “Known Broken References (Verified)” when applicable.
