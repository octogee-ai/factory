import {
  bootBanner,
  GATEWAY_ID,
  log,
  OPENCLAW_DIR,
} from "../lib/config.js";
import { createGatewayRpc } from "../lib/gateway-rpc.js";
import { buildLocalMigrationAdapter } from "../lib/fleet-local-migration-adapter.js";
import { startFleetController } from "../lib/fleet-provisioner.js";
import { probeOpenClawVersion } from "../lib/probe-openclaw-version.js";
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
  const fleetHandle = await startFleetController({
    rpc,
    adapter: buildLocalMigrationAdapter({ rpc, log }),
    gatewayId: MY_GATEWAY_ID,
    log,
    port: parseInt(process.env.FLEET_CONTROLLER_PORT ?? "3003", 10),
    secret,
    version: process.env.BUILD_SHA ?? "unknown",
    openclawVersion,
    openclawDir: OPENCLAW_DIR,
    platformState: false,
    // Db-less: operator pods hold NO Firestore credentials (customer-controlled,
    // danger-full-access agent — a shelled or prompt-injected pod must not reach any
    // tenant's data). Cowboy polls /health and writes gateways/{id} on the trusted
    // side, and drives eviction via /unmount (OPERATOR-GATEWAY-PULL-REPORTING). This
    // process serves only /health + the migration endpoints.
    reportState: false,
    internalServiceKey: "",
  });

  log("Local fleet controller running. Press Ctrl+C to stop.");
  const cleanup = async () => {
    try { await fleetHandle.stop(); } catch {}
    try { await rpc.close(); } catch {}
  };
  process.on("SIGINT", () => { cleanup().finally(() => process.exit(0)).catch(() => process.exit(0)); });
  process.on("SIGTERM", () => { cleanup().finally(() => process.exit(0)).catch(() => process.exit(0)); });
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
