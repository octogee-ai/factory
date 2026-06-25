# @octogee/core

Octogee's shared **runtime** library. Platform packages (`gateway-edge`,
`octogee-api`, `glm-controller`, `scripts`) depend on its **built interface** —
`@octogee/core/<module>` — never its source. That package boundary is what lets
each package typecheck and test standalone, with no cross-package source
compilation and no "install some other package's node_modules first" luck.

`shared/` stays types-only; `core/` is where shared **runtime** code lives.
Modules migrate here over time (`workspace-slugs` is the first); ones with real
runtime deps — secret-manager, firebase-admin, express — bring those deps with
them into `core/package.json`.

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
# refresh each consumer's lock to the new tarball integrity. The EXPLICIT @file:
# spec is required — a plain `npm install` keeps the cached OLD integrity since
# the path didn't change, only the tarball's content. --no-save avoids npm
# reformatting package.json (unicode-escape churn):
for c in scripts octogee-api gateway-edge glm-controller; do
  ( cd "../$c" && rm -rf node_modules/@octogee && npm install "@octogee/core@file:../core/octogee-core.tgz" --no-save )
done
```

A CI miss here is loud, not silent: a consumer whose lock integrity ≠ the
committed tarball fails its `npm ci` with `EINTEGRITY`.

The `core` CI job runs `npm run verify:tarball` — it rebuilds and fails if the
committed tarball drifts from `src` (compares extracted *contents*, not bytes, so
it's robust across npm versions).

## Layout

- `src/<module>.ts` — one file per public module; each is a package subpath.
- `octogee-core.tgz` — the committed, consumed artifact (contains `dist/` + package.json).
- `dist/` — gitignored; built transiently for packing.
- `src/<module>.spec.ts` — vitest, run against source (`npm test`).
