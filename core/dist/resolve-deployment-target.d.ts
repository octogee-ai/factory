#!/usr/bin/env node
import { type DeploymentEnvironmentSettings } from "./deployment-environment.js";
export type DeploymentTargetOutputFormat = "github" | "json";
export declare function resolveDeploymentTargetArguments(argv: readonly string[]): DeploymentEnvironmentSettings;
export declare function formatDeploymentTargetOutput(settings: DeploymentEnvironmentSettings, format: DeploymentTargetOutputFormat): string;
export declare function runDeploymentTargetResolver(argv: readonly string[]): string;
