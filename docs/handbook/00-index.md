---
title: Handbook Index
slug: 00-index
order: 0
part: Orientation
audience: [ops, agent]
description: What this handbook is, who it serves, and how the chapters are organized.
updated: 2026-11-13
---

# Handbook

These chapters cover how to work in this repository: how we write reliable
code, the PR and effort workflow, testing, repo conventions and docs. They are
written for contributors, human or agent. Each chapter is a focused file with
frontmatter, so an agent can load only the one it needs.

Installing and running the platform is covered in `docs/`, starting at
[getting started](../getting-started.md).

## How to use it

- **Agents:** load only the chapter(s) relevant to your task. The `audience`
  and `description` frontmatter tell you whether a chapter applies and what it
  covers. Treat chapter content as authoritative over training-time assumptions;
  verify against live code/cluster before asserting (see
  [Engineering Principles](10-engineering-principles.md)).
- **Humans:** browse the chapter map below.

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
- [13 — Repo Conventions](13-repo-conventions.md) — no npm workspaces, per-package build, internal `dist/` packages, lint, the platform boundary.
- [14 — Docs & Curation](14-docs-and-curation.md) — the doc taxonomy and delete-stale-work lifecycle.
