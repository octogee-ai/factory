# The full platform on kind

This guide installs the whole platform on a local [kind](https://kind.sigs.k8s.io/)
cluster. It needs no cloud account. One script starts the cluster, puts the
platform images in a local registry and installs everything with Helm. It
copies the images this repository publishes, or builds them from your checkout.
For the smaller local foundation that `install.sh` sets up, see
[Getting started](getting-started.md).

The cluster runs:

- PostgreSQL, for platform state, Mattermost, Gitea and the agent stores;
- SeaweedFS, as the S3 blob store;
- Mattermost, for chat;
- Gitea, for git;
- the fleet controller, with its Admin API;
- the gateway edge;
- the platform API;
- the LLM broker, which holds the model provider keys;
- a shared gateway, once you add one.

## What you need

- Docker, with at least 8 CPUs and 12 GB of memory for its VM
- kind, kubectl and Helm (tested with kind 0.33, kubectl 1.36 and Helm 4.3)
- Node.js 24
- openssl, ssh-keygen and git
- Go, to install the `octogee-fleet` command line
- a model provider key, so agents can reply. The script will not install
  without one. OpenRouter is recommended; [Model provider keys](#model-provider-keys)
  says where to get each one

## Model provider keys

Agents need a model provider key, so the script stops before it creates
anything if you export none and the cluster stores none. Export one of these in
the terminal where you run the script. It sets the agents' models from the key,
as described under [Agent models](#agent-models).

### OpenRouter (recommended)

Create a key at <https://openrouter.ai/keys> and add credit to the account.
Export it as `OPENROUTER_API_KEY`. Agents use `platform-openrouter/meta/muse-ember`
and fall back to `platform-openrouter/openai/gpt-6-luna`, which is also the
house model. One OpenRouter key also reaches the other providers' models in the
platform catalog, such as Grok.

### OpenAI

Create a key at <https://platform.openai.com/api-keys>. Export it as
`OPENAI_API_KEY`. Agents use `platform-openai/gpt-6.1-terra` and fall back to
`platform-openai/gpt-6-luna`, which is also the house model.

### Anthropic

Create a key at <https://platform.claude.com/settings/keys>. Export it as
`ANTHROPIC_API_KEY`. Agents use `anthropic/claude-sonnet-5` and fall back to
`anthropic/claude-haiku-4-5`, which is also the house model.

### Muse

Muse Ember is the default agent model with an OpenRouter key, so that key is
all it needs. The platform catalog also lists Meta's own `muse-ember-1.0`, but
shared gateways do not route to Meta directly, so the script takes no Meta key.

### Grok

Grok runs through OpenRouter as `platform-openrouter/x-ai/grok-4.6`. With an
OpenRouter key, make it the agent model with the round-trip check's `--model`
option, described under [Agent models](#agent-models).

## Install

Clone the repository and run the script from its root:

```bash
git clone https://github.com/octogee-ai/octogee-cloud.git
```

```bash
cd octogee-cloud
```

Export your model provider key in the same terminal. The script reads
`OPENROUTER_API_KEY`, `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` and needs at
least one. It stores any of these your shell already exports, and names each
one it stores, so unset a key you do not want in the cluster. `read -s` keeps
the key out of your shell history:

```bash
read -rs OPENROUTER_API_KEY && export OPENROUTER_API_KEY
```

```bash
scripts/ops/kind-install.sh up --pull
```

`--pull` copies the images that the Build main workflow published for your
checkout's commit, described under [Images from GitHub](#images-from-github).
Build main finishes about 15 minutes after a commit reaches `main`, and a newer
push to `main` cancels a run that is still going, so a commit can end up with
no images at all. Until its images exist, or on a commit that is not on `main`,
name a `main` commit that has images. The Helm chart and the install steps
still come from your checkout, so pick the commit nearest to it. This prints the
newest `main` commit whose Build main succeeded:

```bash
gh run list -R octogee-ai/octogee-cloud --workflow=build-main.yml --branch=main \
  --status=success --limit=1 --json headSha --jq '.[0].headSha'
```

```bash
scripts/ops/kind-install.sh up --pull --sha=<full commit SHA>
```

To build the images from your checkout instead, leave out `--pull`. The gateway
image is large. The builder's cache grows to about 25 GB across the platform
images, and later builds reuse it.

```bash
scripts/ops/kind-install.sh up
```

The script:

1. checks for a model provider key, exported or stored in the cluster, and
   stops before it changes anything if there is none;
2. starts a local image registry on `localhost:5001`;
3. creates the kind cluster `octogee` with its own kubeconfig, so your current
   kubectl context does not change. kind reports that it set the context
   `kind-octogee`; it set it only in that kubeconfig;
4. with `--pull`, copies each published image kind runs, for your machine's
   architecture, into the local registry, keeping its digest;
5. without `--pull`, downloads the pinned OpenClaw build, checks its sha256
   against `infra/gateway/openclaw-tarball/current.json`, builds the platform
   images for your machine's architecture with a dedicated BuildKit builder,
   and pushes them to the local registry;
6. generates every secret: database passwords, the secret store root key, the
   S3 keys, the fleet signing keys, the operator key, and the Mattermost and
   Gitea admin credentials, and stores each provider key you exported in a
   Secret of its own;
7. installs PostgreSQL and SeaweedFS, then the Helm chart in `helm/octogee`;
8. points agents at models of a provider whose key it stores, described under
   [Agent models](#agent-models);
9. creates the Mattermost admin, its access token and the `octogee` team, and
   the Gitea admin, its token and the `octogee` organization;
10. restarts the platform so it reads those tokens and keys, and waits for the
    fleet controller.

Run it again at any time. Each step checks what exists, and secrets are kept
between runs.

The script keeps its state in `~/.local/state/octogee-kind/<name>`, or under
`$XDG_STATE_HOME` if you set it. `<name>` is the cluster name: `octogee` unless
you pass `--name`. To keep the state elsewhere, set `OCTOGEE_KIND_STATE` to a
parent folder; the state then goes in `$OCTOGEE_KIND_STATE/<name>`. It holds
the kubeconfig, the generated secrets and the image digests.

Keep to one install per host. Every cluster name shares the local registry on
port 5001, and every install's fleet configuration expects the Admin API on
port 18080.

| Flag | Effect |
| --- | --- |
| `--name=<name>` | Name of the cluster and of its state directory. The default is `octogee`. |
| `--pull` | Copy the images that Build main published for the checkout's commit instead of building them. |
| `--sha=<sha>` | With `--pull`, copy the images published for this full commit SHA. |
| `--manifest=<file>` | With `--pull`, copy the exact image digests from an extracted Build main manifest. Its SHA must match the selected commit. |
| `--skip-build` | Reinstall the images from the last build or copy, under that commit. |
| `--images=<a,b>` | Build or copy only these platform images. The default is every image kind runs, which leaves out `octogee-gateway-builder` and `vm-bridge`. Name either one to add it; the isolated gateway image exists only for amd64. |
| `--context-dir=<dir>` | Build from another platform tree. |
| `--openclaw-dir=<dir>` | Take the OpenClaw build from local files instead of downloading it. The files keep their release names. |

To use kubectl against the cluster, always name its kubeconfig and context.
`STATE` is the state directory. `up` ends by printing the line that sets it,
and `scripts/ops/kind-install.sh status` prints it again. With the default name
and location:

```bash
STATE=~/.local/state/octogee-kind/octogee
kubectl --kubeconfig="$STATE/kubeconfig" --context=kind-octogee -n octogee-local get pods
```

## Operate the fleet

The fleet command line, [octogee-fleet](https://github.com/octogee-ai/octogee-fleet),
talks to the Admin API. Install it with Go:

```bash
go install github.com/octogee-ai/octogee-fleet@latest
```

Go downloads the newer Go version the command line needs if yours is older, and
puts the program in `$(go env GOPATH)/bin`, usually `~/go/bin`. Add that folder
to your `PATH` if your shell cannot find `octogee-fleet`.

On kind the command line signs in with the operator key that the script
generated. The fleet controller trusts the matching public key
(`FLEET_OPERATOR_PUBLIC_KEY`), and `scripts/ops/operator-token.mjs` signs a token
that lasts ten minutes. The script writes a configuration for the command line
to `$STATE/fleet-config.json`. It runs `scripts/ops/operator-token.mjs` from
this checkout by its full path, so keep the checkout where it is while you use
the cluster.

A new terminal has neither `STATE` nor `OCTOGEE_FLEET_CONFIG`, so set both in
every terminal you open for the cluster. `status` prints both lines with your
path; with the defaults they are:

```bash
export STATE=~/.local/state/octogee-kind/octogee
export OCTOGEE_FLEET_CONFIG="$STATE/fleet-config.json"
```

The command line reaches the Admin API through a port-forward that must keep
running. Open a second terminal, set the two variables there, and start it:

```bash
kubectl --kubeconfig="$STATE/kubeconfig" --context=kind-octogee -n octogee-local \
  port-forward svc/glm-controller 18080:8080
```

Leave it running. In your first terminal, check that the command line reaches
the Admin API:

```bash
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

- a Mattermost account `lin` and a team named after them, shown as lin's
  Workspace, with the private channels General (`lin-general`) and Coach
  (`lin-coach`); their agent, the bot `lin-coach`, is in both;
- a Gitea account `ws-lin` and an organization `lin`, with a `workspace`
  repository and an empty `system_config` repository.

A user on a shared gateway works with their agent through Mattermost and Gitea.
The OpenClaw Control UI is for users on an isolated gateway, and kind runs only
shared gateways, so `/ui` in Mattermost answers that the Control UI is for
isolated gateways only.

## Sign in to Mattermost and Gitea

Issue the user's passwords. The command prints a chat password and a git
password once and keeps no copy:

```bash
octogee-fleet --env=kind user issue-passwords lin --apply
```

The chat username is `lin`. The git username is `ws-lin`, with a `ws-` prefix.
Run the command again if a password is lost; it replaces both.

Neither service has an ingress on kind. Forward each one in a terminal of its
own, with `STATE` set, and leave it running:

```bash
kubectl --kubeconfig="$STATE/kubeconfig" --context=kind-octogee -n octogee-local \
  port-forward svc/mattermost 8065:8065
```

```bash
kubectl --kubeconfig="$STATE/kubeconfig" --context=kind-octogee -n octogee-local \
  port-forward svc/octogee-gitea-http 3000:3000
```

Mattermost is then at <http://localhost:8065> and Gitea at
<http://localhost:3000>. Gitea asks for a new password at the first sign-in.
Mattermost does not, so change the chat password under **Profile > Security**.
The user's workspace clones over the same port-forward, with the username
`ws-lin` and the git password:

```bash
git clone http://localhost:3000/lin/workspace.git
```

Both services keep their in-cluster addresses as their configured URLs, for
example `http://octogee-gitea-http.octogee-local.svc.cluster.local:3000`. Your
machine cannot resolve those names. Pages you open through a port-forward use
`localhost`, but if a link takes you to an in-cluster address, open the same
path on `localhost` with that service's port.

## Talk to the agent

Open the Coach channel in Mattermost and send a message. The agent answers in
a thread under it, so the channel shows `1 reply` below your message.

`kubectl port-forward` stops when a forwarded connection resets, which
Mattermost's websocket can do, and prints `lost connection to pod`. Start the
port-forward again if the page stops loading.

On a shared gateway, an agent reaches its model provider through the LLM broker.
The broker holds the provider keys and gives each agent a token of its own, so
no provider key sits in a gateway pod. It records every model call, with its
tokens and cost, in the platform database.

The script keeps each key you export in its own Secret: `octogee-openrouter`,
`octogee-anthropic` or `octogee-openai`. It passes the key to kubectl through a
file descriptor, so the key never appears in a command line, the Helm values or
the state directory. A provider whose key you never exported has no Secret, and
the broker refuses calls to it. To add or replace a key, export it and run `up`
again; the script restarts the broker so it reads the new key. A rerun needs no
export while the cluster stores a key.

### Agent models

The platform's built-in agent model and house model are OpenAI models. Without
an OpenAI key, each turn fails at OpenAI several times before it tries the
fallback. So the script sets the platform's agent model, its fallback and the
house model to models of a provider whose key it stores, listed under
[Model provider keys](#model-provider-keys).

With more than one key stored, it uses the first of OpenRouter, Anthropic and
OpenAI. It names the models it sets, and sets them again on each `up`, so they
follow the keys you store. Agents of users who are already mounted switch at
the fleet controller's next pass. Models that something else set, such as
`kind-agent-round-trip.mjs --model`, stay as they are; the script says it kept
them.

`scripts/ops/kind-agent-round-trip.mjs` checks the whole path in one command.
It adds the shared gateway `shared-a` and the user `lin` if they are missing,
issues `lin` new passwords, signs in to Mattermost as `lin`, sends one message in
`lin-coach` and waits up to five minutes for the agent's reply. It then checks
that the broker recorded a successful model call for `lin` in the platform
database. It starts its own port-forwards, so it needs none of yours:

```bash
node scripts/ops/kind-agent-round-trip.mjs --state="$STATE" \
  --model=platform-openrouter/meta/muse-ember
```

`--model` first sets the platform's default agent model and house model to that
catalog model, with no fallback, and the check then requires a call to it. The
setting stays on the cluster, and later runs of `up` keep it. Without
`--model`, any successful call passes.

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

This deletes the cluster and the state directory. It also deletes the local
registry, unless another kind cluster still pulls from it. A build
without `--pull` creates the dedicated builder `octogee-cloud-kind`. It stays,
with its cache; remove it with `docker buildx rm octogee-cloud-kind`.

## Images from GitHub

The Build main workflow (`.github/workflows/build-main.yml`) builds the same
images for `linux/amd64` and `linux/arm64` on every push to `main`, together
with the two that only an install with isolated gateways runs: the VM bridge
(`vm-bridge`) for both architectures, and the isolated gateway image
(`octogee-gateway-builder`) for `linux/amd64` only. Isolated gateways run only
on Google Cloud VMs, and that image's toolchain is built for x86_64. The
workflow pushes every image to `ghcr.io/octogee-ai/octogee-cloud/<image>`,
tagged with the full and short commit SHA, and keeps an image manifest of every
digest as a workflow artifact named `image-manifest-<sha>`. The manifest lists
each image's platforms. `kind-install.sh up --pull` installs
these images. The post-build kind smoke test takes the amd64 digests directly
from that run’s manifest and uses `octogee-fleet gateway ls` to query the new
cluster’s Admin API. It then runs `kind-agent-round-trip.mjs` with Muse Ember on
OpenRouter, so one user's agent replies through the LLM broker with a real
provider key. The job runs in the `agent-round-trip` environment, which only
`main` can use; the installer stores the environment's `OPENROUTER_API_KEY`
secret in the cluster. Pull requests never run this workflow.

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

### Verify published images

The Build main workflow records provenance for each multi-platform image and
each platform digest. To verify an image, use its `image` reference from the
workflow's `image-manifest-<sha>` artifact:

```bash
image=$(jq -er '.images["octogee-gateway"].image' image-manifest.json)
gh attestation verify "oci://$image" --repo octogee-ai/octogee-cloud \
  --signer-workflow octogee-ai/octogee-cloud/.github/workflows/build-main.yml \
  --source-ref refs/heads/main
```

The `image-security-*` artifacts include the source manifest, one Trivy JSON
report, and one CycloneDX SBOM per image for the named architecture. Findings
are reported in the run summary and do not fail publication. Scanner errors,
missing digests, or missing reports fail the scan job. The weekly scan reuses
the latest published Build main manifest from a push to `main` and uses current
vulnerability data.
