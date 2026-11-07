# The Octogee factory

Octogee is a personal AI partner platform. This repository is the factory that
builds it: the files my agents load at the start of every session and the checks
they run before a change reaches `main`. I am publishing it on launch day so
that "read the factory" is something you can do, not a claim you take on trust.

Published from the Octogee monorepo at `7f4dedc0df03f3fde8ec19ee24eaac01d559b882`. The pin in
`.factory-source.json` carries that commit, its date, and the exported source
paths.

## What is here

- `AGENTS.md` is the contract every agent loads. It is the file that runs in the
  Octogee monorepo today, renamed from `CLAUDE.md`.
- `docs/handbook/` holds the five Dev Workflow chapters: engineering principles,
  testing, the PR and effort workflow, repo conventions, and docs curation.
- `scripts/lib/ci-checks.ts` plans the pull-request checks from a diff.
  `scripts/lib/scope/` maps changed paths to the jobs that own them, and
  `scripts/ci/quality.sh` runs the lint and security lanes. `npx vitest run`
  runs the spec that pins their behavior, here and in Actions.
- `SHIP.md` shows the shape of the four commands that move a build to TEST, to
  PROD, and to a single Builder gateway. Identities are placeholders.

## What is not here yet

This is not the platform repository. The platform itself, the credential walls,
the LLM broker, Cowboy (the fleet manager), Builder state on PostgreSQL, the
CI/CD workflows, and the rest of the handbook follow in December under this
same organization. Links that point past this folder point at that.

Every file here will move into the platform repository unchanged, apart from
environment identities replaced by placeholders.

## License

MIT, the same license as the monorepo. See `LICENSE`.
