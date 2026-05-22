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

gateway-edge:
  cloudArmor:
    enabled: false
  image:
    repository: us-central1-docker.pkg.dev/octogee/octogee/gateway-edge
  env:
    FIREBASE_PROJECT_ID: "octogee-test"
    GCLOUD_PROJECT: "octogee-test"
    APP_URL: "https://octogee-test.web.app"
    SITE_URL: "https://octogee-test.web.app"
    K8S_NAMESPACE: "__NAMESPACE__"
  ingress:
    enabled: false

# octogee-api defaults to PROD URLs in the subchart values; a custom
# namespace MUST override them or it would mint prod mmUrl values + proxy
# to prod Mattermost. MM_INTERNAL_URL is namespace-local; API_PUBLIC_URL
# has no public ingress here (port-forward for local testing), so the
# test app URL is the safe non-prod placeholder.
octogee-api:
  env:
    API_PUBLIC_URL: "https://octogee-test.web.app"
    MM_INTERNAL_URL: "http://mattermost.__NAMESPACE__.svc.cluster.local:8065"

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
  resources:
    limits:
      ephemeral-storage: "10Gi"

serviceAccount:
  gcpServiceAccount: "octogee-gateway@octogee-test.iam.gserviceaccount.com"
