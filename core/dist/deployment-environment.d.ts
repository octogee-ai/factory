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
    lifecycle: DeploymentTargetLifecycle;
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
    targetId: string;
    lifecycle: DeploymentTargetLifecycle;
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
export declare function validateDeploymentTargetsDocument(document: unknown): asserts document is DeploymentTargetsDocument;
export declare const BUILD_WEEK_ENVIRONMENT: DeploymentEnvironmentSettings;
export declare function deploymentEnvironmentSettings(environment: DeploymentEnvironment): DeploymentEnvironmentSettings;
export declare function deploymentTargetSettings(targetId: string): DeploymentEnvironmentSettings;
export declare function deploymentSettingsForRuntime(input: {
    namespace: string;
    targetId?: string;
}): DeploymentEnvironmentSettings;
export declare function deploymentTargetForFirebaseProject(projectId: string): DeploymentEnvironmentSettings;
export declare function deploymentTargetsForEnvironment(environment: DeploymentEnvironment): DeploymentEnvironmentSettings[];
export declare function deploymentEnvironmentForNamespace(namespace: string): ResolvedDeploymentEnvironment;
export declare function deploymentEnvironmentForProject(projectId: string): ResolvedDeploymentEnvironment;
export declare function publicAppOrigins(): string[];
export declare function publicAppHosts(): string[];
export {};
