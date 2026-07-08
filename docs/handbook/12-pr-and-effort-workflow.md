---
title: PR & Effort Workflow
slug: 12-pr-and-effort-workflow
order: 12
part: Dev Workflow
audience: [agent]
description: Spec-first for larger efforts, fewer PRs off main, the per-PR review agent, severity-tiered fixups, and the git-hygiene rules.
updated: 2026-07-08
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

## Supervised subagents & the council of experts

Larger efforts are delegated to coding subagents working under a supervisor,
fanned out across **Sonnet 5** (Claude Agent tool) and **Codex gpt-5.5 at
xhigh effort** (`codex exec --full-auto -m gpt-5.5 -c
model_reasoning_effort="xhigh" --cd <worktree> "<task>"`) as work is spec'ed.
Standing operator grant (2026-07-08): **auto-completion approved** — once the
council review passes, the supervisor pushes the branch, opens the PR, and
drives review fixups without waiting for operator sign-off. The operator
still merges. The contract:

- **Isolation:** every subagent works in its OWN git worktree on a fresh
  branch off `origin/main` (`git worktree add .claude/worktrees/<name> -B
  <branch> origin/main`). A subagent must verify it is not sitting in a shared
  checkout before touching anything — two writers in one worktree trample each
  other's branch state.
- **No-push protocol:** the subagent implements with full TDD, commits
  locally, and does NOT push or open a PR. Its final report is the
  deliverable: what it built + deviations (with whys), UI states for visual
  review, discoveries affecting future design passes, per-suite pass counts
  with REAL exit codes, and commit hashes.
- **Council of experts review:** the supervisor reviews every report twice —
  once itself with full codebase context, and once via an independent Codex
  CLI review from the agent's worktree:

  ```
  codex exec review --base origin/main -m gpt-5.5 -c model_reasoning_effort="xhigh" "<brief>"
  ```

  Pin the model and effort explicitly (`xhigh` is the CLI's max tier). The
  operator's standing call: the expert second review is **almost always worth
  it — time is the constraint, not tokens** — so default to running it on any
  nontrivial diff (your own included), skipping only when wall-clock genuinely
  forbids. Every finding from EITHER reviewer is re-verified against the code
  before acting;
  genuine disagreements go to the operator with both opinions, never a silent
  tiebreak. Only after the council passes does the supervisor push and open
  the PR (which then gets the normal per-PR review below).

<a id="review-prompt"></a>
## Review-agent prompt template

The canonical per-PR review prompt. Use it verbatim (fill the {braces}) —
re-deriving it each time causes criteria drift.

```
You are reviewing PR #{N} in the Octogee monorepo at {repo path}.

Context:
- Spec: {path to docs/ spec file}
- This PR: {one-line description}
- Branch: {branch-name}
- Prior PRs on this epic: {list of merged PR numbers, or "none"}

Your job: read the PR like a senior engineer who did not write it. Produce a
review in three sections.

1. **Findings**, each tagged with severity:
   - **P0 — blocker**: correctness bug, security hole, broken invariant,
     regression, spec violation that changes behavior.
   - **P1 — should-fix**: maintainability issue, unclear code, missing test,
     minor drift from spec, documentation gap.
   - **P2 — nice-to-have**: style, naming, refactor suggestion, future
     consideration.

   For each finding: file:line reference, one-paragraph description, and
   concrete suggested change.

2. **What's right.** One paragraph. Not cheerleading — note genuinely good
   decisions worth preserving. This calibrates the review and confirms you
   actually read the code.

3. **Summary verdict.** One of: "merge as-is", "merge after P0 fixes",
   "merge after P0+P1 fixes", "needs redesign discussion."

Review criteria, weighted by PR type — match the emphasis before reading:
| PR type | Heavy weight | Light weight |
|---|---|---|
| Docs | Spec coherence, internal consistency, clarity | Security, scalability |
| Pure deletion | Orphan references, coverage of removed surface, is anything still calling it, rules changes | Scalability, performance |
| Refactor | Behavior preservation, test coverage, API stability for callers | New architecture concerns |
| Feature | Completeness vs spec, security, scalability, maintainability, test coverage | (none — full review) |
| Migration/provisioning | MM + Gitea + Secret Manager interaction correctness, idempotency, failure mode, rollback, telemetry | Style |

All PR types: check prior-PR continuity — did this PR contradict or undo
something from recent merged PRs?

Fetch the diff:
  gh pr diff {N}
  gh pr view {N} --json body,commits,files

Diff ONLY via `gh pr diff {N}` (merge-base / three-dot). NEVER a two-dot
`git diff` against a possibly-drifted base — it renders commits that landed on
main after the branch point as phantom reverts. Cross-check the file list with
`gh pr view {N} --json files` before asserting any file is touched.

Scope guardrails:
- Read the full diff. Do not skim.
- Check the spec at the referenced path — flag any drift.
- Flag orphan references: grep for names/paths/functions deleted or renamed.
- If the PR touches Firestore rules, confirm firestore-rules-tests/ covers
  the new surface.
- Server-trusted field on a client-writable doc ⇒ check the rules even if the
  PR didn't touch them (the API write-gate is bypassable via a direct client
  SDK write — an unprotected server-trusted field is a P0 confused-deputy).
- New variant on a shared abstraction ⇒ audit EVERY consumer, not just the
  changed files (sibling consumers silently accept the new variant and
  mis-operate). Binary if/else branches over a widened union deserve special
  attention.
- Field RELOCATION ⇒ re-check read PRECEDENCE, not just presence — a value
  that used to be absent (fallback fired) can become present-but-defaulted
  and silently win in `a || b` resolution chains.
- If the PR touches notifications / fan-out / any async pipeline, confirm
  idempotency and the dedup story.
- Do not rewrite the PR. Suggest changes; don't produce replacement files.

Return plain markdown, 400–1200 words depending on PR size. Don't pad.
```

**Fixup phase, by severity:** P0 always before requesting operator review.
P1 if the full set is under ~30 minutes; else fix the most valuable 2–3 and
defer the rest with one-line justifications. P2 deferred by default, captured
in the PR comment ("noted, not addressing") with one-line reasons. Post a
fixup-summary PR comment (P0 addressed / P1 addressed / Deferred), then notify
the operator with the PR URL and a one-line status. Re-verify every review
finding against the CURRENT branch head before acting — reviews of an earlier
push go stale. After posting the PR, poll Copilot's review comments and
address or answer each inline finding.

Related: [10 — Engineering Principles](10-engineering-principles.md), [11 — Testing](11-testing.md), [13 — Repo Conventions](13-repo-conventions.md).
