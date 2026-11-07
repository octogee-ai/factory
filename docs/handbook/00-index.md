---
title: Handbook Index
slug: 00-index
order: 0
part: Orientation
audience: [ops, agent]
description: What this handbook is, who it serves, and how the chapters are organized.
updated: 2026-07-27
---

# Octogee Handbook

This is the **single source of truth** for operating Octogee **and** for the
agentic development workflow. It serves two audiences from one set of chapters:

- **Operators** (human or agent) running the platform — deploy, verify, rotate
  credentials, provision environments, troubleshoot, recover.
- **Builder agents** working in this repo — how we write reliable code, the
  PR/effort workflow, testing rules, repo conventions.

It replaces the old monolith `docs/operations/RUNBOOK.md`. A monolith is bad for
both audiences: a human can't find anything, and an agent can't load just the
slice it needs without dragging in 2,000 irrelevant lines. Each chapter is a
focused, independently-loadable file with frontmatter.

This repository carries the Dev Workflow chapters today. The operations
chapters land here with the rest of the platform.

## How to use it

- **Agents:** load only the chapter(s) relevant to your task. The `audience`
  and `description` frontmatter tell you whether a chapter applies and what it
  covers. Treat chapter content as authoritative over training-time assumptions;
  verify against live code/cluster before asserting (see
  [Engineering Principles](10-engineering-principles.md)).
- **Humans:** browse the chapter map below. (The former Admin → Handbook
  surface is retired — the handbook lives in the repo, read via the Playbook
  surface like any workspace's docs.)

## Conventions

- Each chapter's frontmatter carries `audience` (`ops`, `agent`, or both),
  `part`, `order`, and a one-line `description`.
- "Local source is definitive." If a command/output disagrees with the checked-in
  source (helm charts, scripts, app code), the source wins — and the discrepancy
  is itself a signal worth chasing.

## Chapter map

**Dev Workflow** (how we build here)
- [10 — Engineering Principles](10-engineering-principles.md) — behavior-first tests, no silent failures, fix root cause, greenfield, no narrative comments.
- [11 — Testing](11-testing.md) — test layout, Vitest-only, the coverage-audit tool, the scripts/ test-gate nuance.
- [12 — PR & Effort Workflow](12-pr-and-effort-workflow.md) — small coherent PRs, proportional validation, and explicit merge authority.
- [13 — Repo Conventions](13-repo-conventions.md) — no npm workspaces, per-package build, lint ratchet, fix-code-not-rules.
- [14 — Docs & Curation](14-docs-and-curation.md) — the doc taxonomy and delete-stale-work lifecycle.
