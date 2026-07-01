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
operator uses, while costing a standing auth/publish/version-bump pipeline. The
cost it *does* impose — committed binaries conflict across concurrent PRs — is paid
down by `npm run regen:file-deps` + the git merge driver (below), not by a registry:
re-evaluated 2026-07-01 and deferred, because 93% of shared-code PRs change a
consumer in the *same* commit, which a registry can't install into CI without a
canary-publish pipeline that churns more lockfile lines than the tax it removes
(see [DECISIONS.md](../docs/decisions/DECISIONS.md)).

## Changing core

Editing `src/` means the committed `octogee-core.tgz` **and** every consumer's
lockfile must be regenerated. One command from the repo root does the whole
ceremony — all three source tarballs (leaf-first: `shared` → `core` →
`test-helpers`) and every drifted consumer lock:

```bash
# …edit core/src/…
npm run regen:file-deps
```

It requires an installed tree (`npm ci` in the packages it touches). It repacks each
stale source tarball, then removes `node_modules/@octogee/*` in each drifted consumer
and reinstalls the dep — so both the lock integrity **and** `node_modules` are
refreshed (no `--package-lock-only` half-refresh that silently strands `node_modules`
on old code). No `npm cache clean` is needed: npm keys its cache by content integrity,
so a repacked tarball (new bytes → new integrity) misses the cache and is re-read.

**Rebasing a repacking PR** is the merge-tax path: the binary `.tgz` and the
consumer locks conflict against any other PR that also repacked, even with zero
overlapping source. One command resolves it — after the rebase halts, it regenerates
the conflicted tarballs + locks from the now-merged worktree source and continues:

```bash
git rebase origin/main    # halts on the .tgz + consumer locks
npm run rebase:resolve    # regenerate the artifacts from merged source + continue
```

`rebase:resolve` only touches the generated artifacts (`octogee-*.tgz` + the consumer
`package-lock.json`s) — a genuine *source* conflict is reported for you to resolve by
hand, never auto-clobbered. A git merge driver can't do this: it runs mid-merge,
before git has finished writing the merged source to the worktree, so it would
rebuild the tarball from stale source and complete the rebase silently wrong — the
*halt* is what guarantees a fully-merged worktree. Re-run the command if a later
commit halts in a multi-commit rebase.

There is no safety net at install time: `npm ci` does NOT verify a file: tarball's
content against its lock, so a stale consumer silently installs old code with no
`EINTEGRITY`. The net is `npm run verify:tarball`, run in CI for core/shared/
test-helpers (the scope manifest folds it into their typecheck step and fans a
`core/` change out to every consumer job): it fails if the committed tarball drifts
from `src` (compares extracted *contents*, not bytes — robust across npm versions)
OR if any consumer lock's integrity ≠ the committed tarball. So a forgotten refresh
is loud in CI, just not at `npm ci`.

## Layout

- `src/<module>.ts` — one file per public module; each is a package subpath.
- `octogee-core.tgz` — the committed, consumed artifact (contains `dist/` + package.json).
- `dist/` — gitignored; built transiently for packing.
- `src/<module>.spec.ts` — vitest, run against source (`npm test`).
