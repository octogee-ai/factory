import {
  AGENT_PREFIX,
  AGENTS_DIR,
  bootBanner,
  GATEWAY_CLASS,
  GATEWAY_ID,
  GATEWAY_PROFILE,
  GATEWAY_REVISION_ID,
  GIT_SYNC_INTERVAL_MS,
  isOperatorGateway,
  log,
  OPENCLAW_DIR,
} from "../lib/config.js";
import { createGatewayRpc } from "../lib/gateway-rpc.js";
import type { GatewayRpcClient } from "../lib/gateway-rpc.js";
import { syncAllWorkspaces } from "../lib/git.js";
import { buildBrokeredLifecycleAdapter } from "../lib/customer-lifecycle-broker-adapter.js";
import { blobSyncAllWithOptions } from "../lib/blob-sync.js";
import { createBrokeredBlobStore } from "../lib/blob-sync-broker.js";
import { createFleetBrokerClient } from "../lib/fleet-broker-client.js";
import { startFleetController } from "../lib/fleet-provisioner.js";
import { desiredFingerprints } from "../lib/snapshot-fingerprint.js";
import { probeOpenClawVersion } from "../lib/probe-openclaw-version.js";
import { startUsageEventTailer } from "../lib/usage-log-tailer.js";
import { startWorkspaceAutosaveLoop } from "../lib/workspace-autosave-runner.js";
import { runGatewayPreStopFlush } from "../lib/gateway-prestop-flush.js";
import {
  checkpointDurableSystemConfigForSlug,
  syncSystemConfigForSlug,
} from "../lib/system-config.js";
import {
  assertSystemConfigMutationAllowed,
  checkpointSystemConfig,
  restoreAndProveSystemConfig,
  unfreezeSystemConfig,
  type RestoreAndProofOptions,
  type SystemConfigRestoreProof,
} from "../lib/system-config-roll-control.js";
import { acquireSystemConfigMutationLease } from "@octogee/core/system-config-mutation-lease";
import { validateOpenClawConfig } from "../lib/openclaw-config-validation.js";
import type { SystemConfigCommitSource } from "../lib/system-config-recovery.js";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { startSystemConfigControlCapabilityHeartbeat } from "../lib/system-config-control-capability.js";

export interface FleetControllerEntrypointConfig {
  builderSlug: string;
  gatewayId: string;
  revisionId: string;
  port: number;
  publicKey: string;
  version: string;
}

export function resolveFleetControllerEntrypointConfig(
  env: NodeJS.ProcessEnv = process.env,
  runtime: { gatewayId?: string; revisionId?: string } = {
    gatewayId: GATEWAY_ID,
    revisionId: GATEWAY_REVISION_ID,
  },
): FleetControllerEntrypointConfig {
  const rawGatewayId = runtime.gatewayId ?? "local";
  return {
    gatewayId: rawGatewayId === "local" ? "default" : rawGatewayId,
    revisionId: runtime.revisionId ?? "",
    builderSlug: env.GATEWAY_BUILDER_SLUG?.trim() ?? "",
    port: parseInt(env.FLEET_CONTROLLER_PORT ?? "3003", 10),
    publicKey: env.FLEET_CONTROLLER_PUBLIC_KEY || "",
    version: env.BUILD_SHA ?? "unknown",
  };
}

export function createFleetSystemConfigFlush(
  builderSlug: string,
  logFn: (message: string) => void = log,
  sync: typeof syncSystemConfigForSlug = syncSystemConfigForSlug,
): (() => Promise<void>) | undefined {
  if (!builderSlug) return undefined;
  return async () => {
    checkpointDurableSystemConfigForSlug(builderSlug, { log: logFn }, sync);
  };
}

export function assertFleetConfigSlug(expectedSlug: string, requestedSlug: string): void {
  if (requestedSlug !== expectedSlug) {
    throw new Error("config RPC slug does not match gateway builder");
  }
}

type SystemConfigRuntimeRpc = Pick<
  GatewayRpcClient,
  "configGet" | "configApply" | "channelsStatus"
>;

export function createSystemConfigMutationGatedRpc(
  rpc: GatewayRpcClient,
  openclawDir: string,
): GatewayRpcClient {
  return new Proxy(rpc, {
    get(target, property, receiver) {
      if (property !== "configApply" && property !== "configPatch") {
        return Reflect.get(target, property, receiver) as unknown;
      }
      const mutation = Reflect.get(target, property, target) as (...args: unknown[]) => Promise<unknown>;
      return async (...args: unknown[]) => {
        const acquired = await acquireSystemConfigMutationLease({ openclawDir });
        if (!acquired.ok) {
          if (acquired.code === "config-frozen") {
            throw new Error(
              `system config is frozen by ${acquired.freezeOwner.migrationId} for ${acquired.freezeOwner.slug}`,
            );
          }
          throw new Error("system config writer lock is busy");
        }
        try {
          assertSystemConfigMutationAllowed({ openclawDir });
          return await Reflect.apply(mutation, target, args);
        } finally {
          await acquired.lease.release();
        }
      };
    },
  });
}

export interface RestoreRevisionSystemConfigOptions {
  checkpointCommit: string;
  slug: string;
  openclawDir: string;
  revisionId: string;
  env: NodeJS.ProcessEnv;
  source: SystemConfigCommitSource;
  rpc: SystemConfigRuntimeRpc;
  validateConfig?: (configPath: string) => void;
  now?: () => number;
  restore?: (options: RestoreAndProofOptions) => Promise<SystemConfigRestoreProof>;
}

async function loadRuntimeSystemConfig(
  rpc: SystemConfigRuntimeRpc,
  configPath: string,
): Promise<string> {
  const value = JSON.parse(fs.readFileSync(configPath, "utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("restored OpenClaw config is not an object");
  }
  const current = await rpc.configGet();
  const applied = await rpc.configApply(value as object, current.hash);
  if (typeof applied.hash !== "string" || applied.hash.length === 0) {
    throw new Error("OpenClaw config.apply did not return the loaded runtime hash");
  }
  return applied.hash;
}

export async function restoreRevisionSystemConfig(
  options: RestoreRevisionSystemConfigOptions,
): Promise<
  SystemConfigRestoreProof & {
    configReady: true;
    observedRevisionId: string;
    restoreProvenAt: number;
    configReadyAt: number;
    runtimeConfigHash: string;
  }
> {
  if (!options.revisionId) throw new Error("target revision id unavailable for config proof");
  let loadedRuntimeHash = "";
  const restore = options.restore ?? restoreAndProveSystemConfig;
  const proof = await restore({
    checkpointCommit: options.checkpointCommit,
    slug: options.slug,
    openclawDir: options.openclawDir,
    env: options.env,
    source: options.source,
    ...(options.validateConfig ? { validateConfig: options.validateConfig } : {}),
    loadRuntimeConfig: async (configPath) => {
      loadedRuntimeHash = await loadRuntimeSystemConfig(options.rpc, configPath);
    },
  });
  if (!loadedRuntimeHash) throw new Error("target runtime config was not loaded before proof");
  const now = options.now ?? Date.now;
  const restoreProvenAt = now();
  const observed = await options.rpc.configGet();
  if (observed.hash !== loadedRuntimeHash) {
    throw new Error(
      `runtime config hash ${observed.hash} does not match loaded hash ${loadedRuntimeHash}`,
    );
  }
  await options.rpc.channelsStatus();
  return {
    ...proof,
    configReady: true,
    observedRevisionId: options.revisionId,
    restoreProvenAt,
    configReadyAt: now(),
    runtimeConfigHash: observed.hash,
  };
}

async function main(): Promise<void> {
  const entrypointConfig = resolveFleetControllerEntrypointConfig();
  log(bootBanner("fleet-controller"));
  const runtimeRpc = createGatewayRpc({
    allowLegacyGatewayTokenFallback: true,
  });
  const rpc = createSystemConfigMutationGatedRpc(runtimeRpc, OPENCLAW_DIR);
  const openclawVersion = probeOpenClawVersion({
    execFile: execFileSync,
    binaryPath: "/usr/local/bin/openclaw",
  });
  if (!entrypointConfig.publicKey) {
    throw new Error("fleet controller public key unavailable: expected FLEET_CONTROLLER_PUBLIC_KEY");
  }
  const operator = isOperatorGateway();
  const brokerClient = createFleetBrokerClient(
    entrypointConfig.gatewayId,
    entrypointConfig.revisionId,
  );
  const adapter = buildBrokeredLifecycleAdapter({
    client: brokerClient,
    rpc,
    log,
    adminMmUserId: process.env.MM_ADMIN_USER_ID,
    isOperatorGateway,
  });
  const fleetHandle = await startFleetController({
    rpc,
    adapter,
    gatewayId: entrypointConfig.gatewayId,
    revisionId: entrypointConfig.revisionId,
    log,
    port: entrypointConfig.port,
    publicKey: entrypointConfig.publicKey,
    version: entrypointConfig.version,
    openclawVersion,
    openclawDir: OPENCLAW_DIR,
    platformState: !operator,
    localReconcile: true,
    // Non-operator (shared/builder) gateways always re-apply the config patch on ensure,
    // so a fingerprint drift can reconverge a mounted customer — this is what makes a
    // project-agent toggle land without a remount. Operator gateways short-circuit a
    // coach-wired resync in addCustomerToGateway, where a recorded "applied" fingerprint
    // would falsely mark an unpatched config current; they fall back to slug-only roster
    // and reconverge on remount.
    ...(operator
      ? {
          readDesiredSlugs: async () => {
            const users = await brokerClient.assignedUsers({ completeOnly: false });
            return users.map((user) => user.slug);
          },
        }
      : {
          readDesiredFingerprints: async () => {
            const users = await brokerClient.assignedUsers({ completeOnly: false });
            // Seed the adapter's snapshot cache from the same fetch: the ensure a
            // fingerprint drift triggers must apply exactly the content that was
            // fingerprinted, not whatever the TTL-less cache still holds.
            return desiredFingerprints(users, adapter.seedUserSnapshotForMigration);
          },
        }),
    stampMounted: (uid, mounted) => brokerClient.setMounted(uid, mounted),
    recordReconcileError: (slug, message) => brokerClient.recordReconcileError(slug, message),
    clearReconcileError: (slug) => brokerClient.clearReconcileError(slug),
    flushLocalState: async ({ reason }) => {
      log(`[fleet] controller-requested flush reason=${reason}`);
      return runGatewayPreStopFlush({
        gatewayId: entrypointConfig.gatewayId,
        gatewayClass: GATEWAY_CLASS,
        syncWorkspaces: syncAllWorkspaces,
        syncBlobs: operator
          ? undefined
          : () => blobSyncAllWithOptions({
              storeForSlug: () => createBrokeredBlobStore(brokerClient),
            }),
        syncSystemConfig: createFleetSystemConfigFlush(entrypointConfig.builderSlug),
        log,
      });
    },
    ...(entrypointConfig.builderSlug
      ? {
          freezeSystemConfig: ({ migrationId, slug }) => {
            assertFleetConfigSlug(entrypointConfig.builderSlug, slug);
            return checkpointSystemConfig({
              migrationId,
              slug,
              openclawDir: OPENCLAW_DIR,
              env: process.env,
              source: "migration-checkpoint",
              validateConfig: validateOpenClawConfig,
            });
          },
          proveSystemConfigRestore: async ({ checkpointCommit, slug }) => {
            assertFleetConfigSlug(entrypointConfig.builderSlug, slug);
            return restoreRevisionSystemConfig({
              checkpointCommit,
              slug,
              openclawDir: OPENCLAW_DIR,
              revisionId: entrypointConfig.revisionId,
              env: process.env,
              source: "migration-restore",
              rpc: runtimeRpc,
              validateConfig: validateOpenClawConfig,
            });
          },
          unfreezeSystemConfig: ({ migrationId, slug }) => {
            assertFleetConfigSlug(entrypointConfig.builderSlug, slug);
            return unfreezeSystemConfig({
              migrationId,
              slug,
              openclawDir: OPENCLAW_DIR,
            });
          },
        }
      : {}),
    // Db-less: gateway pods hold NO Firestore credentials. Cowboy polls
    // /health and writes gateways/{id} on the trusted side. Gateway pods run
    // only the local mount reconcile from brokered assigned snapshots; all
    // trusted-side provisioning mutations go through octogee-api.
    reportState: false,
    internalServiceKey: process.env.OPENCLAW_GATEWAY_TOKEN ?? "",
  });
  const configControlCapability = entrypointConfig.builderSlug
    ? startSystemConfigControlCapabilityHeartbeat({
        openclawDir: OPENCLAW_DIR,
        revisionId: entrypointConfig.revisionId,
        log,
      })
    : null;

  const autosaveTimer = startWorkspaceAutosaveLoop(
    {
      envValue: process.env.WORKSPACE_AUTOSAVE_ENABLED,
      isOperatorGateway,
      syncWorkspaces: syncAllWorkspaces,
      syncBlobs: operator
        ? undefined
        : () => blobSyncAllWithOptions({
            storeForSlug: () => createBrokeredBlobStore(brokerClient!),
          }),
      log,
    },
    GIT_SYNC_INTERVAL_MS,
  );
  const usageTimer = operator
    ? null
    : startUsageEventTailer({
        agentPrefix: AGENT_PREFIX,
        agentsDir: AGENTS_DIR,
        submit: async (event) => {
          await brokerClient!.recordUsageEvent({
            agentId: event.agentId,
            usage: event.usage,
          });
        },
        log,
        gatewayId: entrypointConfig.gatewayId,
      });
  log(`Local fleet controller running (profile=${GATEWAY_PROFILE}). Press Ctrl+C to stop.`);
  const cleanup = async () => {
    configControlCapability?.close();
    if (autosaveTimer) clearInterval(autosaveTimer);
    if (usageTimer) clearInterval(usageTimer);
    try { await fleetHandle.stop(); } catch {}
    try { await rpc.close(); } catch {}
  };
  process.on("SIGINT", () => { cleanup().finally(() => process.exit(0)).catch(() => process.exit(0)); });
  process.on("SIGTERM", () => { cleanup().finally(() => process.exit(0)).catch(() => process.exit(0)); });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
}
