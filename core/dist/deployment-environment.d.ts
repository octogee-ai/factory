export type DeploymentEnvironment = "prod" | "test" | "build-week";
export type ResolvedDeploymentEnvironment = DeploymentEnvironment | "unknown";
export interface DeploymentEnvironmentSettings {
    name: DeploymentEnvironment;
    namespace: string;
    firebaseProjectId: string;
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
export declare const BUILD_WEEK_ENVIRONMENT: DeploymentEnvironmentSettings;
export declare function deploymentEnvironmentSettings(environment: DeploymentEnvironment): DeploymentEnvironmentSettings;
export declare function deploymentEnvironmentForNamespace(namespace: string): ResolvedDeploymentEnvironment;
export declare function deploymentEnvironmentForProject(projectId: string): ResolvedDeploymentEnvironment;
export declare function publicAppOrigins(): string[];
export declare function publicAppHosts(): string[];
