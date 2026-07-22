#!/usr/bin/env node
import { type DeploymentEnvironmentSettings } from "./deployment-environment.js";
export type DeploymentTargetOutputFormat = "github" | "json";
export declare function isDeploymentTargetResolverEntrypoint(moduleUrl: string, entrypoint: string | undefined): boolean;
export declare function resolveDeploymentTargetArguments(argv: readonly string[]): DeploymentEnvironmentSettings;
export declare function formatDeploymentTargetOutput(settings: DeploymentEnvironmentSettings, format: DeploymentTargetOutputFormat): string;
export declare function runDeploymentTargetResolver(argv: readonly string[]): string;
