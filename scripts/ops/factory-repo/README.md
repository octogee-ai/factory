# Octogee Cloud

Octogee Cloud is the open platform under Octogee, the personal AI partner. It
is the software factory that builds Octogee: the files my agents load at the
start of every session, the checks they run before a change reaches `main`,
and the commands that ship a build. You can read the factory yourself instead
of taking my word for it.

Published from the Octogee monorepo at `{{sha}}`.

## Run it

```bash
curl -fsSL https://raw.githubusercontent.com/octogee-ai/octogee-cloud/main/install.sh | bash
```

[Try it locally](docs/getting-started.md), or [run it in production](docs/running-in-the-cloud.md) on GKE or EKS.

## What is here today

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

## What lands next

The rest of the platform lands here as the split from the private product
completes: the credential walls, the LLM broker, Cowboy (the fleet manager),
Builder state on PostgreSQL, the CI/CD workflows, and the operations chapters
of the handbook. The Octogee product keeps its own private repository and
builds on top of this one.

Files listed in `.factory-source.json` are published from the monorepo, with
environment identities replaced by placeholders. The rest is written here.

## License

MIT, the same license as the monorepo. See `LICENSE`.
