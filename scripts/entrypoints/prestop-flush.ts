import { blobSyncAllWithOptions } from "../lib/blob-sync.js";
import {
  GATEWAY_CLASS,
  GATEWAY_ID,
  log,
} from "../lib/config.js";
import { createBrokeredBlobStore } from "../lib/blob-sync-broker.js";
import { createFleetBrokerClient } from "../lib/fleet-broker-client.js";
import { runGatewayPreStopFlush } from "../lib/gateway-prestop-flush.js";
import { syncAllWorkspaces } from "../lib/git.js";
import { pushDirtySystemConfigForSlug } from "../lib/system-config.js";
import { pathToFileURL } from "node:url";

export interface PreStopFlushConfig {
  builderSlug: string;
  gatewayClass: string;
  gatewayId: string;
}

export function resolvePreStopFlushConfig(
  env: NodeJS.ProcessEnv = process.env,
  runtime: { gatewayClass?: string; gatewayId?: string } = {
    gatewayClass: GATEWAY_CLASS,
    gatewayId: GATEWAY_ID,
  },
): PreStopFlushConfig {
  const rawGatewayId = runtime.gatewayId ?? "local";
  return {
    gatewayId: rawGatewayId === "local" ? "default" : rawGatewayId,
    gatewayClass: runtime.gatewayClass ?? "",
    builderSlug: env.GATEWAY_BUILDER_SLUG?.trim() ?? "",
  };
}

async function main(): Promise<void> {
  const { builderSlug, gatewayClass, gatewayId } = resolvePreStopFlushConfig();
  const brokerClient = createFleetBrokerClient(gatewayId);
  await brokerClient
    .recordPreStopFlush({
      gatewayClass,
      phase: "started",
      reason: "prestop",
    })
    .catch((err) => {
      log(
        `[prestop-flush] broker start report failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  const result = await runGatewayPreStopFlush({
    gatewayId,
    gatewayClass,
    syncWorkspaces: syncAllWorkspaces,
    syncBlobs: () => blobSyncAllWithOptions({
      storeForSlug: () => createBrokeredBlobStore(brokerClient),
    }),
    syncSystemConfig: builderSlug
      ? async () => {
          pushDirtySystemConfigForSlug(builderSlug, { log });
        }
      : undefined,
    log,
  });
  await brokerClient
    .recordPreStopFlush({
      gatewayClass,
      phase: "completed",
      reason: "prestop",
      result,
    })
    .catch((err) => {
      log(
        `[prestop-flush] broker completion report failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });

  if (!result.ok) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("prestop-flush fatal:", err);
    process.exit(1);
  });
}
