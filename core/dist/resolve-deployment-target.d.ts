#!/usr/bin/env node
import { type DeploymentTargetSettings } from "./deployment-environment.js";
export type DeploymentTargetOutputFormat = "github" | "json";
export declare function isDeploymentTargetResolverEntrypoint(moduleUrl: string, entrypoint: string | undefined): boolean;
export declare function resolveDeploymentTargetArguments(argv: readonly string[]): DeploymentTargetSettings;
export declare function formatDeploymentTargetOutput(settings: DeploymentTargetSettings, format: DeploymentTargetOutputFormat): string;
export declare function runDeploymentTargetResolver(argv: readonly string[]): string;
