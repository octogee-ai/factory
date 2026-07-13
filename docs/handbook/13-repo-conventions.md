---
title: Repo Conventions
slug: 13-repo-conventions
order: 13
part: Dev Workflow
audience: [agent]
description: No npm workspaces, per-package build, the lint ratchet, fix-code-not-rules, CI per-workspace installs, verified open-source release currency, and GHAS-via-UI.
updated: 2026-07-11
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
- **A shared type leaf imported cross-package must stay dependency-free.**
  A lean-install package's isolated `tsc --noEmit` only has its own
  `node_modules` — adding one `import type` of a heavier third-party type
  (e.g. `@mattermost/client`'s `Client4`) to a file that `tests/` (or another
  cross-package consumer) imports breaks that package's typecheck in CI even
  though it passes locally (your worktree's sibling `node_modules` masks it).
  Fix pattern: split the dep-bearing type into its own file that the
  cross-package consumer never imports, keep the shared leaf at zero imports.
- **A fresh `git worktree` doesn't materialize `node_modules`** (gitignored),
  and a per-package `tsc --noEmit` can transitively pull in ANOTHER package's
  *source* via a real relative import (e.g. `gateway-edge` importing
  `../../../scripts/lib/admin-fleet-router.js`) — so typechecking the package
  you touched needs `npm ci` in whatever it transitively imports too, not just
  itself. Tell-tale: every `TS2307 Cannot find module` lands in
  `../scripts/...`/`../shared/...`, none in your own package's `src/` — that's
  a missing-install artifact, not a real type error. `npm ci` the imported
  packages (they have their own lockfiles) before trusting the failure.

Every package is named `@octogee/<name>` (consistent scope, no NuCrew-era
leftovers).

## Dependency currency — verified coverage, not configured intent

The target is the newest published stable major/minor/patch for every directly
controlled open-source component, with weekday discovery, immediate security work,
immutable artifacts, human promotion, and an explicit TEST gate for dependency and
stateful upgrades. The implementation contract is
[`OSS-RELEASE-CURRENCY-SPEC.md`](../specs/OSS-RELEASE-CURRENCY-SPEC.md).

The current tools do **not** yet provide full coverage:

- Dependabot handles most npm packages and GitHub Actions, but misses eight tracked
  npm lockfile directories, four Dockerfile directories, and all Terraform providers.
- Renovate is configured for only Mattermost/Gitea Helm pins and has not yet passed its
  activation probe. Configuration without a Dependency Dashboard/test PR is not coverage.
- OSV scans every committed npm lockfile and Trivy scans images/IaC, but detection alone
  does not create or safely promote every update.

Until the companion spec lands, do not describe the repository as fully update-managed.
Stateful services remain isolated, human-reviewed changes because rollback requires a
database restore, not a tag revert. A Gitea update will move as one verified pin group:
chart/archive, explicit chart-appVersion image tag, and the matching rootless image digest.

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

**Lint the full changed-file set, not just the obvious source dir.** CI runs
`eslint .` over every workspace, including build tooling (`.mjs` generators,
`scripts/`) — not just `app/*.tsx`. Scoping a local lint pass to "the app
source I touched" has missed a generated bundle and a `.mjs` generator's
`sonarjs`/`security/*` warnings twice. Before pushing, lint every file you
added or changed (or run the real `eslint .`), not a hand-picked subset.

## Platform settings via the GitHub UI

For repo-level settings (GHAS code scanning, Code Quality, branch-protection
required checks, Actions permissions), present a short list of UI toggles
(Settings path + what to look for) — the operator flips them. Don't chase
half-documented repo-settings API workarounds. Code-owned config (workflow YAMLs,
`dependabot.yml`) is fair game to edit directly.

Related: [10 — Engineering Principles](10-engineering-principles.md), [11 — Testing](11-testing.md), [12 — PR & Effort Workflow](12-pr-and-effort-workflow.md).
