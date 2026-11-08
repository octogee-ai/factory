# fleet: the operator command line

`fleet` is how an operator runs the platform's gateway fleet. The platform runs OpenClaw gateways for its users:

- A **shared gateway** hosts many users.
- An **isolated gateway** hosts one user, on its own VM or pod.

With `fleet`, an operator:
- adds, deploys, restarts, parks and retires gateways
- places users on gateways and moves them between gateways
- follows every change in the operations journal

The platform has no web console. The server behind `fleet` is the Admin API, mounted at `/api/admin`.

## Status

The command line and the Admin API are moving into this repository. Until they arrive, the specs in `scripts/__tests__/fleet-cli/` define the behavior and are skipped: `fleetHarness()` in `harness.ts` returns `null`. When the code lands, `fleetHarness()` will run the real command line against a recording Admin API stub seeded from `FIXTURE`, and every spec will run in CI.

A spec written as `it.todo` still needs its contract worked out.

The Status column below says where each command comes from:
- **Today:** it runs in the current operator command line, sometimes under an older name.
- **New:** this page specifies it first.

## Terms

| Term | Meaning |
| --- | --- |
| Operator | The person who runs the platform. Every `fleet` request carries the operator's identity. |
| User | A person the platform serves. Each user is placed on one gateway and has an OpenClaw agent there. |
| Gateway | An OpenClaw gateway the platform runs: shared or isolated. |
| VM | The machine an isolated gateway runs on. Its home disk holds the user's state; its boot disk is replaceable. |
| Placement | Which gateway a user is assigned to. A gateway reports the users it has actually mounted; a mismatch between the two is drift. |
| Migration | A journaled move of a user from one gateway to another, carrying their channels, repositories and agent. |
| Operation | One entry in the operations journal. Every applied fleet mutation writes one. |
| Activation lease | A user's claim to start their isolated gateway's VM. It can be requested, cancelled, terminated or returned. |
| Release | A numbered, immutable deployment of a build to one gateway. A gateway can roll back to an earlier release. |

## How every command behaves

- **`--env=<name>` is required.** Names come from the operator's configuration; none are built in. Each environment names its Admin API origin and the operator token to use.
- **Identity:** `fleet` authenticates with that operator token. It never mints identity-provider tokens and needs no database or cloud credentials.
- **Reads come first, then at most one mutating request.**
- **Dry run by default.** A mutating command prints the request it would send. A bare `--apply` sends it.
- **`--idempotency-key=<key>`** becomes the request's `Idempotency-Key` header. A retried command with the same key changes nothing twice.
- **Applied mutations are journaled.** The command prints the operation id the Admin API returns.
- **Break glass takes two flags.** Replacing a VM in a way that loses boot-disk data needs `--force --accept-boot-data-loss`; either flag alone is refused.
- **Refusals send nothing and exit non-zero.** That covers an unknown command, an unknown or repeated flag, an unknown user or gateway, and a malformed commit sha.
- **`<user>`** is a user's name or id. **`<gateway>`** is a gateway id. `gw` is short for `gateway`.

## Gateway commands

| Command | What it does | Admin API request | Status |
| --- | --- | --- | --- |
| `gateway ls [--all]` | Lists gateways with status, version, mounted users and last heartbeat. `--all` includes retired gateways. | reads | Today |
| `gateway inspect <gateway>` | Full diagnostic for one gateway | reads | Today |
| `gateway add --id= --image-tag= [--class=shared\|isolated] [--owner=<user>]` | Registers a gateway. The image repository comes from the environment. | `POST /gateways` | Today |
| `gateway deploy <gateway> --sha=<full-sha>` | Deploys an existing immutable build to one gateway | `POST /gateways/<gateway>/deploy` | Today |
| `gateway restart <gateway>` | Restarts the gateway | `POST /gateways/<gateway>/restart` | Today |
| `gateway restart <gateway> --force` | Journals the restart, then deletes exactly one pod. Isolated gateways only. | none (cluster) | Today, `it.todo` |
| `gateway park <gateway>` | Pauses the gateway | `PATCH /gateways/<gateway>` `{desiredStatus: "paused"}` | Today |
| `gateway resume <gateway>` | Resumes a parked gateway | `PATCH /gateways/<gateway>` `{desiredStatus: "running"}` | New |
| `gateway retire <gateway> [--retain-data] [--retain-service-account]` | Retires an empty gateway | `DELETE /gateways/<gateway>` | Today; the retain flags are new |
| `gateway releases <gateway>` | Lists the gateway's releases | reads | New |
| `gateway rollback <gateway> --release=<n>` | Rolls the gateway back to release `n` | `POST /gateways/<gateway>/releases/<n>/rollback` | New |
| `gateway recover-source <gateway> --sha= [--supersede-recovery=<id>]` | Repairs a shared gateway's source after a failed database export, keeping its pod storage | `POST /gateways/<gateway>/recover-source` | Today |
| `gateway recover-restore <gateway> --sha= --operation=<id>` | Upgrades a fenced restore target without replacing its storage | `POST /gateways/<gateway>/recover-restore` | Today |
| `gateway replace-vm <gateway> [--force --accept-boot-data-loss]` | Replaces an isolated gateway's VM from the current image, keeping the verified home disk | `POST /gateways/<gateway>/vm/replace` | Today |
| `gateway move-users <source> --to=<target> [--users=<a,b>]` | Moves the listed users, or all of them, through journaled migrations | to be specified | New, `it.todo` |

## User commands

| Command | What it does | Admin API request | Status |
| --- | --- | --- | --- |
| `user ls [--gateway=<gateway>]` | Lists users and their placement, and reports drift in both directions | reads | Today |
| `user inspect <user>` | Full diagnostic for one user | reads | Today |
| `user assign <user> --to=<gateway>` | Places a user who has no gateway. Refuses a parked gateway and another user's isolated gateway. | `POST /users/<id>/assign` `{gatewayId}` | Today |
| `user migrate <user> --to=<gateway> [--source-transfer=retained-pod]` | Moves a placed user to another gateway as a journaled migration | `POST /users/<id>/migrate` `{to}` | Today |
| `user unassign <user>` | Removes a user's placement | `POST /users/<id>/unassign` | New |
| `user replace-vm <user> [--force --accept-boot-data-loss]` | Replaces the VM of the user's isolated gateway | `POST /users/<id>/vm/replace` | Today |
| `user lease request\|cancel\|terminate\|return <user> [--lease=<id> --generation=<n>]` | Manages the user's activation lease | `POST /users/<id>/activation-lease[/cancel\|/terminate\|/return]` | New |
| `user lease retry-return <user> --operation=<id>` | Retries a failed lease return | `POST /users/<id>/activation-lease/return/retry` | New |
| `user delete <user> [--erase-now]` | Schedules the user's deletion; `--erase-now` erases at once | `POST /users/<id>/delete` `{eraseNow}` | New |
| `user broker <user>` | Shows the user's model broker diagnostics | reads | New |
| `user add <name>` | Creates and admits a user: gateway placement, a managed chat team and channels, a git organization and workspace repository, and an agent | to be specified | New, `it.todo` |

## Platform commands

| Command | What it does | Admin API request | Status |
| --- | --- | --- | --- |
| `ops ls [--status=] [--limit=]` | Lists operations from the journal | `GET /operations` | New |
| `builds ls [--service=] [--limit=]` | Lists builds | `GET /builds` | New |
| `release status` | Shows release convergence across the fleet | reads | Today |
| `pool show` | Shows the shared-gateway placement pool | `GET /placement` | New |
| `pool autoscaling` | Sets the shared-gateway pool's bounds | to be specified | New, `it.todo` |
| `image publish --sha=` | Publishes the tested VM image from a build's manifest | none (registry) | Today, `it.todo` |
| `logs [--level=] [--service=] [--user=] [--migration=]` | Tails shared-gateway and VM-gateway logs together | none (logging backend) | Today, `it.todo` |
| `audit` | Decodes every platform-state record read-only and exits 1 on any finding | none (state store) | Today, `it.todo` |

## Not part of the platform

Commercial concerns such as plans, billing and sign-up flows are not part of the platform, and `fleet` has no commands for them. A product built on the platform adds its own tools.

## Running the specs

```bash
npx vitest run scripts/__tests__/fleet-cli
```

They report as skipped until `fleetHarness()` returns a harness.
