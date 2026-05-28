---
title: PR & Effort Workflow
slug: 12-pr-and-effort-workflow
order: 12
part: Dev Workflow
audience: [agent]
description: Spec-first for larger efforts, fewer PRs off main, the per-PR review agent, severity-tiered fixups, and the git-hygiene rules.
updated: 2026-05-28
---

# PR & Effort Workflow

For one-file / one-bug changes, normal dev flow. This chapter is the process for
work that **spans more than one PR or touches multiple subsystems**.

## Larger efforts

1. **Spec first** in `docs/specs/`. Lock decisions before coding; the operator
   confirms the spec. If the spec needs a material change mid-implementation,
   pause, update it, re-confirm — don't silently drift.
2. **Fewer, larger, coherent PRs.** Each PR reviewable as one unit of thought.
   Don't split gratuitously.
3. **Each PR is a fresh branch off `main`** — never stacked. After a merge:
   `git checkout main && git pull && git checkout -b <prefix>/<slug>`.
   - **Exception — hard-dependency PRs must be git-stacked.** If PR B references
     infra PR A creates *at deploy time* (a K8s Service by name, a Secret, an IAM
     binding, an Ingress path), stack B on A so GitHub blocks early-merge. A
     docstring "merge order:" note is not enough. Belt-and-braces: keep B draft
     until A merges + smoke-validates.
4. **Per-PR flow:**
   - Code the feature per the spec (TDD for logic — see [10](10-engineering-principles.md)).
   - Run the full suite + typecheck locally. Don't push if either is red.
   - Open the PR with a body: spec ref, architecture summary, TDD coverage,
     acceptance steps, explicit non-goals.
   - **Launch the review agent** (Agent tool, `general-purpose` subagent) using
     the canonical prompt in [`review_prompt_template`](#review-prompt) — don't
     re-derive it (criteria drift). Post the review as a PR comment.
   - **Skip the review agent on fast-iteration / shipping days** — reserve it for
     the final ship-ready PR. When unsure on a fast day, ask first.
5. **Implement findings by severity:** **P0** always before requesting review;
   **P1** if the full set is ≤30 min, else the top 2–3 with one-line deferral
   each; **P2** defer by default (note in the PR comment).
6. **Notify** with the PR URL + one-line status. **Do not self-merge** — the
   operator merges.
7. **After merge** the operator confirms; then tear down the local branch +
   worktree (see Git hygiene).

## The single-cumulative-PR variant

When the operator wants to review a coherent multi-feature effort *at once* and
keep momentum: ONE cumulative PR off `main`, opened early; each feature lands as
its own green commit (TDD + full suite + tsc + eslint green before each commit);
run the review agent **once at the end**, not per-feature. Used deliberately for
the app-shell decomposition (#958). Still no self-merge.

## Docs & small-config go direct to main

- Pure docs (`docs/`, `README.md`, code comments, CLAUDE.md, this handbook) and
  small, easily-revertible ops/helm config (e.g. a compute-class default) →
  fresh branch, `git push origin HEAD:main`, **no PR**.
- **Carve-out:** anything touching `cloudbuild*.yaml` / `oc-build-matrix.yaml` /
  `Dockerfile.base` / `entrypoint.sh` goes via branch + PR — those auto-fire a
  prod base-image rebuild + Release CI, so a direct push is an unreviewed prod
  mutation. If unsure, PR.

## Git hygiene

- **Verify branch + clean status before any git write.** This repo is heavily
  worktree'd and the operator switches the main checkout's branch mid-work — a
  bundled verify+commit+push can land work on the wrong branch. Run
  `git branch --show-current` + `git status --short` as a *separate* step first.
  Prefer a dedicated worktree for agent PR work.
- **After the operator confirms a merge,** default to cleanup (don't ask):
  `git checkout main && git pull --ff-only`, then `git branch -d <branch>`
  (lowercase `-d` fails loudly if unmerged — the safety net), then
  `git worktree remove <path>` (no `--force`). Never escalate to `-D`/`--force`
  autonomously — if `-d` refuses, surface the state and let the operator decide.
- **No CI sleep-polling.** After pushing, do at most one `gh pr checks` snapshot,
  report, and stop. The operator drives the merge. For a genuine wait, use
  ScheduleWakeup, not a foreground sleep loop.

<a id="review-prompt"></a>
## Review-agent prompt template

The canonical per-PR review prompt (severity-tagged findings, criteria weighted
by PR type, prior-PR continuity check, summary verdict) is maintained verbatim.
The current copy lives in the operator's memory and should be hoisted here when
next touched; until then, do not re-derive it ad hoc — ask for the canonical
template. Key contract: three sections (Findings P0/P1/P2 with file:line +
suggested change; What's right; Summary verdict), 400–1200 words, read the full
diff, check the referenced spec, flag orphan references.

Related: [10 — Engineering Principles](10-engineering-principles.md), [13 — Repo Conventions](13-repo-conventions.md).
