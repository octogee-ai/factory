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

const gatewayId = GATEWAY_ID === "local" ? "default" : GATEWAY_ID;
const builderSlug = process.env.GATEWAY_BUILDER_SLUG?.trim() ?? "";

async function main(): Promise<void> {
  const brokerClient = createFleetBrokerClient(gatewayId);
  const result = await runGatewayPreStopFlush({
    gatewayId,
    gatewayClass: GATEWAY_CLASS,
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

  if (!result.ok) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("prestop-flush fatal:", err);
  process.exit(1);
});
