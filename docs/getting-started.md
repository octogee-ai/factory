# Getting started

Try Octogee Cloud on your own machine in Docker, or install it for production
on managed cloud services. One installer handles both.

## Status

The fleet controller, API and edge have not moved into this repository yet.
Today the installer gives you the foundation they will run on: Kubernetes,
PostgreSQL, S3 storage, ingress, a Git host, chat, and one OpenClaw gateway you
can talk to. This guide will grow when the rest lands.

## Install

Run this from any shell. Your login shell can be zsh or anything else, because
the script itself runs in Bash.

```bash
curl -fsSL https://raw.githubusercontent.com/octogee-ai/octogee-cloud/main/install.sh | bash
```

The installer asks where to run, checks your machine, and tells you how to fix
anything missing. It then shows what it will create and asks before it creates
anything.

To read the script before you run it:

```bash
curl -fsSL https://raw.githubusercontent.com/octogee-ai/octogee-cloud/main/install.sh -o install.sh
```

```bash
bash install.sh
```

To check your machine without installing, or to run without questions:

```bash
bash install.sh --target=local --check-only
```

```bash
bash install.sh --target=local --yes --no-prompt
```

| Your machine | Where to run the installer |
| --- | --- |
| macOS | Any terminal, with Docker Desktop running |
| Linux, including Omarchy and other Arch systems | Any terminal, with Docker Engine running |
| Windows | Inside WSL2, not PowerShell or Git Bash |

[Requirements](requirements.md) lists the tools. The installer gives you the
install command for each one on your system.

### Windows

1. In PowerShell as Administrator, run `wsl --install`, then restart.
2. Install Docker Desktop. Under **Settings > Resources > WSL integration**,
   turn on your Ubuntu distribution.
3. Open Ubuntu and run the install command there.

Keep the checkout in your Linux home folder, which is the default. Files under
`/mnt/c` are slow and lose their permissions.

## Use it

The local install takes five to ten minutes the first time, mostly downloading
images. When it finishes:

1. Open <http://chat.localhost:8088>.
2. Sign in as `platformadmin`. Get the password from your checkout:

   ```bash
   ./deploy/local/credentials.sh
   ```

3. Send a direct message to `@agent`.

The agent needs a model key to answer. If one is exported in your shell, the
installer lists it before you confirm and copies it into the cluster. Without
one, the agent answers with a sign-in error. To add a key later, run the install
recipe again with it set. It is safe to run repeatedly.

```bash
ANTHROPIC_API_KEY=your-key ./deploy/local/up.sh
```

It also reads `OPENAI_API_KEY`, `GEMINI_API_KEY` and `OPENROUTER_API_KEY`.

Git is at <http://git.localhost:8088> with the same username and password.

To open the OpenClaw Control UI, start a port-forward and go to
<http://localhost:18789>. The gateway token is in the output of
`credentials.sh`.

```bash
kubectl --kubeconfig ~/.kube/octogee-cloud-local -n octogee-cloud-local port-forward deploy/gateway 18789
```

Everything runs inside a kind cluster with its own kubeconfig at
`~/.kube/octogee-cloud-local`. The installer does not change your current
Kubernetes context. Only localhost can reach the ports.

Check the install at any time:

```bash
./deploy/local/check.sh
```

## Run in production

[Running in production](running-in-the-cloud.md) covers GKE and EKS with
managed PostgreSQL and object storage.

## Work on the code

You need Node.js 24 for this part. Nothing else here needs it.

```bash
git clone https://github.com/octogee-ai/octogee-cloud.git
```

```bash
cd octogee-cloud && npm ci
```

```bash
npx tsc --noEmit && npx vitest run && npm run gate
```

## Remove it

This deletes the local cluster and all of its data.

```bash
./deploy/local/down.sh
```
