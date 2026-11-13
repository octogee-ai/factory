# The full platform on kind

This guide installs the whole platform on a local [kind](https://kind.sigs.k8s.io/)
cluster. It needs no cloud account. One script builds the platform images from
your checkout, starts the cluster and installs everything with Helm. For the
smaller local foundation that `install.sh` sets up, see
[Getting started](getting-started.md).

The cluster runs:

- PostgreSQL, for platform state, Mattermost, Gitea and the agent stores;
- SeaweedFS, as the S3 blob store;
- Mattermost, for chat;
- Gitea, for git;
- the fleet controller, with its Admin API;
- the gateway edge;
- the platform API;
- a shared gateway, once you add one.

## What you need

- Docker, with at least 8 CPUs and 12 GB of memory for its VM
- kind, kubectl and Helm (tested with kind 0.33, kubectl 1.36 and Helm 4.3)
- Node.js 22 or later
- openssl, ssh-keygen and git

The gateway image is large. The builder's cache grows to about 25 GB across the
platform images, and later builds reuse it.

## Install

From the repository root:

```bash
scripts/ops/kind-install.sh up
```

The script:

1. starts a local image registry on `localhost:5001`;
2. creates the kind cluster `octogee` with its own kubeconfig, so your current
   kubectl context does not change;
3. downloads the pinned OpenClaw build and checks its sha256 against
   `infra/gateway/openclaw-tarball/current.json`;
4. builds the platform images for your machine's architecture with a
   dedicated BuildKit builder, and pushes them to the local registry;
5. generates every secret: database passwords, the secret store root key, the
   S3 keys, the fleet signing keys, the operator key, and the Mattermost and
   Gitea admin credentials;
6. installs PostgreSQL and SeaweedFS, then the Helm chart in `helm/octogee`;
7. creates the Mattermost admin, its access token and the `octogee` team, and
   the Gitea admin, its token and the `octogee` organization;
8. restarts the platform so it reads those tokens, and waits for the fleet
   controller.

Run it again at any time. Each step checks what exists, and secrets are kept
between runs.

The script keeps its state in `~/.local/state/octogee-kind/octogee`. Set
`OCTOGEE_KIND_STATE` to keep it somewhere else. The state holds the kubeconfig,
the generated secrets and the image digests.

| Flag | Effect |
| --- | --- |
| `--name=<name>` | Name of the cluster and of its state directory. The default is `octogee`. |
| `--skip-build` | Reuse the images from the last build. |
| `--images=<a,b>` | Build only these platform images. |
| `--context-dir=<dir>` | Build from another platform tree. |
| `--openclaw-dir=<dir>` | Take the OpenClaw build from local files instead of downloading it. The files keep their release names. |

To use kubectl against the cluster, always name its kubeconfig and context:

```bash
STATE=~/.local/state/octogee-kind/octogee
kubectl --kubeconfig="$STATE/kubeconfig" --context=kind-octogee -n octogee-local get pods
```

## Operate the fleet

The fleet command line, [octogee-fleet](https://github.com/octogee-ai/octogee-fleet),
talks to the Admin API. On kind it signs in with the operator key that the
script generated. The fleet controller trusts the matching public key
(`FLEET_OPERATOR_PUBLIC_KEY`), and `scripts/ops/operator-token.mjs` signs a token
that lasts ten minutes.

Forward the Admin API:

```bash
kubectl --kubeconfig="$STATE/kubeconfig" --context=kind-octogee -n octogee-local \
  port-forward svc/glm-controller 18080:8080
```

The script writes a configuration for the command line to
`$STATE/fleet-config.json`. Point the command line at it:

```bash
export OCTOGEE_FLEET_CONFIG="$STATE/fleet-config.json"
octogee-fleet --env=kind gateway ls
```

The platform adds no shared gateway on its own. Add one on the platform's build,
then wait until its status is `ready`:

```bash
octogee-fleet --env=kind gateway add --id=shared-a --apply
octogee-fleet --env=kind gateway ls
```

The gateway boots against the platform API, so the API must be running first.

## Users

Add a user, then place them on the shared gateway. The platform does not place
users on its own; until you assign one, the fleet controller logs that the user
has no gateway.

```bash
octogee-fleet --env=kind user add lin --email=lin@example.com --apply
octogee-fleet --env=kind user assign lin --to=shared-a --apply
octogee-fleet --env=kind user inspect lin
```

When `user inspect` shows provisioning `complete` and the user mounted on
`shared-a`, the user has:

- a Mattermost team named after them, with a `lin-general` channel and a
  private `lin-coach` channel shared with their agent;
- a Gitea organization named after them, with a `workspace` repository.

To sign in to Mattermost and Gitea as the user, issue their passwords:

```bash
octogee-fleet --env=kind user issue-passwords lin --apply
```

## Agent replies need a model key

The shared gateway starts without a model provider key. The agent cannot reply
until the gateway has a key of your own.

## Differences from a cloud cluster

- kind has no gVisor runtime. Gateways run on the node's default runtime, with
  `runtimeClassName` set to an empty value.
- The kind node carries the `topology.kubernetes.io/zone` and
  `topology.kubernetes.io/region` labels that the gateway's topology spread
  needs.
- Mattermost runs on the node's architecture. Its prepackaged plugins are built
  for amd64 only, so on an arm64 machine they do not start.
- The gateway fleet's network policies are off.

## Remove everything

```bash
scripts/ops/kind-install.sh down
```

This deletes the cluster, the local registry and the state directory. The
dedicated builder `octogee-cloud-kind` stays, with its cache; remove it with
`docker buildx rm octogee-cloud-kind`.

## Images from GitHub

The Build main workflow (`.github/workflows/build-main.yml`) builds the same
images for `linux/amd64` and `linux/arm64` on every push to `main`. It pushes
them to `ghcr.io/octogee-ai/octogee-cloud/<image>`, tagged with the full and
short commit SHA, and keeps an image manifest of every digest as a workflow
artifact named `image-manifest-<sha>`.

The workflow keeps its build cache in GitHub Actions cache scopes named
`octogee-cloud-<image>-<platform>`. It never reads or writes a registry cache,
and no other build may share its cache. Before an image is tagged, the workflow
checks that every compiled module in it has a source file in this repository,
and that no file in it sits under a `product` path.

Run the same check against the images on your machine:

```bash
node scripts/ci/cloud-build.mjs tripwire --registry=localhost:5001/octogee \
  --digests="$STATE/digests.json" --root=.
```
