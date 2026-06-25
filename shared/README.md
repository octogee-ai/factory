# @octogee/shared

Octogee's shared **type + runtime substrate** (`types/` constants, tier/throttle/
sizing helpers, wire protocol, …). Consumed two ways, on purpose:

- **The `@shared/*` tsconfig path alias → `../shared/*` source.** How app, site,
  functions, and the backend packages have always consumed it. Unchanged.
- **The built `@octogee/shared` package (committed tarball).** How `@octogee/core`
  consumes it, so core can move shared-coupled `scripts/lib` modules in and still
  ship a built interface (never source). This is the **same committed-tarball
  mechanism as core** — see [core/README.md](../core/README.md) for the how, the
  `file:` refresh ritual, and the lock-refresh trap. `verify-tarball.sh` here is the
  same freshness + consumer-lock-integrity guard.

```jsonc
// core/package.json — peerDep so the broken transitive file: path isn't shipped;
// every consumer provides the real one.
"peerDependencies": { "@octogee/shared": "^1.0.0" }
// <consumer>/package.json — the real provider (core + scripts + the 4 backends)
"dependencies": { "@octogee/shared": "file:../shared/octogee-shared.tgz" }
```

## Dual consumption is fine

A consumer (e.g. gateway-edge) sees billing-tiers both through core (→ the tarball's
`dist/`) and through its own `@shared/types/billing-tiers` alias (→ source). The two
compiled copies are **structurally identical**, so they typecheck and interoperate —
validated end-to-end (gateway-edge: 0 type errors using admin-shape via core *and* 66
`@shared` sites of its own).

## Scope of the tarball

`exports` + the build currently cover **`types/` only** — that's all core needs today.
`ws/`, `test-helpers/`, and `templates/` stay alias-only (source) until the consumer
cutover needs them as a package; the build/exports expand then. `peerDependencies` are
marked optional (the `types/` tarball has no runtime npm deps; firebase-admin is
widened to `^13 || ^14` for when test-helpers later joins).

## Layout

- `types/<module>.ts` — one file per public module; each is a package subpath + an
  `@shared/types/<module>` alias target.
- `octogee-shared.tgz` — the committed, consumed artifact (`dist/types/` + package.json).
- `dist/` — gitignored; built transiently for packing.
- `tsconfig.json` — `include: ["types/**"]`; the tarball's build.
