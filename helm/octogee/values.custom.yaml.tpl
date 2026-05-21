# ── Custom Namespace Overrides (template) ──────────────────────────────────
# Rendered by scripts/provision-namespace.sh into values.${NAMESPACE}.yaml.
# Placeholders (all lowercase): __NAMESPACE__, __DB_SLUG__
#
# Design: custom namespaces are internal-only, share the octogee-test Firebase
# project, have no public ingress, no Cloud Armor, no preview host. Access is
# via `kubectl port-forward`. Cheap, isolated, and disposable.

cloud-sql-proxy:
  usePrivateIp: true

mattermost:
  image:
    repository: mattermost/mattermost-team-edition
    tag: "release-11.5"
  db:
    name: mattermost___DB_SLUG__
  siteUrl: "http://mattermost.__NAMESPACE__.svc.cluster.local:8065"
  allowedInternalConnections: "octogee-gateway.__NAMESPACE__.svc.cluster.local"
  pvc:
    size: 5Gi
  resources:
    limits:
      memory: "1Gi"

gitea:
  gitea:
    config:
      database:
        NAME: gitea___DB_SLUG__
      server:
        # Internal-only — no DNS, no public access. Use port-forward.
        DOMAIN: "octogee-gitea-http.__NAMESPACE__.svc.cluster.local"
        ROOT_URL: "http://octogee-gitea-http.__NAMESPACE__.svc.cluster.local:3000"
  persistence:
    storageClass: standard-rwo
    size: 10Gi
  resources:
    requests:
      cpu: 50m
      memory: 128Mi
    limits:
      cpu: 200m
      memory: 256Mi

chat-proxy:
  cloudArmor:
    enabled: false
  image:
    repository: us-central1-docker.pkg.dev/octogee/octogee/octogee-chat-proxy
  env:
    # Internal-only namespaces have no public MM ingress; the mint endpoint
    # still returns a URL but custom envs don't drive a real browser flow.
    # Port-forward to mattermost:8065 directly when testing locally.
    MM_PUBLIC_URL: "http://mattermost.__NAMESPACE__.svc.cluster.local:8065"
    FIREBASE_PROJECT: "octogee-test"
  ingress:
    enabled: false

gateway-edge:
  cloudArmor:
    enabled: false
  image:
    repository: us-central1-docker.pkg.dev/octogee/octogee/gateway-edge
  env:
    FIREBASE_PROJECT_ID: "octogee-test"
    GCLOUD_PROJECT: "octogee-test"
    APP_URL: "https://octogee-test.web.app"
    CHAT_PROXY_URL: "http://chat-proxy.__NAMESPACE__.svc.cluster.local:8080"
    SITE_URL: "https://octogee-test.web.app"
    K8S_NAMESPACE: "__NAMESPACE__"
  ingress:
    enabled: false

gateway:
  cloudArmor:
    enabled: false
  preview:
    enabled: false
  image:
    repository: us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway
  env:
    gcloudProject: "octogee-test"
    firebaseProjectId: "octogee-test"
    githubOrg: "octogee-test"
    mmUrl: ""  # auto-computed from release namespace
    chatProxyUrl: "http://chat-proxy.__NAMESPACE__.svc.cluster.local:8080"
  resources:
    limits:
      ephemeral-storage: "10Gi"

serviceAccount:
  gcpServiceAccount: "octogee-gateway@octogee-test.iam.gserviceaccount.com"
