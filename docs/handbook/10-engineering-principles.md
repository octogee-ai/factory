---
title: Engineering Principles
slug: 10-engineering-principles
order: 10
part: Dev Workflow
audience: [agent]
description: How we write code here — TDD, no silent failures, fix root cause, greenfield, no narrative comments, calibrated effort.
updated: 2026-05-28
---

# Engineering Principles

Solo operator, pre-customer. Code like your sleep depends on it — because the
operator is on call for every silent failure.

## Core

- **TDD is mandatory, not aspirational.** Every code change starts with a
  failing test. RED → GREEN → refactor. Applies to logic, route handlers,
  components, and bug fixes equally. For a bug fix: write the test that
  reproduces the bug, watch it fail, fix, watch it pass.
- **No silent failures.** Every error path is explicit and observable — a log,
  a response code, or a thrown error. "If this fails, will I know immediately?"
  If not, add explicit handling.
- **No defensive guards or fall-through patterns.** Don't code around a
  double-firing trigger or mis-shaped data — fix the upstream bug. Guards are
  acceptable only when they're a documented architectural pattern. Avoid
  `config = a ? 'B' : c || 'D'` ternary chains.
- **Fix root cause, not symptom.** Flaky test → find the race. Drifting config
  → fix the source.

**Red flags that mean TDD was skipped** (stop and correct):
- Implementation written first, "tests added after" — that's verification, not TDD.
- "Too simple for a test" — if it's simple, the test is simple; write it.
- "I type-checked it" — types catch signatures, not behavior.
- "I verified it works" without naming a specific test — not actually verified.

## Greenfield posture

Pre-customer means breaking changes are cheap and correctness is the priority.

- No migrations, no API versioning, no backwards-compat shims, no `_var` renames
  for compat. Just change the code — clean breaks over compat hacks.
- **Teardown over surgery:** when state is tangled and no real data is at risk,
  nuke + rebuild beats an intricate manual recovery (the corollary of "PVC data
  is critical" — which flips the moment there's real customer data).
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

## Dependency posture — ride latest, fail loud

- New deps land at `^<latest>`; existing deps get bumped on touch. "Pinned to vN"
  without a stated reason is a smell — pre-customer we trade dependency volatility
  for fewer accumulated CVEs.
- If `npm ci`/CI breaks on latest, **investigate why** — never pin back to silence
  it. A red CI on a fresh install is a signal. (Verify a fresh install + test pass
  for native/build-sensitive deps like node-pty before merging the bump.)

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
