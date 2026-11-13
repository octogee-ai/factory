## What changed

## Checklist

- [ ] Every commit is signed off with `git commit -s`; the `dco` check requires it.
- [ ] At the root: `npm ci` and `npm run lint` pass locally.
- [ ] In each package you changed: `npm ci`, the typecheck, and `npm test` pass locally (in `scripts/`, also `npm run gate`).
