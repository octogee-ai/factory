# ── Custom Namespace Overrides (template) ──────────────────────────────────
# Rendered by scripts/provision-namespace.sh into values.${NAMESPACE}.yaml.
# Placeholders are rendered from the selected TEST deployment target.
#
# Design: custom namespaces are internal-only, share the octogee-test Firebase
# project, have no public ingress, no Cloud Armor, no preview host. Access is
# via `kubectl port-forward`. Cheap, isolated, and disposable.

global:
  deploymentTargetId: "__TARGET_ID__"
  deploymentProjectId: "__FIREBASE_PROJECT__"

npmCacheProxy:
  enabled: false

cloud-sql-proxy:
  connectionName: "__CLOUD_SQL_CONNECTION__"
  usePrivateIp: true

mattermost:
  image:
    repository: us-central1-docker.pkg.dev/octogee/octogee/mattermost
    tag: "11.11.0-octogee-e749bbd1"
    digest: "sha256:75ddaf3298a2f0d944b36b07c4e7ff04a897097ce1d9805e87b22cb99d90d709"
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
    repository: __AR_REPOSITORY__/gateway-edge
  env:
    FIREBASE_PROJECT_ID: "__FIREBASE_PROJECT__"
    GCLOUD_PROJECT: "__FIREBASE_PROJECT__"
    APP_URL: "https://app-test.octogee.com"
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
  image:
    repository: __AR_REPOSITORY__/octogee-api
  gatewayServiceAccount: octogee-gateway@__FIREBASE_PROJECT__.iam.gserviceaccount.com
  serviceAccount:
    annotations:
      iam.gke.io/gcp-service-account: octogee-api@__FIREBASE_PROJECT__.iam.gserviceaccount.com
  env:
    OCTOGEE_KMS_KEY_NAME: "__KMS_KEY_NAME__"
    API_PUBLIC_URL: "https://octogee-test.web.app"
    MM_INTERNAL_URL: "http://mattermost.__NAMESPACE__.svc.cluster.local:8065"

gateway:
  cloudArmor:
    enabled: false
  preview:
    enabled: false
  image:
    repository: __AR_REPOSITORY__/octogee-gateway
  env:
    gcloudProject: "__FIREBASE_PROJECT__"
    firebaseProjectId: "__FIREBASE_PROJECT__"
    githubOrg: "__FIREBASE_PROJECT__"
    mmUrl: ""  # auto-computed from release namespace
  resources:
    limits:
      ephemeral-storage: "10Gi"

serviceAccount:
  gcpServiceAccount: "octogee-gateway@__FIREBASE_PROJECT__.iam.gserviceaccount.com"

glm-controller:
  image:
    repository: __AR_REPOSITORY__/glm-controller
  gcpServiceAccount: octogee-glm-controller@__FIREBASE_PROJECT__.iam.gserviceaccount.com
  gatewayServiceAccount: octogee-gateway@__FIREBASE_PROJECT__.iam.gserviceaccount.com
  workloadIdentityProject: "__CLUSTER_PROJECT__"
  kmsKeyName: "__KMS_KEY_NAME__"
  platformRelease:
    gatewayImageRepository: __AR_REPOSITORY__/octogee-gateway
    gatewayEdgeImageRepository: __AR_REPOSITORY__/gateway-edge

llmBroker:
  image:
    repository: __AR_REPOSITORY__/octogee-api
  gcpServiceAccount: octogee-llm-broker@__FIREBASE_PROJECT__.iam.gserviceaccount.com

artifactWorker:
  image:
    repository: __AR_REPOSITORY__/artifact-worker

opsAgent:
  image:
    repository: __AR_REPOSITORY__/octogee-ops-agent
  gcpServiceAccount: octogee-ops-agent@__FIREBASE_PROJECT__.iam.gserviceaccount.com
  loggingProjectId: __CLUSTER_PROJECT__
  loggingResourceName: projects/__CLUSTER_PROJECT__/locations/global/buckets/ops-agent-test/views/ops-agent
  appUrl: https://app-test.octogee.com
