---
title: Engineering Principles
slug: 10-engineering-principles
order: 10
part: Dev Workflow
audience: [agent]
description: Reliable code with risk-based tests, explicit failures, root-cause fixes, and proportional effort.
updated: 2026-07-08
---

# Engineering Principles

Solo operator, pre-customer. Code like your sleep depends on it — because the
operator is on call for every silent failure.

## Core

- **Test changed behavior, not files.** Start with a failing test for a bug,
  new logic branch, state transition, authorization boundary, parser, handler,
  or user interaction. One test may cover several implementation files. New
  tests are not required for prose, generated output, pure deletion, mechanical renames,
  formatting, or declarative changes already checked by the owning
  parser/linter. Do not create an implementation-detail test to satisfy a ritual.
- **No silent failures.** Every error path is explicit and observable — a log,
  a response code, or a thrown error. "If this fails, will I know immediately?"
  If not, add explicit handling.
- **Do not mask upstream bugs.** Validate untrusted input and external-system
  responses at trust boundaries. Inside owned code, fix double firing or
  malformed state at its source instead of accumulating fallbacks that hide it.
- **Fix root cause, not symptom.** Flaky test → find the race. Drifting config
  → fix the source.

The question is not “did every file get a new test?” It is “what could this
change break, and what is the cheapest signal that would catch that break?”

## Greenfield posture

Pre-broad-customer, breaking changes are cheap and correctness is the priority.

- No migrations, no API versioning, no backwards-compat shims, no `_var` renames
  for compat. Just change the code — clean breaks over compat hacks.
- **Past pure-greenfield for real user DATA, still greenfield for code.**
  Quiet friends-and-family users exist now — code/routes/API/schema shape
  still gets clean breaks (no redirect routes, no versioning), but a change
  that moves/renames/removes a field on `users/*`, `workspaces/*`,
  `projects/*` (or other user-facing docs) needs a real migration: idempotent,
  dry-run-first, tested against the emulator, `--dry-run` then `--apply` on
  test then prod. Cattle/fleet state (`glmGateways`, gateways) stays
  teardown-recoverable — no migration needed there. Breaking the code is
  free; silently orphaning a quiet user's data is a real regression.
- **Teardown over surgery:** when state is tangled and no real data is at risk,
  nuke + rebuild beats an intricate manual recovery (the corollary of "PVC data
  is critical" — which flips the moment there's real user data).
- **Upgrade, don't stop:** if a refactor hits a legacy-cruft blocker (one package
  is CommonJS, another ESM), upgrade the laggard — don't back out or build a
  dual-pipeline shim. The right architecture is cheap to install now.

## Comments & config

- **No narrative comments.** Code expresses intent through naming; tests cover
  edge cases; specs/this-handbook describe design; PR descriptions hold history.
  Don't write multi-line `// WHY:` blocks — extract a well-named helper, or pin
  the edge case with a behavioral test. Don't reference the current task/fix/
  caller in a comment ("added for X flow") — it rots.
- **No environment conditionals.** Never branch on env name to pick a URL/value
  (`if test then chat-test… else chat…`). Derive from K8s/Helm/env. Cattle, not
  pets.

## Dependency posture

Use a current stable version when adding or intentionally upgrading a
dependency. Do not bump unrelated dependencies merely because a file was
touched. Security updates are prompt; routine currency is batched. Native
dependencies need a clean install/build check because install-script policy is
part of their runtime contract.

## Paying down debt: net-first, then cut

Eslint warning counts are a *lagging* indicator — the real smell is test
coverage inversely correlated with churn × criticality. When tackling a
tangled/high-blast-radius file, write the characterization test (pin the
intended behavior, mock at the seams so it survives the refactor) for the
highest churn×blast-radius file **first**; the refactor/split/lint cleanup
falls out cheaply and safely once the net is in place. Do not let a refactor
expand into an unrelated program. A nearby clear defect may be fixed in the
same PR when it is small and covered; otherwise report it. Use
the import-graph coverage audit ([11 — Testing](11-testing.md)) to find the
next target — never a filename glob.

## Reusable atoms over inline one-offs

Extract a reusable primitive when repetition is causing drift or slowing the
current change. There is no “third occurrence” mandate and no requirement to
sweep every caller in the same PR. Prefer a small typed API when extraction
actually earns its keep.

## Calibrated effort

- **Proportionate fixes, not programs.** For a "get it back to working"
  regression, find the existing mechanism that regressed and the minimal lever to
  restore it — don't architect an SSOT + guard + multi-PR program. If you catch
  yourself writing "Phase 1/2/3" for a regression repair, shrink it.
- **No premature perf optimization.** No pacing/queues/sync-vs-async splits in the
  provisioner/fleet path without a concrete trace showing the bottleneck. (#936
  added both against hypothetical load; both broke TEST and were reverted in #943.)
- **Right net for the bug class.** Index-presence and render-time-env bugs are not
  caught by more emulator tests — they need declarative config + fail-loud-at-boot
  + a live exercise. Reach for the net that actually catches the class.
- **Precise risk framing.** Distinguish an immutable artifact proven in prod from
  a build step that would only fail if re-run. Don't dramatize dead-code or
  stale-rebuild as live production risk.

Related: [11 — Testing](11-testing.md), [12 — PR & Effort Workflow](12-pr-and-effort-workflow.md), [13 — Repo Conventions](13-repo-conventions.md).
