---
title: Testing
slug: 11-testing
order: 11
part: Dev Workflow
audience: [ops, agent]
description: Where tests live and how to choose the smallest signal that catches the changed behavior.
updated: 2026-10-20
---

# Testing

Use the smallest suite that exercises the behavior you changed. Unit tests use
Vitest; the site also has a real-browser Vitest project backed by Playwright.
Ordinary contributions need no Octogee account, cloud credentials, or provider keys.

## Quick start without cloud credentials

Use Node 24.12+ in the 24.x line and npm for these examples. Install each package
independently; root `npm ci` does not install the monorepo. Internal packages ship
committed `dist/` interfaces, so consumers do not need an unpublished npm package.

From the repository root:

```bash
npm ci --prefix shared
npm test --prefix shared
npm run typecheck --prefix shared
```

Package `engines` fields and the [CI package map](../../scripts/lib/scope/manifest.ts)
describe runtime requirements. The [CI toolchain](../../ci/Dockerfile) supplies
Node 22 and 24, Java 21, and Linux tools. Firebase Functions uses Node 22.
Do not copy another contributor's `node_modules` into your checkout.

## Run a focused package test

Use the owning package's test script so its setup and exclusions apply:

```bash
npm ci --prefix app
npm test --prefix app -- src/__tests__/ToolRow.spec.tsx
npm run typecheck --prefix app
```

`npm run test:watch --prefix app` runs the app suite in watch mode. For other
packages, inspect their `package.json`: not every package has the same scripts.
For example, the scripts package typechecks with `cd scripts && npx tsc --noEmit`.

The root `npm test` and `npm run typecheck` delegate to a selection of packages;
they do not install dependencies and do not cover the complete CI matrix. Use
focused checks while developing and the affected CI plan before opening a PR.

## Site browser tests

The site has separate Node and Chromium projects. Use Node 24.x:

```bash
npm ci --prefix shared
npm ci --prefix site
npm run test:unit --prefix site
(cd site && npx playwright install chromium)
npm run test:browser --prefix site
npm run typecheck --prefix site
```

On a fresh Linux host, browser system libraries are also required; Playwright's
`install --with-deps chromium` installs them and may require administrator access.
`npm test --prefix site` runs both projects. These checks use fixtures; signed-in
manual product checks are a separate operator task.

## Run emulator tests

Install Java 21 and select the package's Node version. Test scripts start and stop
the required Firebase emulators; do not substitute real Firestore credentials.
For the rules suite, use Node 24.x:

```bash
npm ci --prefix firestore-rules-tests
npm test --prefix firestore-rules-tests
```

Service suites use `npm run test:emulator --prefix <package>` where that script
exists. For example, `octogee-api` uses Node 24+ and Functions uses Node 22.
Install dependencies in the package before running it. First use can download
emulator binaries. Local project IDs such as `octogee-test` are fixture labels;
the test helper requires the emulator host for emulator-backed database access.

## Run the affected CI checks

From the repository root:

```bash
npm ci --prefix scripts
npm run ci:check -- --plan
```

The plan includes your branch's changes against `origin/main` plus local edits.
It shows package installs, Node versions, and commands. Fetch current main before
planning; an outdated base can select the wrong scope.

On a Linux host with the declared toolchain installed, run `npm run ci:check`.
Otherwise use Docker:

```bash
npm run ci:docker
npm run ci:docker -- --lane=units-1
```

The Docker runner builds the Linux toolchain locally, includes local edits,
and does not mount host cloud credentials. It requires Docker, network access
for dependency/tool downloads, and enough disk and memory for the selected lane.
On Apple Silicon it uses x86 emulation, so it is slower than a native runner.

GitHub Actions runs three unit lanes, an emulator lane, and a quality lane. The app
suite, the longest single check, is sharded in two across unit lanes; the first shard
also typechecks the app.
The aggregate **Required checks** succeeds only when all five pass. PR checks
have read-only repository access and no deployment identity. Image builds,
desktop packaging, and live TEST checks are separate operator workflows; see
[Deploy & CI/CD](21-deploy-and-cicd.md).

## Troubleshooting local runs

| Symptom | Check |
| --- | --- |
| Missing module or executable | Install the owning package with `npm ci --prefix <package>`; root install is separate. |
| Type errors resolving a sibling package | Install the source packages listed by the CI plan; see [package conventions](13-repo-conventions.md#internal-package-directory-dependencies). |
| `Invalid hook call` in a component test | Keep React component tests in `app/` so they use its React installation. |
| Emulator connection failure or missing Java | Use Java 21 and the package's emulator script; remove conflicting emulator processes/ports. |
| Chromium executable missing | Install Chromium from `site/` with Playwright, plus Linux system libraries if needed. |
| GNU tool or `/proc` failures on macOS | Reproduce with the Linux Docker runner; scripts exercise real Linux tools. |
| Out-of-memory or worker exhaustion | Run a focused suite or pass `-- --maxWorkers=2` to its test script. |
| App dev page cannot sign in | Unit tests use mocks; interactive login needs your own configured Firebase/backend services. |

Never solve a local failure by adding production credentials or deleting an
integration assertion. Report the exact command, Node version, operating system,
and redacted error when asking for help.

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

## Choose tests by behavior and risk

Start with a failing test for bugs, new logic, state transitions, authorization,
parsers, handlers, and user interactions. One behavioral test may cover several
files. Skip new tests for prose, pure deletion, formatting, mechanical renames,
generated output, and declarative changes already checked by their owning
parser or linter.

For pure presentation changes, use the browser project or a visual check.
Update brittle DOM/class assertions when the design intentionally changes.
Do not add an implementation-detail test merely to satisfy a process ritual.

Assert the behavior a dependency or image stage provides, not its current
version string or digest. Exact-literal tests that must be updated beside an
automated dependency bump duplicate the package manager or Docker parser and
turn routine currency into a false gate.

## Deciding what to test next — use the tool, never a filename glob

A `*.spec.ts` glob has produced false "no coverage" calls repeatedly (`*.test.ts`
files, `@/`-alias imports, and integration suites all get missed). Run the
import-graph audit:

```bash
npm run --prefix scripts audit-coverage                 # whole repo, 120d churn
npm run --prefix scripts audit-coverage -- --since=90d --top=30 app
```

It ranks modules by churn × size and flags only those with **no test importing
them** (both suffixes, relative + `@/`/`@shared` aliases resolved). Caveat in its
output: app/server integration suites cover routes transitively — confirm the top
candidate has no transitive net before investing.

## Emulator specs must hit the real emulator, never a stub db

A `*.emulator.spec.ts` (or any test claiming integration fidelity for a
db-backed path) MUST use the real Firestore/Auth emulator — never an inline
`{ collection, doc, where, get }` stub or `buildFirestoreStub`. A stub encodes
your *assumption* of the query's behavior; it stays green while real Firestore
(indexes, query shape, collectionGroup needs) diverges, which is exactly how
the previous Activity projection shipped inert in TEST. Pure-logic unit tests spying on a
non-db collaborator are unaffected — this targets faking the db/integration
point itself.

- `@octogee/test-helpers/firestore-emulator`: `getAdminDb()` to seed,
  `setupEmulatorTest()` (fail-loud `requireEmulator()` + per-test reset),
  `useAuthToken(uid)` / `getIdTokenForUid(uid)` mint a REAL emulator ID token
  — covers Auth-gated routes too, not just Firestore reads.
- Run via `npm run test:emulator` (glob `src/__tests__/**/*.emulator.spec.ts`).
  Plain `npm test` **excludes** emulator specs; a bare `npx vitest run`
  does **not** exclude them and will hang waiting for a real emulator.
  Placing an `.emulator.spec.ts` outside `src/__tests__/**` means it silently
  never runs in either config.
- Don't route around a brittle mock by deleting the integration test — patch
  the shared test-helper infra so everyone benefits (an octogee-api spec with
  `vi.mock(".../gateway-edge/src/lib/db")` is debt to migrate onto this
  pattern, not a model to copy).

## Live tests (`tests/live/*.live.spec.ts`) must self-clean at every depth

Ship TEST runs these against deployed TEST (api-test.octogee.com +
`octogee-test` Firestore) after every deployment, through
`scripts/ci/end-to-end-tests.mjs`. Any live spec that provisions real
resources (reservations, users, gateways) must tear them down on **every**
depth/branch it can run, not only its deepest "activate" path — a provisioning
live spec that cleaned up only on `activate` once minted a ghost disposable isolated
gateway in TEST on every run because the default depth was the shallower
`request` (reserve-only). Before adding or reviewing a provisioning
`*.live.spec.ts`, verify cleanup runs on the default path specifically, not only
a manual deep mode.

## Tests that shell out to real git break on CI two ways local git config masks

A test that inits a temp repo and drives real `git` (init/commit/rebase/merge)
passes locally and breaks on the CI runner:

- **Default branch.** CI `git init` creates `master` (no `init.defaultBranch`
  set) — a fixture that later checks out `main` fails. Fix: `git init -b main`.
- **No committer identity.** CI runners have no global `user.name`/`user.email`.
  Passing `GIT_AUTHOR_*`/`GIT_COMMITTER_*` env to your own setup commits isn't
  enough if the **code under test** runs its own `git commit`/`rebase
  --continue` against *ambient* config — it fails silently ("Committer
  identity unknown") and the operation just doesn't advance. Fix: `git config
  user.email`/`user.name` **repo-locally** in the fixture.

Verify locally the CI way before trusting green: `GIT_CONFIG_GLOBAL=/dev/null
GIT_CONFIG_SYSTEM=/dev/null npx vitest run <file>` strips your global identity
and `init.defaultBranch`, reproducing the bare runner. Same session, same
class of miss: a bare `"git"`/`"npm"` command name in `execFileSync` trips
`sonarjs/no-os-command-from-path` under `--max-warnings=0` — use an absolute
path or `process.execPath`/`process.env.npm_execpath`, never a
`$PATH`-resolved name.

## Verification discipline

Use the real command's exit status; a pipe can hide a failing suite. When a
shared default or shape changes, search for callers and assertions that encode
the old contract. Run the focused suite and affected package typecheck; let CI
cover the affected matrix once.

## The scripts/ test-gate carve-out is narrow

Judge by **blast radius, never the directory**:

- **No test gate** — genuinely throwaway one-off operator tooling: hand-run
  diagnostics, one-shot migrations, `audit-coverage`, `ds-drift`, seed/reconcile
  helpers. The operator owns that risk.
- **Behavioral coverage required** — critical runtime code that merely *lives* under
  `scripts/lib/` and is imported by services / shared across packages
  (`admin-fleet-router.ts`, `config.ts`, `provision-reconcile.ts`, `git.ts`,
  `user-lifecycle.ts`, …). These are product code; the path grants zero
  exemption.

Before invoking the carve-out, ask: "is this imported by a running service /
shared across packages / does it mutate prod state?" If yes, cover the changed behavior.
