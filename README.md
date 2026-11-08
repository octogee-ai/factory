# Octogee Cloud

Octogee Cloud is the open platform under Octogee, the personal AI partner. It
is the software factory that builds Octogee: the files my agents load at the
start of every session, the checks they run before a change reaches `main`,
and the commands that ship a build. You can read the factory yourself instead
of taking my word for it.

Published from the Octogee monorepo at `5fc418033c0527f625dedfcec9333120064758e2`. The pin in
`.factory-source.json` carries that commit, its date, and the exported source
paths.

## Run it

The installer checks your machine, asks where to run, shows what it will
create, and asks before creating anything. It runs from any shell on macOS,
Linux (including Omarchy and other Arch systems), and Windows under WSL2.

```bash
curl -fsSL https://raw.githubusercontent.com/octogee-ai/octogee-cloud/main/install.sh | bash
```

- [Getting started](docs/getting-started.md) runs it on your machine in Docker.
- [Running in production](docs/running-in-the-cloud.md) runs it on GKE or EKS
  with managed PostgreSQL and object storage.
- [Requirements](docs/requirements.md) lists what you need and what you can
  replace.

Today this installs the foundation: Kubernetes, PostgreSQL, S3 storage, a Git
host, chat, and one OpenClaw gateway. The fleet controller, API and edge are
still moving here.

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

The files listed in `.factory-source.json` are published from the monorepo at
the pinned commit, apart from environment identities replaced by placeholders.
Everything else, including `install.sh`, `deploy/` and the guides under `docs/`,
is written here.

## License

MIT, the same license as the monorepo. See `LICENSE`.
