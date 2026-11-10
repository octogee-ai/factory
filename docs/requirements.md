# Requirements

What you need on your workstation, and what the platform needs from wherever
it runs. Your workstation only drives the install. Everything runs in Docker or
on a cloud cluster.

## On your workstation

The installer checks all of this and prints the install command for your system.

| Your machine | Tested | Notes |
| --- | --- | --- |
| macOS on Apple Silicon | Full local install | Mattermost has no ARM image, so it runs emulated |
| Arch Linux, the base of Omarchy | Full local install in an Arch container, using Arch's own packages | Not yet run on Omarchy itself |
| Windows with WSL2 | Checks only, in an Ubuntu container | Run everything inside the WSL2 distribution |

| Tool | Tested version | Needed for |
| --- | --- | --- |
| Docker | Engine 29.9 | Local installs |
| kind | 0.33 | Local installs |
| kubectl | 1.36 | Every install |
| Helm | 4.3 | Every install |
| Git, curl, OpenSSL | Any recent version | Every install |
| gcloud and `gke-gcloud-auth-plugin` | 592 | Google Cloud |
| AWS CLI and eksctl | Not yet run | AWS |
| Node.js | 24.22 | Only for working on the code |

The local install was tested with 10 CPUs and 16 GB of memory available to
Docker. The installer warns below 8 GB. On Docker Desktop, set these under
**Settings > Resources**. On Linux, Docker uses the whole machine.

Local installs on Linux may need higher file watch limits. The installer prints
the command if yours are low.

## What the platform needs

| Need | Recommended in Docker | Recommended in the cloud | Also works |
| --- | --- | --- | --- |
| Kubernetes | kind | GKE, EKS or another managed cluster | k3s on your own VMs |
| PostgreSQL 16 with `vector`, `unaccent` and `pg_trgm` | `pgvector` container | Your cloud's managed PostgreSQL | CloudNativePG |
| S3-compatible storage | SeaweedFS | Your cloud's object storage | Ceph, Garage |
| Git host | Gitea | Gitea | Others through a `GitHost` adapter |
| Chat | Mattermost Team Edition | Mattermost Team Edition | Slack, Discord and others through a `ChannelHost` adapter |
| Ingress | Traefik | Traefik | Envoy Gateway |
| TLS and DNS | None; uses `*.localhost` | cert-manager with records you create | ExternalDNS, your provider's own |
| Agent runtime | OpenClaw gateway | OpenClaw gateway | |
| Model access | Your own API key | Your own API key | Any provider OpenClaw supports |

Docker runs Kubernetes because the fleet controller installs gateways with
Helm, so both paths use the same charts. [Running in production](running-in-the-cloud.md)
covers the managed path.

## Plug-in points

These are the parts you can replace. The fleet controller, API and edge have
not landed in this repository yet, so the seams in the table are planned.
OpenClaw's own options work today.

| Part | Default | Replace it with |
| --- | --- | --- |
| Chat | Mattermost | A `ChannelHost` adapter: Slack, Discord and others |
| Git host | Gitea | A `GitHost` adapter |
| Operator identity | Google sign-in | Other OIDC issuers later: Keycloak, Dex, Authentik, Zitadel, Okta, Entra |
| Control UI sign-in | OpenClaw's gateway token | OpenClaw's `trusted-proxy` mode behind Pomerium or oauth2-proxy |
| Startup secrets and the root key | Environment variables | OpenClaw `file` or `exec` secret references: Vault, OpenBao, 1Password |
| Secrets the platform creates | Encrypted rows in PostgreSQL | A Vault or OpenBao adapter |
| Encryption at rest | AES-256-GCM under the root key | Vault or OpenBao Transit |
| File storage | SeaweedFS over the S3 API | Any S3-compatible store |

An environment variable is an acceptable place for the root key on a personal
install. It is the one secret the default install needs. A database backup
together with that key exposes every stored secret, so keep them apart.

Secrets for individual users on a shared gateway always go through the broker,
because environment variables would put every user's key in one process.

## Sign-in for chat and git

Each host uses its own login. On the default hosts, Gitea supports OIDC at no
cost. Mattermost Team Edition has no single sign-on that we could confirm, and
it stops creating accounts at 250 activated users across the server. Bots do
not count. That limit is fine for a personal or small-team install, and a
larger one can use a different chat host through a `ChannelHost` adapter.

## Free to use, but not open source

| Tool | Terms | Use it? |
| --- | --- | --- |
| Docker Desktop | [Free for personal use and small businesses](https://docs.docker.com/subscription/desktop-license/); larger companies need a paid seat | Yes on macOS and Windows. Linux needs only Docker Engine, which is open source. [Rancher Desktop](https://rancherdesktop.io/) and [Colima](https://github.com/abiosoft/colima) are open-source alternatives we have not tested |
| HashiCorp Vault | Business Source License: free to self-host, including production use inside an organization | Yes, if you already run it. OpenClaw has a bundled Vault plugin |
| Terraform | Business Source License, same terms | Yes |
| MinIO AIStor Free | Free, single node only, commercial license | Works through the S3 adapter, but we do not ship it |
| Mattermost Entry | Free, commercial license, hides messages past the newest 10,000 | No; agent chat needs its history |

## Avoid

- **MinIO Community Edition.** The repository was archived in April 2026.
- **ingress-nginx.** The repository was archived in March 2026.
- **Bitnami images.** The free ones moved to an unpatched legacy repository.
  The Gitea chart can pull Bitnami subcharts for a bundled database and cache,
  so keep those options off, as `deploy/values/gitea.yaml` does.
