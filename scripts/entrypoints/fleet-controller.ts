import {
  AGENT_PREFIX,
  AGENTS_DIR,
  bootBanner,
  GATEWAY_ID,
  GATEWAY_PROFILE,
  GIT_SYNC_INTERVAL_MS,
  isOperatorGateway,
  log,
  OPENCLAW_DIR,
} from "../lib/config.js";
import { createGatewayRpc } from "../lib/gateway-rpc.js";
import { syncAllWorkspaces } from "../lib/git.js";
import { buildBrokeredLifecycleAdapter } from "../lib/customer-lifecycle-broker-adapter.js";
import { blobSyncAllWithOptions } from "../lib/blob-sync.js";
import { createBrokeredBlobStore } from "../lib/blob-sync-broker.js";
import { startCustomerSignalScanLoop } from "../lib/customer-signal-broker-runner.js";
import { createFleetBrokerClient } from "../lib/fleet-broker-client.js";
import { startFleetController } from "../lib/fleet-provisioner.js";
import { probeOpenClawVersion } from "../lib/probe-openclaw-version.js";
import { startUsageEventTailer } from "../lib/usage-log-tailer.js";
import { startWorkspaceAutosaveLoop } from "../lib/workspace-autosave-runner.js";
import { execFileSync } from "node:child_process";

const MY_GATEWAY_ID = GATEWAY_ID === "local" ? "default" : GATEWAY_ID;

async function main(): Promise<void> {
  log(bootBanner("fleet-controller"));
  const rpc = createGatewayRpc({
    allowLegacyGatewayTokenFallback: true,
  });
  const openclawVersion = probeOpenClawVersion({
    execFile: execFileSync,
    binaryPath: "/usr/local/bin/openclaw",
  });
  const publicKey = process.env.FLEET_CONTROLLER_PUBLIC_KEY || "";
  if (!publicKey) {
    throw new Error("fleet controller public key unavailable: expected FLEET_CONTROLLER_PUBLIC_KEY");
  }
  const operator = isOperatorGateway();
  const brokerClient = createFleetBrokerClient(MY_GATEWAY_ID);
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
    gatewayId: MY_GATEWAY_ID,
    log,
    port: parseInt(process.env.FLEET_CONTROLLER_PORT ?? "3003", 10),
    publicKey,
    version: process.env.BUILD_SHA ?? "unknown",
    openclawVersion,
    openclawDir: OPENCLAW_DIR,
    platformState: !operator,
    localReconcile: true,
    readDesiredSlugs: async () => {
      const users = await brokerClient.assignedUsers({ completeOnly: false });
      return users.map((user) => user.slug);
    },
    stampMounted: (uid, mounted) => brokerClient.setMounted(uid, mounted),
    recordReconcileError: (slug, message) => brokerClient.recordReconcileError(slug, message),
    clearReconcileError: (slug) => brokerClient.clearReconcileError(slug),
    // Db-less: gateway pods hold NO Firestore credentials. Cowboy polls
    // /health and writes gateways/{id} on the trusted side. Gateway pods run
    // only the local mount reconcile from brokered assigned snapshots; all
    // trusted-side provisioning mutations go through octogee-api.
    reportState: false,
    enableDeviceAuthRoutes: !operator,
    internalServiceKey: "",
  });

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
        gatewayId: MY_GATEWAY_ID,
      });
  const signalScanTimer = operator
    ? null
    : startCustomerSignalScanLoop({ client: brokerClient!, log });

  log(`Local fleet controller running (profile=${GATEWAY_PROFILE}). Press Ctrl+C to stop.`);
  const cleanup = async () => {
    if (autosaveTimer) clearInterval(autosaveTimer);
    if (usageTimer) clearInterval(usageTimer);
    if (signalScanTimer) clearInterval(signalScanTimer);
    try { await fleetHandle.stop(); } catch {}
    try { await rpc.close(); } catch {}
  };
  process.on("SIGINT", () => { cleanup().finally(() => process.exit(0)).catch(() => process.exit(0)); });
  process.on("SIGTERM", () => { cleanup().finally(() => process.exit(0)).catch(() => process.exit(0)); });
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
