import { pathToFileURL } from "node:url";

import {
  isFatalBuilderRuntimeStateRestoreError,
  resolveBuilderRuntimeStateScope,
  restoreBuilderRuntimeState,
} from "../lib/builder-runtime-state.js";
import { createFleetBrokerClient } from "../lib/fleet-broker-client.js";

function log(message: string): void {
  console.log(`${new Date().toISOString()} [runtime-state] ${message}`);
}

export async function runBuilderRuntimeStateRestore(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const scope = resolveBuilderRuntimeStateScope(env);
  const result = await restoreBuilderRuntimeState({
    scope,
    broker: createFleetBrokerClient(scope.gatewayId),
  });
  const size = "size" in result ? ` size=${result.size}` : "";
  log(`restore ${result.status}${size}`);
}

async function main(): Promise<void> {
  try {
    await runBuilderRuntimeStateRestore();
  } catch (error) {
    console.error(`[runtime-state] restore failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = isFatalBuilderRuntimeStateRestoreError(error) ? 2 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
