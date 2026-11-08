# Ship

The shapes of the commands that move a build of Octogee from `main` to a running
fleet. Every project id, host, identity, and environment name is a placeholder.
The implementation lands in this repository with the platform, under `scripts/ci/`; the
workflows live under `.github/workflows/`. Command behavior is the same hosted
and local.

## Contract

1. **Build main** produces one immutable, SHA- and digest-addressed image family
   and manifest. A running main build is never cancelled. Building never deploys.
2. **Deploy platform** checks out an already-built SHA and deploys its platform
   and site surfaces to the selected environment. Shared gateway slots converge
   to that build. Ordinary deployment never changes a Builder gateway's desired
   release.
3. Every fleet mutation writes an operations-journal entry.

There is no semver release, no TEST-to-PROD promotion, no release reservation,
and no automatic CI fleet authority.

## Build main

Builds committed `main` into the immutable image family. The hosted form
dispatches the build workflow and waits for that exact run. The local form
builds on the operator host from a temporary worktree of the commit, so local
edits, untracked files, and ignored artifacts never enter an image.

```bash
npm run ci:submit -- main --sha=<full-main-sha>
npm run ci:build
```

## Ship TEST

Waits for the SHA's complete main build, dispatching one when none exists.
Deploys the TEST platform and site in parallel, publishes the accepted desktop
image when the build includes one, journals each Builder gateway's desired
release, and waits for Shared and Builder live-image convergence. Paused
Builders receive the desired release without waking; retired gateways are
skipped. The end-to-end tests then run against the deployed environment. A
failure there marks the shipment failed after the deployment itself has
completed.

```bash
npm run ci:ship-test -- --sha=<full-main-sha> --actor=operator:<name>
npm run ci:ship-test -- --sha=<full-main-sha> --actor=operator:<name> --local
```

## Ship PROD

Deploys a SHA that has passed Ship TEST and converges the PROD Builder fleet
with the same checks. The operator is responsible for checking that TEST
result; nothing promotes on its own.

```bash
npm run ci:ship-prod -- --sha=<test-passed-main-sha> --actor=operator:<name>
```

## Builder gateway deploy

Deploys an existing build to one non-retired Builder gateway in either
environment. Shared slots are rejected; they follow the platform release. The
command resolves the immutable manifest, writes that gateway's desired release
and one journal entry, and returns. Cowboy, the fleet controller, owns live
convergence. To deploy the same build to another gateway, run the command again
with that gateway id.

```bash
npm run fleet -- --env=<test|prod> gw deploy <builder-gateway-id> --sha=<full-main-sha> --apply
```
