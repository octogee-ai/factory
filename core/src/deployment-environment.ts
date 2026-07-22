import deploymentTargetsDocument from "./deployment-targets.json" with { type: "json" };

export type DeploymentEnvironment = "prod" | "test" | "build-week";
export type ResolvedDeploymentEnvironment = DeploymentEnvironment | "unknown";
export type DeploymentTargetLifecycle = "active" | "candidate" | "frozen";

interface ArtifactRegistryDocument {
  projectId: string;
  location: string;
  repository: string;
}

interface CloudSqlDocument {
  projectId: string;
  region: string;
  instance: string;
  mattermostPasswordSecret: string;
  giteaPasswordSecret: string;
  connectionNameSecret: string;
  pointInTimeRecoveryEnabled: boolean;
}

interface KmsDocument {
  projectId: string;
  location: string;
  keyRing: string;
  key: string;
}

interface StorageDocument {
  projectId: string;
  location: string;
}

interface DeploymentTargetDocument {
  environment: DeploymentEnvironment;
  promotionSourceTargetId?: string;
  lifecycle: DeploymentTargetLifecycle;
  secretNameSuffix: string;
  clusterProjectId: string;
  firebaseProjectId: string;
  hostingProjectId: string;
  region: string;
  clusterName: string;
  namespace: string;
  artifactRegistry: ArtifactRegistryDocument;
  cloudSql: CloudSqlDocument;
  kms: KmsDocument;
  storage: StorageDocument;
  siteOrigin: string;
  appOrigin: string;
  apiOrigin: string;
  gitOrigin: string;
  mattermostOrigin: string;
  previewOrigin: string;
  gatewayValuesFile: string;
  computeClass: string;
  pinEnvironment: string;
}

interface DeploymentTargetsDocument {
  schemaVersion: 1;
  activeTargets: Record<DeploymentEnvironment, string>;
  targets: Record<string, DeploymentTargetDocument>;
}

export interface DeploymentEnvironmentSettings {
  name: DeploymentEnvironment;
  promotionSourceTargetId?: string;
  targetId: string;
  lifecycle: DeploymentTargetLifecycle;
  secretNameSuffix: string;
  clusterProjectId: string;
  firebaseProjectId: string;
  hostingProjectId: string;
  region: string;
  clusterName: string;
  kubeContext: string;
  namespace: string;
  artifactRegistryProjectId: string;
  artifactRegistryLocation: string;
  artifactRegistryName: string;
  artifactRegistryRepository: string;
  cloudSqlProjectId: string;
  cloudSqlRegion: string;
  cloudSqlInstanceName: string;
  cloudSqlConnectionName: string;
  cloudSqlMattermostPasswordSecretName: string;
  cloudSqlGiteaPasswordSecretName: string;
  cloudSqlConnectionNameSecretName: string;
  cloudSqlPointInTimeRecoveryEnabled: boolean;
  kmsProjectId: string;
  kmsLocation: string;
  kmsKeyRing: string;
  kmsKey: string;
  kmsKeyName: string;
  storageProjectId: string;
  storageLocation: string;
  siteOrigin: string;
  appOrigin: string;
  apiOrigin: string;
  gitOrigin: string;
  mattermostOrigin: string;
  previewOrigin: string;
  gatewayValuesFile: string;
  computeClass: string;
  pinEnvironment: string;
}

const DEPLOYMENT_ENVIRONMENTS: DeploymentEnvironment[] = [
  "prod",
  "test",
  "build-week",
];
const TARGET_LIFECYCLES: DeploymentTargetLifecycle[] = [
  "active",
  "candidate",
  "frozen",
];
const TARGET_STRING_FIELDS = [
  "secretNameSuffix",
  "clusterProjectId",
  "firebaseProjectId",
  "hostingProjectId",
  "region",
  "clusterName",
  "namespace",
  "siteOrigin",
  "appOrigin",
  "apiOrigin",
  "gitOrigin",
  "mattermostOrigin",
  "previewOrigin",
  "gatewayValuesFile",
  "computeClass",
  "pinEnvironment",
] as const;

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, field: string, label: string): string {
  const fieldValue = value[field];
  if (typeof fieldValue !== "string" || fieldValue.length === 0) {
    throw new Error(`${label}.${field} must be a non-empty string`);
  }
  return fieldValue;
}

function stringFields(
  value: Record<string, unknown>,
  fields: readonly string[],
  label: string,
): void {
  for (const field of fields) {
    stringField(value, field, label);
  }
}

export function validateDeploymentTargetsDocument(document: unknown): asserts document is DeploymentTargetsDocument {
  const manifest = record(document, "deployment targets manifest");
  if (manifest.schemaVersion !== 1) {
    throw new Error("deployment targets manifest.schemaVersion must be 1");
  }

  const activeTargets = record(manifest.activeTargets, "deployment targets manifest.activeTargets");
  const targets = record(manifest.targets, "deployment targets manifest.targets");

  for (const environment of DEPLOYMENT_ENVIRONMENTS) {
    const targetId = stringField(
      activeTargets,
      environment,
      "deployment targets manifest.activeTargets",
    );
    if (!(targetId in targets)) {
      throw new Error(`Active deployment target does not exist: ${targetId}`);
    }
  }

  for (const [targetId, value] of Object.entries(targets)) {
    const target = record(value, `deployment target ${targetId}`);
    const environment = stringField(target, "environment", `deployment target ${targetId}`);
    if (!DEPLOYMENT_ENVIRONMENTS.includes(environment as DeploymentEnvironment)) {
      throw new Error(`deployment target ${targetId}.environment is invalid: ${environment}`);
    }
    if (environment === "prod") {
      stringField(target, "promotionSourceTargetId", `deployment target ${targetId}`);
    } else if (target.promotionSourceTargetId !== undefined) {
      throw new Error(
        `deployment target ${targetId}.promotionSourceTargetId is only valid for prod`,
      );
    }
    const lifecycle = stringField(target, "lifecycle", `deployment target ${targetId}`);
    if (!TARGET_LIFECYCLES.includes(lifecycle as DeploymentTargetLifecycle)) {
      throw new Error(`deployment target ${targetId}.lifecycle is invalid: ${lifecycle}`);
    }
    stringFields(target, TARGET_STRING_FIELDS, `deployment target ${targetId}`);
    stringFields(
      record(target.artifactRegistry, `deployment target ${targetId}.artifactRegistry`),
      ["projectId", "location", "repository"],
      `deployment target ${targetId}.artifactRegistry`,
    );
    const cloudSql = record(target.cloudSql, `deployment target ${targetId}.cloudSql`);
    stringFields(
      cloudSql,
      [
        "projectId",
        "region",
        "instance",
        "mattermostPasswordSecret",
        "giteaPasswordSecret",
        "connectionNameSecret",
      ],
      `deployment target ${targetId}.cloudSql`,
    );
    if (typeof cloudSql.pointInTimeRecoveryEnabled !== "boolean") {
      throw new Error(
        `deployment target ${targetId}.cloudSql.pointInTimeRecoveryEnabled must be a boolean`,
      );
    }
    stringFields(
      record(target.kms, `deployment target ${targetId}.kms`),
      ["projectId", "location", "keyRing", "key"],
      `deployment target ${targetId}.kms`,
    );
    stringFields(
      record(target.storage, `deployment target ${targetId}.storage`),
      ["projectId", "location"],
      `deployment target ${targetId}.storage`,
    );
  }

  for (const [targetId, value] of Object.entries(targets)) {
    const target = value as Record<string, unknown>;
    if (target.environment !== "prod") continue;
    const sourceTargetId = target.promotionSourceTargetId as string;
    const source = targets[sourceTargetId] as Record<string, unknown> | undefined;
    if (!source) {
      throw new Error(
        `deployment target ${targetId}.promotionSourceTargetId does not exist: ${sourceTargetId}`,
      );
    }
    if (source.environment !== "test") {
      throw new Error(
        `deployment target ${targetId}.promotionSourceTargetId must belong to test`,
      );
    }
  }

  for (const environment of DEPLOYMENT_ENVIRONMENTS) {
    const targetId = activeTargets[environment] as string;
    const target = targets[targetId] as Record<string, unknown>;
    if (target.environment !== environment) {
      throw new Error(`Active deployment target ${targetId} belongs to ${String(target.environment)}`);
    }
    const expectedLifecycle = environment === "build-week" ? "frozen" : "active";
    if (target.lifecycle !== expectedLifecycle) {
      throw new Error(`Active deployment target ${targetId} must be ${expectedLifecycle}`);
    }
  }
}

validateDeploymentTargetsDocument(deploymentTargetsDocument);

const MANIFEST = deploymentTargetsDocument as DeploymentTargetsDocument;

function settings(
  targetId: string,
  target: DeploymentTargetDocument,
): DeploymentEnvironmentSettings {
  return {
    name: target.environment,
    promotionSourceTargetId: target.promotionSourceTargetId,
    targetId,
    lifecycle: target.lifecycle,
    secretNameSuffix: target.secretNameSuffix,
    clusterProjectId: target.clusterProjectId,
    firebaseProjectId: target.firebaseProjectId,
    hostingProjectId: target.hostingProjectId,
    region: target.region,
    clusterName: target.clusterName,
    kubeContext: `gke_${target.clusterProjectId}_${target.region}_${target.clusterName}`,
    namespace: target.namespace,
    artifactRegistryProjectId: target.artifactRegistry.projectId,
    artifactRegistryLocation: target.artifactRegistry.location,
    artifactRegistryName: target.artifactRegistry.repository,
    artifactRegistryRepository: `${target.artifactRegistry.location}-docker.pkg.dev/${target.artifactRegistry.projectId}/${target.artifactRegistry.repository}`,
    cloudSqlProjectId: target.cloudSql.projectId,
    cloudSqlRegion: target.cloudSql.region,
    cloudSqlInstanceName: target.cloudSql.instance,
    cloudSqlConnectionName: `${target.cloudSql.projectId}:${target.cloudSql.region}:${target.cloudSql.instance}`,
    cloudSqlMattermostPasswordSecretName: target.cloudSql.mattermostPasswordSecret,
    cloudSqlGiteaPasswordSecretName: target.cloudSql.giteaPasswordSecret,
    cloudSqlConnectionNameSecretName: target.cloudSql.connectionNameSecret,
    cloudSqlPointInTimeRecoveryEnabled: target.cloudSql.pointInTimeRecoveryEnabled,
    kmsProjectId: target.kms.projectId,
    kmsLocation: target.kms.location,
    kmsKeyRing: target.kms.keyRing,
    kmsKey: target.kms.key,
    kmsKeyName: `projects/${target.kms.projectId}/locations/${target.kms.location}/keyRings/${target.kms.keyRing}/cryptoKeys/${target.kms.key}`,
    storageProjectId: target.storage.projectId,
    storageLocation: target.storage.location,
    siteOrigin: target.siteOrigin,
    appOrigin: target.appOrigin,
    apiOrigin: target.apiOrigin,
    gitOrigin: target.gitOrigin,
    mattermostOrigin: target.mattermostOrigin,
    previewOrigin: target.previewOrigin,
    gatewayValuesFile: target.gatewayValuesFile,
    computeClass: target.computeClass,
    pinEnvironment: target.pinEnvironment,
  };
}

const TARGETS = Object.fromEntries(
  Object.entries(MANIFEST.targets).map(([targetId, target]) => [
    targetId,
    settings(targetId, target),
  ]),
) as Record<string, DeploymentEnvironmentSettings>;

const ENVIRONMENTS = Object.fromEntries(
  DEPLOYMENT_ENVIRONMENTS.map((environment) => [
    environment,
    TARGETS[MANIFEST.activeTargets[environment]],
  ]),
) as Record<DeploymentEnvironment, DeploymentEnvironmentSettings>;

export const BUILD_WEEK_ENVIRONMENT = ENVIRONMENTS["build-week"];

export function deploymentEnvironmentSettings(
  environment: DeploymentEnvironment,
): DeploymentEnvironmentSettings {
  return ENVIRONMENTS[environment];
}

export function deploymentTargetSettings(targetId: string): DeploymentEnvironmentSettings {
  const target = TARGETS[targetId];
  if (!target) {
    throw new Error(`Unknown deployment target: ${targetId}`);
  }
  return target;
}

export function deploymentSettingsForRuntime(input: {
  namespace: string;
  targetId?: string;
}): DeploymentEnvironmentSettings {
  if (input.targetId !== undefined) {
    const target = deploymentTargetSettings(input.targetId);
    if (target.namespace !== input.namespace) {
      throw new Error(
        `Deployment target ${input.targetId} belongs to namespace ${target.namespace}, not ${input.namespace}`,
      );
    }
    return target;
  }

  const environment = deploymentEnvironmentForNamespace(input.namespace);
  if (environment === "unknown") {
    throw new Error(`Unknown deployment environment for namespace: ${input.namespace}`);
  }
  return deploymentEnvironmentSettings(environment);
}

export function deploymentTargetForFirebaseProject(
  projectId: string,
): DeploymentEnvironmentSettings {
  const target = Object.values(TARGETS).find(
    (candidate) => candidate.firebaseProjectId === projectId,
  );
  if (!target) {
    throw new Error(`Unknown Firebase deployment project: ${projectId}`);
  }
  return target;
}

export function deploymentTargetsForEnvironment(
  environment: DeploymentEnvironment,
): DeploymentEnvironmentSettings[] {
  return Object.values(TARGETS).filter((target) => target.name === environment);
}

export function deploymentEnvironmentForNamespace(
  namespace: string,
): ResolvedDeploymentEnvironment {
  const entry = Object.values(TARGETS).find((value) => value.namespace === namespace);
  return entry?.name ?? "unknown";
}

export function deploymentEnvironmentForProject(
  projectId: string,
): ResolvedDeploymentEnvironment {
  const entry = Object.values(TARGETS).find(
    (value) => value.firebaseProjectId === projectId,
  );
  return entry?.name ?? "unknown";
}

function hostingOrigins(settings: DeploymentEnvironmentSettings): string[] {
  const project = settings.firebaseProjectId;
  if (settings.name === "prod") {
    return [
      settings.siteOrigin,
      settings.appOrigin,
      "https://www.octogee.com",
      "https://octogee.web.app",
      "https://app-octogee.web.app",
      "https://octogee.firebaseapp.com",
      "https://app-octogee.firebaseapp.com",
    ];
  }
  return [
    settings.siteOrigin,
    settings.appOrigin,
    `https://${project}.firebaseapp.com`,
    `https://app-${project}.firebaseapp.com`,
  ];
}

export function publicAppOrigins(): string[] {
  return [...new Set(
    DEPLOYMENT_ENVIRONMENTS.flatMap((environment) => hostingOrigins(ENVIRONMENTS[environment])),
  )];
}

export function publicAppHosts(): string[] {
  return publicAppOrigins().map((origin) => new URL(origin).hostname);
}
