---
title: Testing
slug: 11-testing
order: 11
part: Dev Workflow
audience: [agent]
description: Where tests live, Vitest-only rules, the import-graph coverage audit, and the scripts/ test-gate nuance.
updated: 2026-05-28
---

# Testing

```bash
npm test          # per-package; CI runs them in parallel (no root aggregator)
npm run typecheck # tsc --noEmit per package
```

Vitest everywhere. **No Playwright, no E2E harness.** Manual browser
walkthroughs go through `app-octogee-test.web.app` + Chrome MCP (or headless
Chrome screenshots).

## Where tests live

| Package | Covers | Location |
|---|---|---|
| `app/` | React components, pages, route guards, hooks | `app/src/__tests__/*.spec.{ts,tsx}` (jsdom + RTL) |
| `gateway-edge/` | Express routes, middleware, MM/Gitea integration | `gateway-edge/src/__tests__/*.spec.ts` (Vitest + supertest, mocked db) |
| `tests/` | Cross-package **pure logic** (formatters, slug logic, route parser, throttle math) | `tests/{chat,mattermost,provisioner,specs}/**/*.spec.ts` |
| `scripts/` | provisioner + gateway scripts | `scripts/__tests__/*.spec.ts` |
| `functions/` | Firestore triggers + scheduled (unit + emulator) | `functions/src/__tests__/*` |
| Firestore rules | rules behavior | `firestore-rules-tests/` (emulator; `cd … && npm test`) |

**Component tests MUST live in `app/`**, never in `tests/`. React's
single-instance rule: a separate package = a separate `react` install =
"Invalid hook call". Vite aliases paper over it until the next clean install.

**Specs live with the module they test.** A spec under `tests/` that imports from
a sibling package's `lib/` passes vitest locally but breaks CI's per-package
`tsc` (separate `node_modules`). Put it in the owning package's `__tests__/`.
`tests/` is for cross-package *pure logic* only. See
[13 — Repo Conventions](13-repo-conventions.md).

## Relaxed TDD for pure UI

For **pure presentation** changes (no new logic) skip preemptive tests — the
operator verifies visually in the browser. If an existing UI test breaks because
a visual detail changed (class name, DOM shape), **update the test to match the
new design**; don't contort the component to keep old assertions green. Logic
(hooks, reducers, resolvers, transforms, middleware, handlers) stays
TDD-mandatory. Reusable primitives with a typed API still get a contract test.

## Deciding what to test next — use the tool, never a filename glob

A `*.spec.ts` glob has produced false "no coverage" calls repeatedly (`*.test.ts`
files, `@/`-alias imports, and integration suites all get missed). Run the
import-graph audit:

```bash
npm run --prefix scripts audit-coverage                 # whole repo, 120d churn
tsx scripts/audit-coverage.ts --since=90d --top=30 app  # scope to a package
```

It ranks modules by churn × size and flags only those with **no test importing
them** (both suffixes, relative + `@/`/`@shared` aliases resolved). Caveat in its
output: app/server integration suites cover routes transitively — confirm the top
candidate has no transitive net before investing.

## The scripts/ test-gate carve-out is narrow

Judge by **blast radius, never the directory**:

- **No test gate** — genuinely throwaway one-off operator tooling: hand-run
  diagnostics, one-shot migrations, `audit-coverage`, `ds-drift`, seed/reconcile
  helpers. The operator owns that risk.
- **TDD-mandatory** — critical runtime code that merely *lives* under
  `scripts/lib/` and is imported by services / shared across packages
  (`admin-fleet-router.ts`, `config.ts`, `provision-reconcile.ts`, `git.ts`,
  `customer-lifecycle.ts`, …). These are product code; the path grants zero
  exemption.

Before invoking the carve-out, ask: "is this imported by a running service /
shared across packages / does it mutate prod state?" If yes → TDD.
