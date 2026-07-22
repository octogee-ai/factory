#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import type { DeploymentEnvironmentSettings } from "./deployment-environment.js";
import { resolveDeploymentTargetArguments } from "./resolve-deployment-target.js";

function quoted(value: string): string {
  return JSON.stringify(value);
}

export function renderDeploymentTargetHelmValues(
  settings: DeploymentEnvironmentSettings,
): string {
  const registry = settings.artifactRegistryRepository;
  const dataProject = settings.firebaseProjectId;
  const mattermostInternalUrl = `http://mattermost.${settings.namespace}.svc.cluster.local:8065`;
  const opsAgentLoggingResourceName = `projects/${settings.clusterProjectId}/locations/global/buckets/ops-agent-${settings.secretNameSuffix}/views/ops-agent`;
  return `global:
  deploymentTargetId: ${quoted(settings.targetId)}
  deploymentProjectId: ${quoted(dataProject)}
cloud-sql-proxy:
  connectionName: ${quoted(settings.cloudSqlConnectionName)}
gateway-edge:
  image:
    repository: ${quoted(`${registry}/gateway-edge`)}
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(
      renderDeploymentTargetHelmValues(
        resolveDeploymentTargetArguments(process.argv.slice(2)),
      ),
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
