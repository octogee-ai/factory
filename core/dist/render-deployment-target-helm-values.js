#!/usr/bin/env node
import { isDeploymentTargetResolverEntrypoint, resolveDeploymentTargetArguments, } from "./resolve-deployment-target.js";
function quoted(value) {
    return JSON.stringify(value);
}
export function renderDeploymentTargetHelmValues(settings) {
    const registry = settings.artifactRegistryRepository;
    const dataProject = settings.firebaseProjectId;
    const mattermostInternalUrl = `http://mattermost.${settings.namespace}.svc.cluster.local:8065`;
    const opsAgentLoggingResourceName = `projects/${settings.clusterProjectId}/locations/global/buckets/ops-agent-${settings.secretNameSuffix}/views/ops-agent`;
    const iapOAuthClientCredentialsSecretName = settings.region === "us-west1"
        ? ""
        : "iap-oauth-credentials";
    const networkBoundary = settings.networkBoundary;
    return `global:
  deploymentTargetId: ${quoted(settings.targetId)}
  deploymentProjectId: ${quoted(dataProject)}
  customerHostingProjectId: ${quoted(settings.customerHostingProjectId)}
  projectRunnerImage:
    repository: ${quoted(`${registry}/octogee-project-runner`)}
projectRunner:
  apiServerEgressCidrs: ${JSON.stringify(settings.projectRunnerApiServerEgressCidrs)}
networkPolicy:
  enforceDefaultDeny: ${networkBoundary !== undefined}
  controlPlaneCidr: ${quoted(networkBoundary?.controlPlaneCidr ?? "")}
  privateServicesCidr: ${quoted(networkBoundary?.privateServicesCidr ?? "")}
cloud-sql-proxy:
  connectionName: ${quoted(settings.cloudSqlConnectionName)}
edgeIngress:
  staticIpName: ${quoted(settings.edgeStaticIpName)}
gateway-edge:
  ingress:
    staticIpName: ${quoted(settings.edgeStaticIpName)}
  image:
    repository: ${quoted(`${registry}/gateway-edge`)}
mattermost:
  ingress:
    staticIpName: ${quoted(settings.mattermostStaticIpName)}
    iap:
      oauthClientCredentialsSecretName: ${quoted(iapOAuthClientCredentialsSecretName)}
gitea:
  webIngress:
    staticIpName: ${quoted(settings.giteaStaticIpName)}
    iap:
      oauthClientCredentialsSecretName: ${quoted(iapOAuthClientCredentialsSecretName)}
gatewayFleet:
  previewIngress:
    staticIpName: ${quoted(settings.previewStaticIpName)}
octogee-api:
  image:
    repository: ${quoted(`${registry}/octogee-api`)}
  serviceAccount:
    annotations:
      iam.gke.io/gcp-service-account: ${quoted(`octogee-api@${dataProject}.iam.gserviceaccount.com`)}
  gatewayServiceAccount: ${quoted(`octogee-gateway@${dataProject}.iam.gserviceaccount.com`)}
  env:
    MM_URL: ${quoted(mattermostInternalUrl)}
    MM_INTERNAL_URL: ${quoted(mattermostInternalUrl)}
    OCTOGEE_KMS_KEY_NAME: ${quoted(settings.kmsKeyName)}
llmBroker:
  image:
    repository: ${quoted(`${registry}/octogee-api`)}
  gcpServiceAccount: ${quoted(`octogee-llm-broker@${dataProject}.iam.gserviceaccount.com`)}
artifactWorker:
  image:
    repository: ${quoted(`${registry}/artifact-worker`)}
opsAgent:
  image:
    repository: ${quoted(`${registry}/octogee-ops-agent`)}
  gcpServiceAccount: ${quoted(`octogee-ops-agent@${dataProject}.iam.gserviceaccount.com`)}
  loggingProjectId: ${quoted(settings.clusterProjectId)}
  loggingResourceName: ${quoted(opsAgentLoggingResourceName)}
serviceAccount:
  gcpServiceAccount: ${quoted(`octogee-gateway@${dataProject}.iam.gserviceaccount.com`)}
glm-controller:
  image:
    repository: ${quoted(`${registry}/glm-controller`)}
  gcpServiceAccount: ${quoted(`octogee-glm-controller@${dataProject}.iam.gserviceaccount.com`)}
  kmsKeyName: ${quoted(settings.kmsKeyName)}
  gatewayServiceAccount: ${quoted(`octogee-gateway@${dataProject}.iam.gserviceaccount.com`)}
  workloadIdentityProject: ${quoted(settings.clusterProjectId)}
  bootstrapDefaultGateway:
    imageRepository: ${quoted(`${registry}/octogee-gateway`)}
`;
}
if (isDeploymentTargetResolverEntrypoint(import.meta.url, process.argv[1])) {
    try {
        process.stdout.write(renderDeploymentTargetHelmValues(resolveDeploymentTargetArguments(process.argv.slice(2))));
    }
    catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    }
}
