## What changed

## Monorepo commit this targets

`.factory-source.json` pins the monorepo commit this tree was published from. Name the commit your change targets.

## Checklist

- [ ] Every commit is signed off with `git commit -s`; the `dco` check requires it.
- [ ] `npm ci`, `npx tsc --noEmit`, `npx vitest run`, and `npm run gate` pass locally.
