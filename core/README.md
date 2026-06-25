# @octogee/core

Octogee's shared **runtime** library. Platform packages (`gateway-edge`,
`octogee-api`, `glm-controller`, `scripts`, `tests`) depend on its **built
interface** — `@octogee/core/<module>` — never its source. That package
boundary is what lets each package typecheck and test standalone, with no
cross-package source compilation and no "install some other package's
node_modules first" luck.

`shared/` stays types-only; `core/` is where shared **runtime** code lives.
Modules migrate here over time (`workspace-slugs` is the first); ones with real
runtime deps — secret-manager, firebase-admin, express — bring those deps with
them into `core/package.json`.

## How consumers wire it

```jsonc
// <consumer>/package.json
"dependencies": { "@octogee/core": "file:../core" }
```

`npm ci` symlinks `core/` into the consumer's `node_modules`. The consumer
imports the declared subpaths:

```ts
import { primaryWorkspaceSlug } from "@octogee/core/workspace-slugs";
```

Resolution is set up for both module systems the monorepo uses: the `exports`
map serves `NodeNext` consumers (gateway-edge, octogee-api) and `typesVersions`
serves `node`/node10 consumers (scripts, glm-controller).

## `dist/` is committed — on purpose

npm installs a `file:` directory dependency as a **symlink** and does **not**
run its `prepare`/build (its devDeps aren't installed in the symlink). So a
consumer's `npm ci` cannot build core. Committing `dist/` is what makes
`cd <consumer> && npm ci && npm test` work with nothing else installed — the
whole point of the package boundary.

CI guards freshness: it rebuilds `dist/` and fails if it differs from what's
committed. So when you change anything under `src/`:

```bash
cd core && npm ci && npm run build   # regenerate dist/
git add src dist                     # commit source AND built output together
```

Forget the rebuild and the `core` CI job goes red (`git diff --exit-code dist`).

## Layout

- `src/<module>.ts` — one file per public module; each is a package subpath.
- `dist/<module>.{js,d.ts}` — committed build output (the consumed interface).
- `src/<module>.spec.ts` — vitest, run against source (`npm test`).
