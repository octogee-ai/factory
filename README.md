# Octogee Cloud

Octogee Cloud is the open platform under Octogee, the personal AI partner. It
is the software factory that builds Octogee: the files my agents load at the
start of every session, the checks they run before a change reaches `main`,
and the commands that ship a build. You can read the factory yourself instead
of taking my word for it.

[How this differs from OpenClaw Enterprise](docs/why-octogee-cloud.md).

## Run it

```bash
curl -fsSL https://raw.githubusercontent.com/octogee-ai/octogee-cloud/main/install.sh | bash
```

[Try it locally](docs/getting-started.md), or [run it in production](docs/running-in-the-cloud.md) on GKE or EKS.

## What you need to sign up for

On your own machine, one model key. Gemini's free tier works. On Google Cloud,
also a billing account and a domain. [See every account and tier](docs/getting-started.md#what-you-need-to-sign-up-for).

## What is here

- `AGENTS.md` is the contract every agent loads.
- `docs/handbook/` holds the Dev Workflow chapters of the handbook.
- The platform packages: `core`, `shared`, `test-helpers`, the fleet controller
  in `glm-controller`, `gateway-edge`, and `octogee-api`, with `infra`, `helm`,
  `terraform`, `templates` and `scripts` beside them. `tests/` holds the
  cross-package platform specs.
- `scripts/lib/ci-checks.ts` plans the pull-request checks from a diff, and
  `scripts/ci/quality.sh` runs the lint and security lanes.
- `SHIP.md` shows the shape of the four commands that move a build to TEST, to
  PROD, and to a single isolated gateway. Identities are placeholders.

The Octogee product keeps its own private repository and builds on top of this
one.

## License

MIT, the same license as the monorepo. See `LICENSE`.
