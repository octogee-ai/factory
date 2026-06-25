# @octogee/core

Octogee's shared **runtime** library. Platform packages (`gateway-edge`,
`octogee-api`, `glm-controller`, `scripts`) depend on its **built interface** —
`@octogee/core/<module>` — never its source. That package boundary is what lets
each package typecheck and test standalone, with no cross-package source
compilation and no "install some other package's node_modules first" luck.

`shared/` stays types-only; `core/` is where shared **runtime** code lives.
Modules migrate here over time (`workspace-slugs` is the first); ones with real
runtime deps — secret-manager, firebase-admin, express — bring those deps with
them into `core/package.json`. A dep that consumers pin at **different majors**
(firebase-admin is `^13` in most, `^14` in glm-controller) is declared as an
OR-range (`"^13.10.0 || ^14.0.0"`) so npm dedupes it to each consumer's existing
major — do not collapse it to one major, which forces a second nested copy (and,
for a stateful SDK like firebase-admin, a second app instance).

## How consumers wire it

```jsonc
// <consumer>/package.json
"dependencies": { "@octogee/core": "file:../core/octogee-core.tgz" }
```

`npm ci` **extracts the committed tarball** into the consumer's `node_modules` as
a real package (not a symlink) and installs core's own deps — so the consumer
resolves the declared subpaths, and runtime-dep modules work, with nothing else
installed:

```ts
import { primaryWorkspaceSlug } from "@octogee/core/workspace-slugs";
```

Resolution serves both module systems the monorepo uses: the `exports` map for
`NodeNext` consumers (gateway-edge, octogee-api), `typesVersions` for `node`/node10
(scripts, glm-controller).

## Why a committed tarball (`octogee-core.tgz`)

npm installs a `file:` *directory* dep as a **symlink** and never builds it — and
a symlinked package can't even reach its own runtime deps from a sibling location.
A `file:` *tarball* is different: npm extracts it as a real package and hoists its
deps. It's the only no-registry way `cd <consumer> && npm ci && npm test` "just
works" for a module that imports an npm package. `npm pack` is deterministic by
content, so the tarball is safe to commit and guard.

No registry on purpose: this is one private monorepo — one commit, one release
cycle — so a registry's versioning + auth overhead would buy nothing a solo
operator uses, while costing a standing auth/publish/version-bump pipeline.

## Changing core

```bash
cd core
# …edit src/…
npm run pack:tarball          # rebuild dist + repack → octogee-core.tgz
# Refresh every consumer's lock to the new tarball. npm keys a file: tarball by the
# lock's integrity and will NOT re-read a changed tarball at the same path — so
# clear the cache first. Install WITHOUT --no-save: that flag skips the lock write
# entirely (it only suppresses the package.json edit), which silently strands the
# lock on the OLD integrity. We revert the package.json afterward instead.
npm cache clean --force
for c in scripts octogee-api gateway-edge glm-controller; do
  ( cd "../$c" && rm -rf node_modules/@octogee \
      && npm install "@octogee/core@file:../core/octogee-core.tgz" )
  git checkout "../$c/package.json"   # drop any unicode-escape churn; keeps the lock
done
```

There is no safety net at install time: `npm ci` does NOT verify a file: tarball's
content against its lock, so a stale consumer silently installs old code with no
`EINTEGRITY`. The net is `npm run verify:tarball` (run by the `core` CI job): it
fails if the committed tarball drifts from `src` (compares extracted *contents*,
not bytes — robust across npm versions) OR if any consumer lock's integrity ≠ the
committed tarball. So a forgotten refresh is loud in CI, just not at `npm ci`.

## Layout

- `src/<module>.ts` — one file per public module; each is a package subpath.
- `octogee-core.tgz` — the committed, consumed artifact (contains `dist/` + package.json).
- `dist/` — gitignored; built transiently for packing.
- `src/<module>.spec.ts` — vitest, run against source (`npm test`).
