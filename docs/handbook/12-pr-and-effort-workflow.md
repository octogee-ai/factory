---
title: PR & Effort Workflow
slug: 12-pr-and-effort-workflow
order: 12
part: Dev Workflow
audience: [agent]
description: Small coherent changes, proportional validation, explicit merge authority, and safe git hygiene.
updated: 2026-07-28
---

# PR & Effort Workflow

Octogee is pre-customer and operated by one person. Optimize for dependable
features reaching `main`, not for producing process artifacts.

## Default flow

1. Make one coherent change on a branch from `origin/main`.
2. Add or update the smallest test that proves changed behavior.
3. Run that test plus the affected package's typecheck or build when relevant.
4. Inspect the diff, push, and open one PR with what changed and how it was checked.
5. The operator merges unless they explicitly delegate merge authority.

Do not create a spec, acceptance-plan document, review agent, council, receipt,
baseline, rehearsal, or follow-up PR merely because a change touches several
files. Those are tools for a demonstrated need, not default stages.

## When extra process is justified

Use a short spec only when the operator must choose between materially different
designs or when independent subsystems cannot ship coherently in one PR.

Ask for an independent review only for a genuinely hard-to-see risk: auth or
tenant isolation, destructive data work, billing, fleet-wide mutation,
cryptography, or a large unfamiliar refactor. One independent review is enough.
CI plus the operator is the normal review path.

Use a live TEST exercise only when the behavior cannot be represented locally
or in an emulator, or when the requested task is itself an infrastructure/live
operation. A live check observes the result; it does not become a permanent
release gate.

Split work into multiple PRs only when each PR is independently useful and the
split reduces risk or review complexity. Do not invent dependency ceremonies.
For release-path deletion work, follow the task's one-deletion-per-PR rule.

## Proportional validation

- Behavior change: focused red/green test, affected package typecheck, CI.
- Cross-package contract: focused tests in each affected owner, affected
  typechecks, CI.
- Declarative config/workflow: the parser/linter and focused contract tests
  that can catch the actual error class.
- Docs-only: links, stale-reference grep, and diff check; no product test suite.
- Generated output: regenerate and verify only the owning build's deterministic
  diff.
- High-risk mutation/auth/data work: add emulator or integration coverage at the
  authority boundary and obtain one independent review.

Do not run the entire repository locally when the focused checks already cover
the change and CI will run the full affected matrix. Do not repeat the same
suite after every commit. More repetitions of the same signal do not create
independent confidence.

## Git hygiene

- Before a git write, check the current branch and `git status`.
- Branch from freshly fetched `origin/main`; do not inherit unrelated local commits.
- Preserve unrelated changes in shared worktrees. Prefer a dedicated worktree.
- Never force-delete a dirty worktree or an unpushed branch.
- After push, take one CI snapshot (the Actions **Required checks** job and the Cloud Build `octogee-linux-pr` check; desktop packaging is explicitly opt-in).
  Read `AGENTS.md` again after updating an existing checkout so CI instructions stay current.
- After a confirmed squash merge, remove the dedicated worktree and branch.

Related: [10 — Engineering Principles](10-engineering-principles.md),
[11 — Testing](11-testing.md), [13 — Repo Conventions](13-repo-conventions.md).
