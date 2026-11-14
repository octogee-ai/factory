---
title: Docs & Curation
slug: 14-docs-and-curation
order: 14
part: Dev Workflow
audience: [ops, agent]
description: Keep documentation small, current, and useful.
updated: 2026-11-13
---

# Docs & Curation

Documentation describes the current platform and the current way to run it.
Git is the archive.

## Where information belongs

| Information | Home |
| --- | --- |
| What the repository is and how to start | `README.md` |
| How to contribute and sign off | `CONTRIBUTING.md` |
| Session orientation for agents | `AGENTS.md` |
| Engineering workflow | `docs/handbook/` |
| Installing, requirements, running in the cloud, OpenClaw compatibility, the trust model | `docs/*.md`, starting at `docs/getting-started.md` |

Use the narrowest useful home and link to it. Do not copy the same procedure
across several files.

## Lifecycle

- Update a document in the same change that makes it untrue.
- Delete a design note when its work lands, is abandoned, or is mostly complete.
- Replace a superseded explanation; do not append a counter-explanation.
- Delete retired runbooks, experiment ledgers, release notes, proof packets,
  audit snapshots, and migration history. Git retains them.
- Do not add tombstones explaining that a deleted document or process was
  deleted.
- Do not write tests that assert exact handbook prose. Test executable
  configuration and behavior instead.

Keep `AGENTS.md` short because every agent pays its context cost. Keep
`docs/getting-started.md` an entry point, not an exhaustive ledger.

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
