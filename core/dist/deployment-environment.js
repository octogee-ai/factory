import deploymentTargetsDocument from "./deployment-targets.json" with { type: "json" };
const DEPLOYMENT_ENVIRONMENTS = [
    "prod",
    "test",
    "build-week",
];
const TARGET_LIFECYCLES = [
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
];
const INGRESS_STRING_FIELDS = [
    "edgeStaticIpName",
    "mattermostStaticIpName",
    "giteaStaticIpName",
    "previewStaticIpName",
];
function record(value, label) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`${label} must be an object`);
    }
    return value;
}
function stringField(value, field, label) {
    const fieldValue = value[field];
    if (typeof fieldValue !== "string" || fieldValue.length === 0) {
        throw new Error(`${label}.${field} must be a non-empty string`);
    }
    return fieldValue;
}
function stringFields(value, fields, label) {
    for (const field of fields) {
        stringField(value, field, label);
    }
}
function validatePromotionSourceField(target, targetId, environment) {
    if (environment === "prod") {
        stringField(target, "promotionSourceTargetId", `deployment target ${targetId}`);
    }
    else if (target.promotionSourceTargetId !== undefined) {
        throw new Error(`deployment target ${targetId}.promotionSourceTargetId is only valid for prod`);
    }
}
function validatePromotionSources(targets) {
    for (const [targetId, value] of Object.entries(targets)) {
        const target = value;
        if (target.environment !== "prod")
            continue;
        const sourceTargetId = target.promotionSourceTargetId;
        const source = targets[sourceTargetId];
        if (!source) {
            throw new Error(`deployment target ${targetId}.promotionSourceTargetId does not exist: ${sourceTargetId}`);
        }
        if (source.environment !== "test") {
            throw new Error(`deployment target ${targetId}.promotionSourceTargetId must belong to test`);
        }
    }
}
function validateIngressIdentityUniqueness(targets) {
    const identitiesByProject = new Map();
    for (const [targetId, value] of Object.entries(targets)) {
        const target = value;
        const projectId = target.clusterProjectId;
        const ingress = target.ingress;
        const identities = identitiesByProject.get(projectId) ?? new Map();
        identitiesByProject.set(projectId, identities);
        for (const field of INGRESS_STRING_FIELDS) {
            const identity = ingress[field];
            const owner = identities.get(identity);
            if (owner) {
                throw new Error(`deployment target ${targetId} ingress identity ${identity} is already used by ${owner}`);
            }
            identities.set(identity, `${targetId}.${field}`);
        }
    }
}
export function validateDeploymentTargetsDocument(document) {
    const manifest = record(document, "deployment targets manifest");
    if (manifest.schemaVersion !== 1) {
        throw new Error("deployment targets manifest.schemaVersion must be 1");
    }
    const activeTargets = record(manifest.activeTargets, "deployment targets manifest.activeTargets");
    const targets = record(manifest.targets, "deployment targets manifest.targets");
    for (const environment of DEPLOYMENT_ENVIRONMENTS) {
        const targetId = stringField(activeTargets, environment, "deployment targets manifest.activeTargets");
        if (!(targetId in targets)) {
            throw new Error(`Active deployment target does not exist: ${targetId}`);
        }
    }
    for (const [targetId, value] of Object.entries(targets)) {
        const target = record(value, `deployment target ${targetId}`);
        const environment = stringField(target, "environment", `deployment target ${targetId}`);
        if (!DEPLOYMENT_ENVIRONMENTS.includes(environment)) {
            throw new Error(`deployment target ${targetId}.environment is invalid: ${environment}`);
        }
        validatePromotionSourceField(target, targetId, environment);
        const lifecycle = stringField(target, "lifecycle", `deployment target ${targetId}`);
        if (!TARGET_LIFECYCLES.includes(lifecycle)) {
            throw new Error(`deployment target ${targetId}.lifecycle is invalid: ${lifecycle}`);
        }
        stringFields(target, TARGET_STRING_FIELDS, `deployment target ${targetId}`);
        stringFields(record(target.artifactRegistry, `deployment target ${targetId}.artifactRegistry`), ["projectId", "location", "repository"], `deployment target ${targetId}.artifactRegistry`);
        const cloudSql = record(target.cloudSql, `deployment target ${targetId}.cloudSql`);
        stringFields(cloudSql, [
            "projectId",
            "region",
            "instance",
            "mattermostPasswordSecret",
            "giteaPasswordSecret",
            "connectionNameSecret",
        ], `deployment target ${targetId}.cloudSql`);
        if (typeof cloudSql.pointInTimeRecoveryEnabled !== "boolean") {
            throw new Error(`deployment target ${targetId}.cloudSql.pointInTimeRecoveryEnabled must be a boolean`);
        }
        stringFields(record(target.kms, `deployment target ${targetId}.kms`), ["projectId", "location", "keyRing", "key"], `deployment target ${targetId}.kms`);
        stringFields(record(target.storage, `deployment target ${targetId}.storage`), ["projectId", "location"], `deployment target ${targetId}.storage`);
        stringFields(record(target.ingress, `deployment target ${targetId}.ingress`), INGRESS_STRING_FIELDS, `deployment target ${targetId}.ingress`);
    }
    validatePromotionSources(targets);
    validateIngressIdentityUniqueness(targets);
    for (const environment of DEPLOYMENT_ENVIRONMENTS) {
        const targetId = activeTargets[environment];
        const target = targets[targetId];
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
const MANIFEST = deploymentTargetsDocument;
function settings(targetId, target) {
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
        edgeStaticIpName: target.ingress.edgeStaticIpName,
        mattermostStaticIpName: target.ingress.mattermostStaticIpName,
        giteaStaticIpName: target.ingress.giteaStaticIpName,
        previewStaticIpName: target.ingress.previewStaticIpName,
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
const TARGETS = Object.fromEntries(Object.entries(MANIFEST.targets).map(([targetId, target]) => [
    targetId,
    settings(targetId, target),
]));
const ENVIRONMENTS = Object.fromEntries(DEPLOYMENT_ENVIRONMENTS.map((environment) => [
    environment,
    TARGETS[MANIFEST.activeTargets[environment]],
]));
export const BUILD_WEEK_ENVIRONMENT = ENVIRONMENTS["build-week"];
export function deploymentEnvironmentSettings(environment) {
    return ENVIRONMENTS[environment];
}
export function deploymentTargetSettings(targetId) {
    const target = TARGETS[targetId];
    if (!target) {
        throw new Error(`Unknown deployment target: ${targetId}`);
    }
    return target;
}
export function deploymentSettingsForRuntime(input) {
    if (input.targetId !== undefined) {
        const target = deploymentTargetSettings(input.targetId);
        if (target.namespace !== input.namespace) {
            throw new Error(`Deployment target ${input.targetId} belongs to namespace ${target.namespace}, not ${input.namespace}`);
        }
        return target;
    }
    const environment = deploymentEnvironmentForNamespace(input.namespace);
    if (environment === "unknown") {
        throw new Error(`Unknown deployment environment for namespace: ${input.namespace}`);
    }
    return deploymentEnvironmentSettings(environment);
}
export function deploymentTargetForFirebaseProject(projectId) {
    const target = Object.values(TARGETS).find((candidate) => candidate.firebaseProjectId === projectId);
    if (!target) {
        throw new Error(`Unknown Firebase deployment project: ${projectId}`);
    }
    return target;
}
export function deploymentTargetsForEnvironment(environment) {
    return Object.values(TARGETS).filter((target) => target.name === environment);
}
export function deploymentEnvironmentForNamespace(namespace) {
    const entry = Object.values(TARGETS).find((value) => value.namespace === namespace);
    return entry?.name ?? "unknown";
}
export function deploymentEnvironmentForProject(projectId) {
    const entry = Object.values(TARGETS).find((value) => value.firebaseProjectId === projectId);
    return entry?.name ?? "unknown";
}
function hostingOrigins(settings) {
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
export function publicAppOrigins() {
    return [...new Set(DEPLOYMENT_ENVIRONMENTS.flatMap((environment) => hostingOrigins(ENVIRONMENTS[environment])))];
}
export function publicAppHosts() {
    return publicAppOrigins().map((origin) => new URL(origin).hostname);
}
