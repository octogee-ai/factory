---
title: Docs & Curation
slug: 14-docs-and-curation
order: 14
part: Dev Workflow
audience: [ops, agent]
description: Keep documentation small, current, and useful.
updated: 2026-07-28
---

# Docs & Curation

Documentation describes the current product and the current way to operate it.
Git is the archive.

## Where information belongs

| Information | Home |
| --- | --- |
| Session orientation | `CLAUDE.md` / `AGENTS.md` |
| Operator and engineering procedures | `docs/handbook/` |
| Durable system shape | `docs/architecture/` |
| Deep service reference | `docs/operations/` |
| Current non-obvious choices | `docs/decisions/DECISIONS.md` |
| Material work still being designed or built | `docs/specs/` |
| Brand and positioning | `docs/brand/` |

Use the narrowest useful home and link to it. Do not copy the same procedure
across several files.

## Lifecycle

- Update a document in the same change that makes it untrue.
- Delete a spec when its work lands, is abandoned, or is mostly complete.
- Replace or delete a superseded decision; do not append a counter-decision.
- Delete retired runbooks, experiment ledgers, release notes, proof packets,
  audit snapshots, and migration history. Git retains them.
- Do not add tombstones explaining that a deleted document or process was
  deleted.
- Do not write tests that assert exact handbook prose. Test executable
  configuration and behavior instead.

Keep `CLAUDE.md` short because every agent pays its context cost. Keep
`docs/INDEX.md` as an entry map, not an exhaustive ledger that must be updated
for every temporary spec.

## What earns a document

Write durable documentation when it helps a cold operator:

- run a current operation safely;
- understand a non-obvious authority or ownership boundary;
- choose between material designs; or
- find the canonical code/config surface.

A completed checklist, PR breakdown, review receipt, launch rehearsal, dated
benchmark, or story about how the system arrived here does not earn a permanent
document.

Private agent memory may point to repository docs, but it is not the canonical
record.
