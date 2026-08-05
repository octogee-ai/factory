import {
  AGENT_PREFIX,
  AGENTS_DIR,
  bootBanner,
  GATEWAY_CLASS,
  GATEWAY_ID,
  GATEWAY_PROFILE,
  GIT_SYNC_INTERVAL_MS,
  isBuilderGateway,
  log,
  OPENCLAW_DIR,
} from "../lib/config.js";
import { createGatewayRpc } from "../lib/gateway-rpc.js";
import type { GatewayRpcClient } from "../lib/gateway-rpc.js";
import { syncAllWorkspaces, syncCustomerRepositoriesForSlug } from "../lib/git.js";
import {
  buildBrokeredLifecycleAdapter,
  projectCheckoutScopeForRuntime,
} from "../lib/customer-lifecycle-broker-adapter.js";
import { blobSyncAllWithOptions, blobSyncForSlug } from "../lib/blob-sync.js";
import { createBrokeredBlobStore } from "../lib/blob-sync-broker.js";
import { createFleetBrokerClient } from "../lib/fleet-broker-client.js";
import type { FleetBrokerClient } from "../lib/fleet-broker-client.js";
import { startFleetController } from "../lib/fleet-provisioner.js";
import { desiredFingerprints } from "../lib/snapshot-fingerprint.js";
import { probeOpenClawVersion } from "../lib/probe-openclaw-version.js";
import { startUsageEventTailer } from "../lib/usage-log-tailer.js";
import { startWorkspaceAutosaveLoop } from "../lib/workspace-autosave-runner.js";
import { runGatewayPreStopFlush } from "../lib/gateway-prestop-flush.js";
import {
  checkpointDurableSystemConfigForSlug,
  readDurableSystemConfigHeadForSlug,
  syncSystemConfigForSlug,
} from "../lib/system-config.js";
import {
  createSystemConfigStatusPublisher,
  probeOpenClawHealth,
  refreshSystemConfigRuntimeHealth,
} from "../lib/system-config-runtime-health.js";
import { acquireSystemConfigMutationLease } from "@octogee/core/system-config-mutation-lease";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export interface FleetControllerEntrypointConfig {
  builderSlug: string;
  gatewayId: string;
  port: number;
  publicKey: string;
  version: string;
}

export const SYSTEM_CONFIG_MUTATION_LEASE_RETRY_DELAYS_MS = [
  250,
  750,
  1_500,
  2_500,
  3_000,
] as const;
export const FLEET_CONTROLLER_MUTATION_CALL_TIMEOUT_MS = 60_000;

export function resolveFleetControllerEntrypointConfig(
  env: NodeJS.ProcessEnv = process.env,
  runtime: { gatewayId?: string } = { gatewayId: GATEWAY_ID },
): FleetControllerEntrypointConfig {
  const rawGatewayId = runtime.gatewayId ?? "local";
  return {
    gatewayId: rawGatewayId === "local" ? "default" : rawGatewayId,
    builderSlug: env.GATEWAY_BUILDER_SLUG?.trim() ?? "",
    port: parseInt(env.FLEET_CONTROLLER_PORT ?? "3003", 10),
    publicKey: env.FLEET_CONTROLLER_PUBLIC_KEY || "",
    version: env.GATEWAY_IMAGE_TAG?.trim() || env.BUILD_SHA || "unknown",
  };
}

export function createFleetSystemConfigFlush(
  builderSlug: string,
  logFn: (message: string) => void = log,
  sync: typeof syncSystemConfigForSlug = syncSystemConfigForSlug,
  expectedRemoteCommit?: string,
): (() => Promise<{ acceptedCommit: string }>) | undefined {
  if (!builderSlug) return undefined;
  return async () => {
    const result = checkpointDurableSystemConfigForSlug(builderSlug, {
      log: logFn,
      ...(expectedRemoteCommit ? { expectedRemoteCommit } : {}),
    }, sync);
    return { acceptedCommit: result.acceptedCommit! };
  };
}

export function createFleetSharedSystemConfigFlush(
  builderSlug: string,
  expectedRemoteCommit?: string,
  readAcceptedCommit: typeof readDurableSystemConfigHeadForSlug =
    readDurableSystemConfigHeadForSlug,
): () => Promise<{ acceptedCommit: string }> {
  return async () => {
    const acceptedCommit = readAcceptedCommit(builderSlug);
    if (expectedRemoteCommit && acceptedCommit !== expectedRemoteCommit) {
      throw new Error(
        `durable system config head changed: expected ${expectedRemoteCommit}, observed ${acceptedCommit}`,
      );
    }
    return { acceptedCommit };
  };
}

export function createAssignedFingerprintReader(
  brokerClient: Pick<FleetBrokerClient, "assignedUsers">,
  seedSnapshot: Parameters<typeof desiredFingerprints>[1],
): () => Promise<Map<string, string>> {
  return async () => {
    const users = await brokerClient.assignedUsers({ completeOnly: false });
    return desiredFingerprints(users, seedSnapshot);
  };
}

export function createSystemConfigMutationGatedRpc(
  rpc: GatewayRpcClient,
  openclawDir: string,
  deps: {
    acquireLease?: typeof acquireSystemConfigMutationLease;
    wait?: (delayMs: number) => Promise<void>;
  } = {},
): GatewayRpcClient {
  const acquireLease = deps.acquireLease ?? acquireSystemConfigMutationLease;
  const wait = deps.wait ?? ((delayMs: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  return new Proxy(rpc, {
    get(target, property, receiver) {
      if (property !== "configApply" && property !== "configPatch") {
        return Reflect.get(target, property, receiver) as unknown;
      }
      const mutation = Reflect.get(target, property, target) as (...args: unknown[]) => Promise<unknown>;
      return async (...args: unknown[]) => {
        let acquired = await acquireLease({ openclawDir });
        for (const delayMs of SYSTEM_CONFIG_MUTATION_LEASE_RETRY_DELAYS_MS) {
          if (acquired.ok || acquired.code !== "writer-lock-busy") break;
          await wait(delayMs);
          acquired = await acquireLease({ openclawDir });
        }
        if (!acquired.ok) {
          throw new Error(`system config mutation unavailable: ${acquired.code}`);
        }
        try {
          return await Reflect.apply(mutation, target, args);
        } finally {
          await acquired.lease.release();
        }
      };
    },
  });
}

export function createFleetControllerMutationGatedRpc(
  openclawDir: string = OPENCLAW_DIR,
  createRpc?: typeof createGatewayRpc,
): GatewayRpcClient {
  const runtimeRpc = createRpc
    ? createRpc({
        allowLegacyGatewayTokenFallback: true,
        callTimeoutMs: FLEET_CONTROLLER_MUTATION_CALL_TIMEOUT_MS,
      })
    : createGatewayRpc({
        allowLegacyGatewayTokenFallback: true,
        callTimeoutMs: FLEET_CONTROLLER_MUTATION_CALL_TIMEOUT_MS,
      });
  return createSystemConfigMutationGatedRpc(runtimeRpc, openclawDir);
}

async function main(): Promise<void> {
  const entrypointConfig = resolveFleetControllerEntrypointConfig();
  log(bootBanner("fleet-controller"));
  const rpc = createFleetControllerMutationGatedRpc();
  const openclawVersion = probeOpenClawVersion({
    execFile: execFileSync,
    binaryPath: "/usr/local/bin/openclaw",
  });
  if (!entrypointConfig.publicKey) {
    throw new Error("fleet controller public key unavailable: expected FLEET_CONTROLLER_PUBLIC_KEY");
  }
  const builder = isBuilderGateway();
  const brokerClient = createFleetBrokerClient(entrypointConfig.gatewayId);
  const adapter = buildBrokeredLifecycleAdapter({
    client: brokerClient,
    rpc,
    log,
    adminMmUserId: process.env.MM_ADMIN_USER_ID,
    isBuilderGateway,
    projectCheckoutScope: () => projectCheckoutScopeForRuntime(),
  });
  const fleetHandle = await startFleetController({
    rpc,
    adapter,
    gatewayId: entrypointConfig.gatewayId,
    log,
    port: entrypointConfig.port,
    publicKey: entrypointConfig.publicKey,
    version: entrypointConfig.version,
    openclawVersion,
    openclawDir: OPENCLAW_DIR,
    platformState: !builder,
    localReconcile: true,
    readDesiredFingerprints: createAssignedFingerprintReader(
      brokerClient,
      adapter.seedUserSnapshotForMigration,
    ),
    stampMounted: (uid, mounted) => brokerClient.setMounted(uid, mounted),
    recordReconcileError: (slug, message) => brokerClient.recordReconcileError(slug, message),
    clearReconcileError: (slug) => brokerClient.clearReconcileError(slug),
    flushLocalState: async ({ slug, reason, expectedSystemConfigCommit }) => {
      log(`[fleet] controller-requested flush slug=${slug} reason=${reason}`);
      return runGatewayPreStopFlush({
        gatewayId: entrypointConfig.gatewayId,
        gatewayClass: GATEWAY_CLASS,
        syncWorkspaces: () => syncCustomerRepositoriesForSlug(slug, { strict: true }),
        syncBlobs: builder
          ? undefined
          : () => blobSyncForSlug(slug, {
              strict: true,
              store: createBrokeredBlobStore(brokerClient),
            }),
        syncSystemConfig: builder
          ? createFleetSystemConfigFlush(
              slug,
              log,
              syncSystemConfigForSlug,
              expectedSystemConfigCommit,
            )
          : createFleetSharedSystemConfigFlush(slug, expectedSystemConfigCommit),
        log,
      });
    },
    // Db-less: gateway pods hold NO Firestore credentials. Cowboy polls
    // /health and writes gateways/{id} on the trusted side. Gateway pods run
    // only the local mount reconcile from brokered assigned snapshots; all
    // trusted-side provisioning mutations go through octogee-api.
    reportState: false,
    internalServiceKey: process.env.OPENCLAW_GATEWAY_TOKEN ?? "",
  });
  // Durable-config runtime health: refresh + broker publish, replacing the
  // retired status server (the probes moved to :3003/health and OpenClaw's own
  // :18789; GATEWAY-SIMPLE-ROLL-SPEC).
  const runtimeHealthPublisher = entrypointConfig.builderSlug
    ? createSystemConfigStatusPublisher({
        openclawDir: OPENCLAW_DIR,
        refreshRuntimeHealth: () => refreshSystemConfigRuntimeHealth({
          openclawDir: OPENCLAW_DIR,
          env: process.env,
          probeOpenClaw: () => probeOpenClawHealth(process.env.OPENCLAW_HEALTH_URL),
        }),
        publish: (status) => brokerClient.recordSystemConfigStatus(status),
        log,
      })
    : null;
  void runtimeHealthPublisher?.publishNow();

  const autosaveTimer = startWorkspaceAutosaveLoop(
    {
      envValue: process.env.WORKSPACE_AUTOSAVE_ENABLED,
      isBuilderGateway,
      syncWorkspaces: syncAllWorkspaces,
      syncBlobs: builder
        ? undefined
        : () => blobSyncAllWithOptions({
            storeForSlug: () => createBrokeredBlobStore(brokerClient!),
          }),
      log,
    },
    GIT_SYNC_INTERVAL_MS,
  );
  const usageTimer = builder
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
    runtimeHealthPublisher?.close();
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
