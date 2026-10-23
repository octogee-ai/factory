import { createServiceLogger } from "@octogee/shared/server/service-logger";
const runtimeLogger = createServiceLogger("builder-runtime-state-restore");
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

import {
  builderRuntimeStatePath,
  isFatalBuilderRuntimeStateRestoreError,
  resolveBuilderRuntimeStateScope,
  restoreBuilderRuntimeState,
  type BuilderRuntimeStateDependencies,
} from "../lib/builder-runtime-state.js";
import { createFleetBrokerClient, type FleetBrokerClient } from "../lib/fleet-broker-client.js";

import { landGatewayStateAnchor, type GatewayStateAnchorVerifier } from "../lib/agent-anchor-record.js";
import { clusterBuilderGateway } from "../lib/openclaw-state-store.js";

const log = runtimeLogger.info;

export async function runBuilderRuntimeStateRestore(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: BuilderRuntimeStateDependencies & {
    broker?: Pick<FleetBrokerClient, "builderRuntimeStateDownloadUrl" | "readAgentAnchors">;
    verifyState?: GatewayStateAnchorVerifier;
  } = {},
): Promise<void> {
  const scope = resolveBuilderRuntimeStateScope(env);
  const broker = dependencies.broker ?? createFleetBrokerClient(scope.gatewayId);
  if (clusterBuilderGateway(env) && scope.builderSlug && !existsSync(builderRuntimeStatePath(scope.stateDir))) {
    const { state } = await broker.readAgentAnchors({ slug: scope.builderSlug });
    if (state) await landGatewayStateAnchor(scope.stateDir, state, dependencies.verifyState);
  }
  const result = await restoreBuilderRuntimeState({
    scope,
    broker,
    dependencies,
  });
  const size = "size" in result ? ` size=${result.size}` : "";
  log(`restore ${result.status}${size}`);
}

async function main(): Promise<void> {
  try {
    await runBuilderRuntimeStateRestore();
  } catch (error) {
    runtimeLogger.error(`[runtime-state] restore failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = isFatalBuilderRuntimeStateRestoreError(error) ? 2 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
