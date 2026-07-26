#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deploymentEnvironmentSettings, deploymentTargetSettings, } from "./deployment-environment.js";
export function isDeploymentTargetResolverEntrypoint(moduleUrl, entrypoint) {
    if (!entrypoint)
        return false;
    try {
        return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(entrypoint);
    }
    catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
            throw error;
        }
        return moduleUrl === pathToFileURL(entrypoint).href;
    }
}
const DEPLOYMENT_ENVIRONMENTS = [
    "prod",
    "test",
    "build-week",
];
function deploymentEnvironment(value) {
    if (!DEPLOYMENT_ENVIRONMENTS.includes(value)) {
        throw new Error(`Unknown deployment environment: ${value}`);
    }
    return value;
}
export function resolveDeploymentTargetArguments(argv) {
    let environment;
    let targetId;
    for (const argument of argv) {
        if (argument.startsWith("--environment=")) {
            environment = argument.slice("--environment=".length);
        }
        else if (argument.startsWith("--target=")) {
            targetId = argument.slice("--target=".length);
        }
        else {
            throw new Error(`Unknown argument: ${argument}`);
        }
    }
    if ((environment === undefined) === (targetId === undefined)) {
        throw new Error("Exactly one of --environment or --target is required");
    }
    if (environment !== undefined) {
        return deploymentEnvironmentSettings(deploymentEnvironment(environment));
    }
    return deploymentTargetSettings(targetId);
}
function deploymentTargetOutput(settings) {
    return {
        environment: settings.name,
        target_id: settings.targetId,
        lifecycle: settings.lifecycle,
        secret_name_suffix: settings.secretNameSuffix,
        cluster_project_id: settings.clusterProjectId,
        firebase_project_id: settings.firebaseProjectId,
        hosting_project_id: settings.hostingProjectId,
        region: settings.region,
        cluster_name: settings.clusterName,
        kube_context: settings.kubeContext,
        namespace: settings.namespace,
        artifact_registry_project_id: settings.artifactRegistryProjectId,
        artifact_registry_location: settings.artifactRegistryLocation,
        artifact_registry_name: settings.artifactRegistryName,
        artifact_registry_repository: settings.artifactRegistryRepository,
        cloud_sql_project_id: settings.cloudSqlProjectId,
        cloud_sql_region: settings.cloudSqlRegion,
        cloud_sql_instance_name: settings.cloudSqlInstanceName,
        cloud_sql_connection_name: settings.cloudSqlConnectionName,
        cloud_sql_mattermost_password_secret_name: settings.cloudSqlMattermostPasswordSecretName,
        cloud_sql_gitea_password_secret_name: settings.cloudSqlGiteaPasswordSecretName,
        cloud_sql_connection_name_secret_name: settings.cloudSqlConnectionNameSecretName,
        cloud_sql_point_in_time_recovery_enabled: String(settings.cloudSqlPointInTimeRecoveryEnabled),
        kms_project_id: settings.kmsProjectId,
        kms_location: settings.kmsLocation,
        kms_key_name: settings.kmsKeyName,
        storage_project_id: settings.storageProjectId,
        storage_location: settings.storageLocation,
        site_origin: settings.siteOrigin,
        app_origin: settings.appOrigin,
        api_origin: settings.apiOrigin,
        git_origin: settings.gitOrigin,
        mattermost_origin: settings.mattermostOrigin,
        preview_origin: settings.previewOrigin,
        gateway_values_file: settings.gatewayValuesFile,
        pin_environment: settings.pinEnvironment,
        network_policy_enforce_default_deny: String(settings.networkBoundary !== undefined),
        network_policy_control_plane_cidr: settings.networkBoundary?.controlPlaneCidr ?? "",
        network_policy_private_services_cidr: settings.networkBoundary?.privateServicesCidr ?? "",
    };
}
export function formatDeploymentTargetOutput(settings, format) {
    const output = deploymentTargetOutput(settings);
    if (format === "json") {
        return JSON.stringify(output);
    }
    return Object.entries(output)
        .map(([key, value]) => {
        if (value.includes("\n") || value.includes("\r")) {
            throw new Error(`Deployment target output ${key} contains a newline`);
        }
        return `${key}=${value}\n`;
    })
        .join("");
}
export function runDeploymentTargetResolver(argv) {
    let format = "github";
    const selectorArguments = [];
    for (const argument of argv) {
        if (argument.startsWith("--format=")) {
            const value = argument.slice("--format=".length);
            if (value !== "github" && value !== "json") {
                throw new Error(`Unknown output format: ${value}`);
            }
            format = value;
        }
        else {
            selectorArguments.push(argument);
        }
    }
    return formatDeploymentTargetOutput(resolveDeploymentTargetArguments(selectorArguments), format);
}
if (isDeploymentTargetResolverEntrypoint(import.meta.url, process.argv[1])) {
    try {
        process.stdout.write(runDeploymentTargetResolver(process.argv.slice(2)));
    }
    catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    }
}
