import { deploymentEnvironmentSettings } from "@octogee/core/deployment-environment";

export const TEST_TARGET = deploymentEnvironmentSettings("test");
export const PROD_TARGET = deploymentEnvironmentSettings("prod");
