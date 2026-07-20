import { blobSyncAllWithOptions } from "../lib/blob-sync.js";
import {
  GATEWAY_CLASS,
  GATEWAY_ID,
  log,
} from "../lib/config.js";
import { createBrokeredBlobStore } from "../lib/blob-sync-broker.js";
import { createFleetBrokerClient } from "../lib/fleet-broker-client.js";
import { runGatewayPreStopFlush } from "../lib/gateway-prestop-flush.js";
import {
  listLocalCustomerPubKeys,
  readLocalCustomerPubKey,
  syncAllWorkspaces,
  type LocalCustomerPubKey,
} from "../lib/git.js";
import { releaseGiteaUserKey } from "../lib/gitea-admin-broker-client.js";
import {
  checkpointDurableSystemConfigForSlug,
  syncSystemConfigForSlug,
} from "../lib/system-config.js";
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

export function createPreStopSystemConfigFlush(
  builderSlug: string,
  logFn: (message: string) => void = log,
  sync: typeof syncSystemConfigForSlug = syncSystemConfigForSlug,
): (() => Promise<void>) | undefined {
  if (!builderSlug) return undefined;
  return async () => {
    checkpointDurableSystemConfigForSlug(builderSlug, { log: logFn }, sync);
  };
}

export function createPreStopGiteaKeyRelease(
  builderSlug: string,
  deps: {
    readLocalCustomerPubKey: typeof readLocalCustomerPubKey;
    listLocalCustomerPubKeys?: () => LocalCustomerPubKey[];
    releaseGiteaUserKey: typeof releaseGiteaUserKey;
  } = { readLocalCustomerPubKey, listLocalCustomerPubKeys, releaseGiteaUserKey },
): () => Promise<void> {
  return async () => {
    let keys: LocalCustomerPubKey[];
    if (builderSlug) {
      const pubKey = deps.readLocalCustomerPubKey(builderSlug);
      if (pubKey === null) {
        throw new Error(`[prestop-flush] local SSH public key is missing for ${builderSlug}`);
      }
      keys = [{ slug: builderSlug, pubKey }];
    } else {
      keys = (deps.listLocalCustomerPubKeys ?? listLocalCustomerPubKeys)();
    }
    const failures: string[] = [];
    for (const key of keys) {
      try {
        await deps.releaseGiteaUserKey(key.slug, key.pubKey);
      } catch (err) {
        failures.push(`${key.slug}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (failures.length > 0) {
      throw new Error(`[prestop-flush] Gitea key release failed: ${failures.join("; ")}`);
    }
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
    syncWorkspaces: () => syncAllWorkspaces({ strict: true }),
    syncBlobs: () => blobSyncAllWithOptions({
      strict: true,
      storeForSlug: () => createBrokeredBlobStore(brokerClient),
    }),
    syncSystemConfig: createPreStopSystemConfigFlush(builderSlug),
    releaseGiteaKey: createPreStopGiteaKeyRelease(builderSlug),
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
