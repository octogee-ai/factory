import { flushCustomerFiles, flushAllCustomerFiles } from "../lib/customer-file-state.js";
import { blobSyncAllWithOptions, blobSyncForSlug } from "../lib/blob-sync.js";
import {
  GATEWAY_CLASS,
  GATEWAY_ID,
  log,
} from "../lib/config.js";
import { createBrokeredBlobStore } from "../lib/blob-sync-broker.js";
import {
  createFleetBrokerClient,
} from "../lib/fleet-broker-client.js";
import { runGatewayPreStopFlush } from "../lib/gateway-prestop-flush.js";
import {
  listLocalCustomerPubKeys,
  listOnDiskCustomerSlugs,
  readLocalCustomerPubKey,
  type LocalCustomerPubKey,
} from "../lib/git.js";
import { quiesceCustomerSessions } from "../lib/customer-session-quiesce.js";
import { releaseGiteaUserKey } from "../lib/gitea-admin-broker-client.js";
import {
  checkpointDurableSystemConfigForSlug,
  syncSystemConfigForSlug,
} from "../lib/system-config.js";
import {
  resolveBuilderRuntimeStateScope,
  snapshotBuilderRuntimeState,
} from "../lib/builder-runtime-state.js";
import { pathToFileURL } from "node:url";

export interface PreStopFlushConfig {
  builderSlug: string;
  gatewayClass: string;
  gatewayId: string;
}

export const PRESTOP_SESSION_QUIESCE_TIMEOUT_MS = 5_000;

export function createPreStopSessionQuiesce(
  builderSlug: string,
  deps: {
    listCustomerSlugs: () => string[];
    quiesce: typeof quiesceCustomerSessions;
  } = {
    listCustomerSlugs: listOnDiskCustomerSlugs,
    quiesce: quiesceCustomerSessions,
  },
): () => Promise<void> {
  return async () => {
    const slugs = builderSlug ? [builderSlug] : deps.listCustomerSlugs();
    const failures = (await Promise.all(slugs.map(async (slug) => {
      try {
        const result = await deps.quiesce(slug, {
          timeoutMs: PRESTOP_SESSION_QUIESCE_TIMEOUT_MS,
          log,
        });
        return result.drained ? null : `${slug}: ${result.runningCount} session(s) still running`;
      } catch (err) {
        return `${slug}: ${err instanceof Error ? err.message : String(err)}`;
      }
    }))).filter((failure): failure is string => failure !== null);
    if (failures.length > 0) {
      throw new Error(`[prestop-flush] session quiesce incomplete: ${failures.join("; ")}`);
    }
  };
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
): (() => Promise<{ acceptedCommit: string }>) | undefined {
  if (!builderSlug) return undefined;
  return async () => {
    const result = checkpointDurableSystemConfigForSlug(builderSlug, { log: logFn }, sync);
    return { acceptedCommit: result.acceptedCommit! };
  };
}

export function createPreStopBuilderRuntimeStateFlush(
  config: PreStopFlushConfig,
  brokerClient: Pick<
    ReturnType<typeof createFleetBrokerClient>,
    "builderRuntimeStateSnapshotUrls" | "builderRuntimeStatePrune"
  >,
  snapshot: typeof snapshotBuilderRuntimeState = snapshotBuilderRuntimeState,
  wait: (milliseconds: number) => Promise<void> = async (milliseconds) => {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
  },
): (() => Promise<void>) | undefined {
  if (config.gatewayClass !== "builder") return undefined;
  const scope = {
    ...resolveBuilderRuntimeStateScope(),
    gatewayClass: config.gatewayClass,
    gatewayId: config.gatewayId,
    builderSlug: config.builderSlug,
  };
  return async () => {
    let result = await snapshot({ scope, broker: brokerClient, log });
    for (let attempt = 0; result.status === "locked" && attempt < 2; attempt += 1) {
      await wait(250);
      result = await snapshot({ scope, broker: brokerClient, log });
    }
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
    quiesceSessions: createPreStopSessionQuiesce(builderSlug),
    flushFiles: builderSlug
      ? () => flushCustomerFiles(builderSlug)
      : () => flushAllCustomerFiles(),
    syncBlobs: builderSlug
      ? () => blobSyncForSlug(builderSlug, {
          strict: true,
          store: createBrokeredBlobStore(brokerClient),
        })
      : () => blobSyncAllWithOptions({
          strict: true,
          storeForSlug: () => createBrokeredBlobStore(brokerClient),
        }),
    syncSystemConfig: createPreStopSystemConfigFlush(builderSlug),
    syncRuntimeState: createPreStopBuilderRuntimeStateFlush(
      { builderSlug, gatewayClass, gatewayId },
      brokerClient,
    ),
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
