# Agents — Octogee Project Context

Loaded every session by every agent (CLAUDE.md and AGENTS.md are the same
file — Claude, Codex, and anything else working here share one context). Just-enough orientation; follow `docs/` pointers for depth.

## What Is Octogee

Personal AI partner platform — "Eight arms. One dream." Each Builder gets an AI coach
(their Agent), a workspace with chat (Mattermost) + git (Gitea) + a managed hosting
pipeline. Builders create projects (each with a chat channel, repo, and canvas home
page); others can join workspaces or projects independently. Admins operate via a
separate dashboard.

## Monorepo Layout

No npm workspaces — each package builds standalone (`cd X && npm ci`); root
`package.json` delegates via `npm run --prefix`. All packages are `@octogee/*`.

```
site/            Astro 5 — marketing + public SSR (octogee.com)
app/             Vite + React PWA, all roles (app.octogee.com)
octogee-api/     Express cluster singleton — the HTTP API (api.octogee.com)
gateway-edge/    Express sidecar on each gateway pod — locality routes + MM WS proxy
glm-controller/  "Cowboy" — gateway-fleet lifecycle (provision/retire/roll, /g routing)
fleet/           Go operator CLI — Admin API client only, imports nothing from this repo
functions/       Firebase Functions (Firestore triggers + scheduled)
shared/          @octogee/shared — TypeScript types only (no React)
scripts/         in-pod provisioner + operator tooling
helm/ terraform/ GKE + GCP infra
tests/ firestore-rules-tests/  cross-package + security-rules tests
docs/            start at docs/INDEX.md
```

The per-customer Agent runtime is the OpenClaw **gateway pod** (built from
`infra/gateway/`); gateway-edge and the provisioner run inside it. Ready-to-serve
`static-site` build/test/preview uses a bounded, non-executing API materializer.
Vite/Astro build/test/preview use external ephemeral gVisor Jobs, and publish
uses a separate non-executing Hosting publisher.

## Build + Dev

```bash
npm test            # all packages    ·    npm run typecheck   # tsc --noEmit, all packages
cd app && npm run dev          # :4322
cd site && npm run dev         # :4321
cd octogee-api && npm run dev  # :3001 (the API)
```

## Engineering Principles — non-negotiable (solo operator, pre-customer)

- **Test changed behavior, not files.** Start red for bugs, logic branches,
  state transitions, auth boundaries, handlers, and user interactions. Do not
  invent tests for prose, pure deletion, formatting, mechanical renames,
  generated output, or declarative files already checked by their parser.
- **No silent failures.** Every error path logs, returns a code, or throws.
- **Do not mask upstream bugs.** Validate trust boundaries; inside owned code,
  fix malformed state or duplicate work at its source instead of adding fallbacks.
- **Greenfield.** Breaking changes are fine — no migrations, compat shims, or `_var` renames.
- **No narrative comments on main.** Names express intent, test names pin behavior,
  DECISIONS.md records *why*, memory entries hold load-bearing whys. Use comments liberally
  during the dev loop as in-line chat with the operator — then strip them in the final pre-PR
  cleanup pass. The code speaks the truth; we don't commit the narrative.

## Testing

- **PR readiness.** Use CI and deployed TEST for Octogee PR validation. Open PRs
  for review without adding disposable Gateway qualification or bespoke local
  runtime proof as readiness gates. Reserve disposable Gateways and local runtime
  proof for upstream OpenClaw PRs. Focused local unit tests and typechecks remain
  part of normal development.
- **Component tests live in `app/`**, never `tests/` (separate `react` install elsewhere →
  "Invalid hook call"). Vitest only; service routes use a mocked db; `*.emulator.spec.ts`
  need the Firestore emulator.
- `cd firestore-rules-tests && npm test` auto-starts the emulator. The site owns
  a Vitest browser project backed by Playwright; manual product checks use TEST.
- **Coverage gaps:** `npm run --prefix scripts audit-coverage` (import-graph, both suffixes +
  `@/`/`@shared` aliases) — never a `*.spec.ts` glob, which false-flags repeatedly.
- **`scripts/` test-gate:** throwaway operator tooling is exempt, but shared/runtime code
  under `scripts/lib/` (e.g. `customer-lifecycle`, `provision-reconcile`, `git`, `config`)
  requires behavioral coverage. Blast radius decides, not the directory.

## Workflow — keep it small

This is a pre-customer product run by one operator. Prefer one small PR with one
purpose and the narrowest relevant test/typecheck. Write a spec only when
the operator needs to choose among materially different cross-subsystem designs.
Do not add review agents, receipts, baselines, rehearsals, approval layers, or
multi-PR sequencing unless the operator asks for them or a current customer-risk
boundary requires them.

**Specs are disposable.** Delete a spec when its work lands; code and tests are
the record. Keep `DECISIONS.md` to current, non-obvious choices, not a museum of
superseded process. See [Handbook 14](docs/handbook/14-docs-and-curation.md).

## CI/CD

Linux PR checks, main image builds, explicit platform deployments, Ship TEST, and
scheduled security audits run in **GitHub Actions**. Checks are tiered: PR commits
run the affected packages' typecheck and tests plus diff-scoped lint and security
scans; main runs the full suite every two hours, skipped when every lane already
succeeded on main's current commit; Ship TEST runs the end-to-end tests in `tests/live/` against the
deployed environment. A new push cancels an older automatic main build, and Ship TEST builds any
SHA that was skipped.
Add or change checks in `scripts/lib/ci-checks.ts` and `scripts/ci/`.
PR jobs use read-only repository access and no cloud credentials. Native image
builds run on the runner; GCP remains the registry and runtime host. The aggregate
**Required checks** job is main's only required status check. A Cloud Build trigger
(`ci/cloudbuild-pr.yaml`) can run the same lanes and stays disabled as a fallback.

```bash
npm ci --prefix scripts
npm run ci:check -- --plan
npm run ci:check
npm run ci:docker
npm run ci:submit -- main
npm run ci:build
npm run ci:deploy -- --environment=test --sha=<built-sha> --actor=operator:<name>
npm run ci:ship-test -- --sha=<full-main-sha> --actor=operator:<name>
npm run ci:ship-prod -- --sha=<test-passed-main-sha> --actor=operator:<name>
```

Hosted operator commands dispatch and wait for an exact GitHub Actions run.
`ci:build` builds committed main locally; `ci:deploy -- --local` and
`ci:ship-test -- --local` and `ci:ship-prod -- --local` use the operator host. Desktop installer builds remain explicit. Build main constructs and accepts the
Desktop VM after the container images, bound to the exact Builder Gateway digest.
Ship TEST requires that complete build before deploying. Public desktop downloads stay on GitHub Releases.
Do not add deployment or fleet authority to the main/check identities.
See [Handbook 21](docs/handbook/21-deploy-and-cicd.md) for credentials and cutover.

For a change confined to `glm-controller/`, test it on TEST with the one-off Cowboy image swap in
[Handbook 21](docs/handbook/21-deploy-and-cicd.md#cowboy-only-changes) before merging, rather than waiting for Build main and Ship TEST.

The deployment path preserves three invariants:

1. **Build main** (`.github/workflows/build-main.yml`) produces one immutable, SHA- and
   digest-addressed image family and manifest. Building never deploys.
2. **Deploy platform** (`npm run ci:deploy`) checks out an already-built SHA and
   deploys its platform and site surfaces (in parallel) to the selected environment. The shared pool
   rides it: Cowboy converges every `shared-N` slot to the build's gateway
   image. It never mutates Builder gateway desired state.
3. Every fleet mutation writes an operations-journal entry.

Builder gateway deployment is an operator command, independent of platform
deployment: `fleet --env=<test|prod> gw deploy <gateway-id> --sha=<full-sha> --apply`.
The command may target any non-retired Builder gateway (shared slots are
rejected), resolves the existing immutable manifest, writes that gateway's
desired release, and returns. Cowboy owns live convergence. There is no semver release, TEST-to-PROD promotion,
release reservation, or automatic CI fleet authority. **Ship TEST** is an explicit
operator command (`npm run ci:ship-test`) that waits for the SHA's running Build main run (dispatching one
when there is no manifest or running build), deploys TEST platform/site, publishes the desktop
image when included in the build, journals Builder desired releases, and waits for
Shared/Builder live image convergence. Paused Builders receive the desired release
without waking; retired gateways are skipped. **Ship PROD** deploys a TEST-passed SHA and
converges the PROD Builder fleet. Cowboy attempts the latest accepted computer image when
a stopped computer boots or restarts after preemption, retaining the home disk and logging
any skipped upgrade. Project autosave and shutdown flush are best effort. Active computers
stay running and suspended computers resume on their current boot when the Gateway image is unchanged.
A suspended computer changing Gateway images is stopped before rebinding and cold-started on the retained home.
Admin **Replace
computer** forces a rollout.
Build main constructs the desktop VM before it succeeds, so the boot image carries
that build's Gateway image and new computers skip the image pull. The image is
keyed on the Gateway digest and desktop inputs and reused when unchanged. The
accepted companion is immutable and bound to the main manifest and Gateway digest.
Ship TEST, including `--local`, waits for this complete build; it never constructs
Desktop during deployment. The explicit desktop-image job can complete other main
SHAs. Main/check identities have no deployment or Desktop construction authority;
the Desktop job uses its dedicated build identity.
To deploy one build to several gateways outside a shipment, the operator issues
the command for each gateway. Active images live
in Central Artifact Registry.

## Environments

Active TEST and PROD share the CENTRAL GKE cluster. MM WebSockets ride
`api.octogee.com` (chat.octogee.com retired).

|                       | Test                                              | Prod                                  |
| --------------------- | ------------------------------------------------- | ------------------------------------- |
| GKE cluster / namespace | `<cluster>` / `<test-namespace>`                | `<cluster>` / `<prod-namespace>`      |
| Firebase data project | `<test-project>`                                  | `<prod-project>`                      |
| Firebase Hosting project | `<test-project>`                               | `<prod-project>`                      |
| Site / App / API      | `<test-site-host>` / `<test-app-host>` / `<test-api-host>` | octogee.com / app.octogee.com / api.octogee.com |

## Key Architecture Patterns

- **Surfaces.** `octogee.com` (site/, zero-auth SSR) · `app.octogee.com` (app/ PWA,
  route-driven via `appRoutes.ts`) · `api.octogee.com` = **octogee-api** (cluster, most
  routes) **+ gateway-router** (`/g/<gatewayId>/*` public path-affinity to the selected
  gateway-edge sidecar for workspace git FS, deploy-preview,
  byosub-internal, MM WS proxy). gateway-edge keeps `/api/g/<gatewayId>/*` as its
  internal sidecar mount behind the router.
- **Auth.** Firebase ID token → `requireAuth()`; admin role in `users/{uid}/system/config.role`.
  Service-to-service: tenant-bound K8s SA tokens + dedicated bearers/HMAC signing (see docs/operations/INTERNAL-SERVICE-AUTH.md).
- **Chat.** Team-per-workspace in MM; Builder MM token in `users/{uid}/secrets/mattermost`.
  gateway-edge swaps Firebase→MM token, proxies via K8s DNS. WS tickets: UUID, 30s TTL,
  one-time. Channels: `{slug}-general`, `{slug}-{projectSlug}`, `octogee-{slug}-coach`.
- **Gitea.** Workspace repo `{slug}-workspace`, project repo `{workspaceSlug}-{projectSlug}`;
  text in Gitea, binaries in GCS (`.files/manifest.json`); per-customer `GITEA_TOKEN`.
- **Membership.** Workspace and project membership are independent; `{slug}-general` channel
  membership is the canonical workspace-membership signal.
- **Provisioning.** Onboarding done → Cloud Function records `signupAdmission` → Cowboy
  admits through the platform store (sets `provisioning.status`) → in-pod provisioner
  (scripts, in the gateway pod) creates MM team + Builder + Agent (`octogee-{slug}-coach`)
  + Gitea org + workspace repo. Project create = `POST /api/projects`
  (octogee-api): Firestore doc + MM channel + Gitea repo; client reacts to the doc.
- **Gateways.** glm-controller ("Cowboy") provisions/retires/rolls per-customer gateway pods
  and reconciles the static shared edge routes; per-gateway state in `glmGateways/{id}`.
- **Canvas.** Workspace/project home page — markdown (a repo file, default `README.md`) or
  app-preview iframe.

## Where to Look

The **[Handbook](docs/handbook/00-index.md)** is the single source of truth for both
operations and this dev workflow — the sections above (principles, testing, workflow,
CI/CD, architecture) are the tight summary; the handbook chapters are the depth. It lives
in the repo only; the operator reads it via the Playbook surface (dogfood), not Admin.

Start at **[docs/INDEX.md](docs/INDEX.md)**. Essentials:
[Handbook](docs/handbook/00-index.md) (deploy/verify/troubleshoot/rotate + dev workflow) ·
[SURFACE-ARCHITECTURE](docs/architecture/SURFACE-ARCHITECTURE.md) ·
[GATEWAY-PLATFORM-SPEC](docs/architecture/GATEWAY-PLATFORM-SPEC.md) (fleet/Cowboy) ·
[SECURITY](docs/operations/SECURITY.md) · [MATTERMOST](docs/operations/MATTERMOST.md) ·
[DECISIONS](docs/decisions/DECISIONS.md) (why).
Code anchors: `app/src/routes/appRoutes.ts`, `octogee-api/src/index.ts`,
`gateway-edge/src/index.ts`, `glm-controller/src/index.ts`.
