---
title: Repo Conventions
slug: 13-repo-conventions
order: 13
part: Dev Workflow
audience: [agent]
description: No npm workspaces, per-package build, the lint ratchet, fix-code-not-rules, CI per-workspace installs, and GHAS-via-UI.
updated: 2026-05-28
---

# Repo Conventions

## No npm workspaces — per-package builds

Each package has its own `node_modules` and builds standalone via
`npm run --prefix <pkg>`. The root `package.json` delegates. This matters for
Docker/CI: every Dockerfile and CI job relies on the per-package `cd X && npm ci`
pattern. A workspaces foundation was attempted (#867) and reverted because it
broke that pattern. Revisit only with appetite for the bigger refactor (single
root install + Dockerfile workspace copies).

Consequences to keep in mind:
- **CI lint/knip jobs need `npm ci` for EVERY workspace in `knip.json`**, not
  just the ones running tests. Missing installs surface as
  `Cannot find module 'vitest/config'` or false-positive "unused dependencies".
- **Cross-package spec imports break per-package `tsc`** — keep specs in the
  owning package's `__tests__/` (see [11 — Testing](11-testing.md)).

Every package is named `@octogee/<name>` (consistent scope, no NuCrew-era
leftovers).

## Lint is the moat — fix the code, not the rule

Lint rules (complexity, max-lines, nested-conditional, exhaustive-deps,
no-dead-store) keep the codebase small enough for one operator to run lights-out
and for agents to edit with fewer mistakes.

- **Default: refactor the code.** Extract functions for complexity; early-returns
  for nested ternaries; `unknown` + type guards instead of `any`.
- **Never relax the rule or raise the threshold** to drop a warning count. (A
  bulk rule-disable to go 1216→300 was rejected — the long-form refactor is the
  path.) Only acceptable suppression: a per-line `eslint-disable-next-line` with
  a specific reason, or a true false-positive where the rule's intent doesn't
  apply. When unsure, ask before disabling.

**Read the real lint ratchet — never assume it.** The eslint gate is
`npm run lint -- --max-warnings=<N>` in `.github/workflows/lint.yml`, and **N
ratchets down** over time. Before claiming the gate passes (or sizing a "is this
small" judgment), `grep max-warnings .github/workflows/lint.yml` on the current
branch and compare the real `eslint .` count against *that* number. If over by
N, fix N warnings at the source — don't bump the ratchet up.

## Platform settings via the GitHub UI

For repo-level settings (GHAS code scanning, Code Quality, branch-protection
required checks, Actions permissions), present a short list of UI toggles
(Settings path + what to look for) — the operator flips them. Don't chase
half-documented repo-settings API workarounds. Code-owned config (workflow YAMLs,
`dependabot.yml`) is fair game to edit directly.

Related: [10 — Engineering Principles](10-engineering-principles.md), [11 — Testing](11-testing.md), [12 — PR & Effort Workflow](12-pr-and-effort-workflow.md).
