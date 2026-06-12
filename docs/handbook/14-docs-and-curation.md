---
title: Docs & Curation
slug: 14-docs-and-curation
order: 14
part: Dev Workflow
audience: [ops, agent]
description: The doc taxonomy (what knowledge lives where), the lifecycle rules, and the periodic curation ritual that keeps the repo's crystallized intelligence true.
updated: 2026-06-12
---

# Docs & Curation — the knowledge loop

The repo's documentation is the platform's **crystallized intelligence**: the CTO-grade
judgment — what right means, what good looks like, how to deliver it — captured so that
any new agent, starting cold from `CLAUDE.md`, builds the way we build. Code says *what
is*; tests say *what must stay true*; docs say *why, how we work, and what to never
re-learn the hard way*. This chapter is the contract for keeping that true.

The flow every session rides: **`CLAUDE.md`** (tight orientation, loaded every session) →
**`docs/INDEX.md`** (the complete map) → **the Handbook** (this — operations + dev
workflow, dual-audience) → deep companions (architecture, operations, specs, DECISIONS).

## The taxonomy — one home per kind of knowledge

| Knowledge | Home | Lifetime |
|---|---|---|
| Session orientation (just enough, pointers out) | `/CLAUDE.md` | permanent, kept *small* — it's loaded every session; depth belongs elsewhere |
| The map (every doc, one honest line each) | `docs/INDEX.md` | permanent; **if it isn't listed it isn't real** |
| How we operate + how we build | `docs/handbook/` | permanent chapters; dual-audience frontmatter |
| System shape | `docs/architecture/` | long-lived; update when the shape changes |
| Work in flight | `docs/specs/` | **disposable** — exists only while unimplemented |
| Why we chose X | `docs/decisions/DECISIONS.md` | append-only ledger; the landing place for retired specs' whys |
| Deep operational references | `docs/operations/` | long-lived companions to the Handbook |
| Brand / positioning | `docs/brand/` | long-lived |
| Dated audits/snapshots | `docs/security/` etc. | frozen point-in-time records; superseded, never edited |
| External-contract references (e.g. OpenClaw wire semantics) | `docs/architecture/` | long-lived; cite the upstream source they mirror |
| Roll/build ceremony for the OpenClaw fork | `infra/gateway/openclaw-tarball/README.md` | canonical for the ceremony — read at roll start, update at roll end |
| Customer-workspace seed content | `templates/` | product content, not harness docs — versioned with the product |

Agent session memory (`~/.claude/.../memory/`) is **private recall, not the record**: when
something in memory becomes load-bearing, *promote it* — commit the canonical version to
the repo and shrink the memory entry to a pointer. (OpenClaw provides platform-agent
memory; we don't rebuild it, and we don't let either memory substitute for repo docs.)

## Lifecycle rules

- **Specs are disposable.** Delete a spec when its work lands (≥90% done counts): history
  → DECISIONS, how → code, what → tests, outstanding scraps → issues. A spec that stays
  must carry a status header that tells the truth (`LOCKED`, `active`, `PARTIALLY LANDED —
  re-scope before resuming`, `proposed`). A stale status header is a lie with a timestamp.
- **Tombstones over silent moves.** When a doc's home changes, leave a short redirect at
  the old path (see `operations/RUNBOOK.md`) so old links and old habits still land true.
- **Negative knowledge is real knowledge.** Deliberately state what *doesn't* exist
  ("there is no `chat.octogee.com`", "`octogee-prod` does not exist") — it's how the next
  agent avoids resurrecting the dead. Distinguish it from staleness: a doc *describing*
  a retired thing as live is rot; a doc *declaring* it retired is armor.
- **Delete > archive.** Git is the archive. No `docs/old/`, no `-v2` files.
- **One SSOT per fact; pointers everywhere else.** Duplication is allowed only as a tight
  summary that names its source of depth (CLAUDE.md summarizing the Handbook is the
  pattern, drift-checked at curation).
- **Date the point-in-time claims.** Absolute dates ("as of 2026-06-12"), PR links for
  history, file-path links for code anchors so they're clickable and greppable.
- **Write for the agent with zero context.** Every doc must stand alone: full paths, exact
  commands, no session-private shorthand. The scar that motivated a rule belongs *next to
  the rule* in one line ("the `mama` teardown left a 20Gi PVC behind — hence structural
  teardown deps"), not in a separate war-stories file.
- **Dual audience is a frontmatter fact.** Handbook chapters declare `audience:`; humans
  and agents read the same repo files. (The former Admin → Handbook bundle and its
  regen step are retired — the Playbook surface renders docs straight from the repo,
  so there is no second copy to drift.)

## The curation ritual

Curation is how the harness rebuilds itself as we learn. Two triggers:

**Per-arc micro-pass (every time a multi-PR effort closes).** Five minutes, part of the
last PR or a `docs(curation):` commit: delete the arc's spec (fold whys into DECISIONS),
update any doc the arc made untrue, add newly retired terms to the vocabulary list below.

**Full pass (monthly, or when entering a new build phase).** An agent session, direct to
main, `docs(curation):` commits, ending with a short report to the operator:

1. **Specs sweep** — every file in `docs/specs/`: landed → delete + fold; drifted → fix
   the status header; cold >60 days → propose retirement (the #1153 "retire 15 cold
   specs, outstanding → issues" sweep is the precedent).
2. **Retired-vocabulary grep** — search all real docs for the dead terms; each hit is rot
   or armor — fix the rot:
   `grep -rnE "<term>" --include='*.md' docs templates README.md CLAUDE.md infra app/docs design-system`
   Current list (append as things die): `restoreJobs` · `dispatched` · `inFlightJobId` ·
   restore-`kick` · `drain-loop` · `provision-dispatcher` · `boot-sync.ts` ·
   `chat.octogee.com`-as-live · `octogee-prod` · `gw-` id prefix · `instanceName` ·
   NuCrew names · self-hosted Prometheus/Grafana · React-Native `mobile/` ·
   `setup-gateway.sh` · Cloud-Tasks restore push.
3. **INDEX truth-check** — every doc listed, every one-liner still true, statuses match
   the files; `ls docs/**/*.md` vs the INDEX must reconcile.
4. **CLAUDE.md budget check** — it's loaded every session: keep it orientation + pointers;
   if a section has grown depth, push the depth into the Handbook and keep the summary.
5. **DECISIONS audit** — entries contradicted by later decisions get a one-line
   "superseded by <entry>, <date>" annotation (append, don't rewrite history).
6. **Link check** — relative links resolve:
   `grep -rnoE "\]\((\.\.?/[^)#]+)" --include='*.md' docs | while IFS=: read f _ l; do p="${l#](}"; [ -e "$(dirname "$f")/$p" ] || echo "BROKEN $f → $p"; done`
7. **Memory-promotion pass** — anything load-bearing living only in agent memory gets
   committed here and the memory entry becomes a pointer.
8. **Handbook bundle regen** if any chapter changed (step 8 of the dual-audience rule).

Report format: what was deleted, what was fixed, what was flagged-not-acted-on, and the
one metric that matters — *"could a cold agent, starting at CLAUDE.md, still find
everything it needs without a human?"*

## The pattern is the platform (studio model)

This shape — **entry file → map → dual-audience handbook → disposable specs → append-only
whys → periodic curation** — is not Octogee-specific. It is how a senior engineering
mind's judgment gets encoded so agents can build trustworthily at scale. In the studio
model, a studio operator plays the CTO-mind role for their builders' repos: *their*
standards in the handbook, *their* whys in DECISIONS, their builders' agents starting cold
from the entry file — with the platform operator asking the meta-questions ("have you
thought about scaling that?", "is that the right customer experience?") that season the
studio's crystallized intelligence over time. When the first studio onboards, instantiate
this same shape in their repos — entry file, map, handbook, specs, decisions, this
curation chapter — seeded small and grown by *their* working sessions. Until then, build
nothing speculative; this chapter and the shape it describes are the template.
