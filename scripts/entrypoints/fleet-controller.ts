import {
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
import { buildLocalMigrationAdapter } from "../lib/fleet-local-migration-adapter.js";
import { buildBrokeredLifecycleAdapter } from "../lib/customer-lifecycle-broker-adapter.js";
import { createFleetBrokerClient } from "../lib/fleet-broker-client.js";
import { startFleetController } from "../lib/fleet-provisioner.js";
import { probeOpenClawVersion } from "../lib/probe-openclaw-version.js";
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
  const secret = process.env.FLEET_CONTROLLER_SECRET || process.env.OPENCLAW_GATEWAY_TOKEN || "";
  if (!secret) {
    throw new Error("fleet controller secret unavailable: expected FLEET_CONTROLLER_SECRET or OPENCLAW_GATEWAY_TOKEN");
  }
  const operator = isOperatorGateway();
  const brokerClient = operator ? null : createFleetBrokerClient(MY_GATEWAY_ID);
  const adapter = operator
    ? buildLocalMigrationAdapter({ rpc, log })
    : buildBrokeredLifecycleAdapter({
        client: brokerClient!,
        rpc,
        log,
        adminMmUserId: process.env.MM_ADMIN_USER_ID,
      });
  const fleetHandle = await startFleetController({
    rpc,
    adapter,
    gatewayId: MY_GATEWAY_ID,
    log,
    port: parseInt(process.env.FLEET_CONTROLLER_PORT ?? "3003", 10),
    secret,
    version: process.env.BUILD_SHA ?? "unknown",
    openclawVersion,
    openclawDir: OPENCLAW_DIR,
    platformState: !operator,
    readDesiredSlugs: operator
      ? undefined
      : async () => {
          const users = await brokerClient!.assignedUsers({ completeOnly: false });
          return users.map((user) => user.slug);
        },
    stampMounted: operator
      ? undefined
      : (uid, mounted) => brokerClient!.setMounted(uid, mounted),
    recordReconcileError: operator
      ? undefined
      : (slug, message) => brokerClient!.recordReconcileError(slug, message),
    clearReconcileError: operator
      ? undefined
      : (slug) => brokerClient!.clearReconcileError(slug),
    // Db-less: gateway pods hold NO Firestore credentials. Cowboy polls
    // /health and writes gateways/{id} on the trusted side. Standard pods run
    // only the local mount reconcile from brokered assigned snapshots; all
    // trusted-side provisioning mutations go through octogee-api.
    reportState: false,
    internalServiceKey: "",
  });

  const autosaveTimer = startWorkspaceAutosaveLoop(
    {
      envValue: process.env.WORKSPACE_AUTOSAVE_ENABLED,
      isOperatorGateway,
      syncWorkspaces: syncAllWorkspaces,
      log,
    },
    GIT_SYNC_INTERVAL_MS,
  );

  log(`Local fleet controller running (profile=${GATEWAY_PROFILE}). Press Ctrl+C to stop.`);
  const cleanup = async () => {
    if (autosaveTimer) clearInterval(autosaveTimer);
    try { await fleetHandle.stop(); } catch {}
    try { await rpc.close(); } catch {}
  };
  process.on("SIGINT", () => { cleanup().finally(() => process.exit(0)).catch(() => process.exit(0)); });
  process.on("SIGTERM", () => { cleanup().finally(() => process.exit(0)).catch(() => process.exit(0)); });
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
