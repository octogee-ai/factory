import * as fs from "node:fs";
import * as os from "node:os";
import { queryAgentStore, readPostgresAgentAnchor, type PostgresAgentAnchor } from "@octogee/core/agent-postgres";
import { podBelongsToGateway } from "@octogee/core/gateway-live-release";
import { runOpenClaw, type OpenClawCommand } from "./openclaw-cli.js";
import { clientCredentialStorePath, clusterBuilderGateway, localStateStorePath, openclawStateRoot } from "./openclaw-state-store.js";

export const GATEWAY_OWNER_STALE_MS = 90_000;
export const GATEWAY_OWNER_RECOVERY_WAIT_MS = 4 * 60_000;
const GATEWAY_OWNER_POLL_MS = 5_000;

export type StateStoreQuery = (anchor: PostgresAgentAnchor, sql: string, values?: unknown[]) => Promise<Record<string, unknown>[]>;

const SELECT_GATEWAY_OWNER =
  "SELECT owner, heartbeat_at, payload_json FROM $schema.state_leases WHERE scope = 'gateway-owner' AND lease_key = 'global'";
const DELETE_GATEWAY_OWNER =
  "DELETE FROM $schema.state_leases WHERE scope = 'gateway-owner' AND lease_key = 'global' AND owner = $1 AND heartbeat_at = $2 RETURNING owner";

interface GatewayOwnerLease {
  owner: string;
  heartbeatAt: string;
  host: string | null;
}

function holderHost(payload: unknown): string | null {
  try {
    const owner = (JSON.parse(String(payload)) as { owner?: { host?: unknown } }).owner;
    return typeof owner?.host === "string" ? owner.host : null;
  } catch {
    return null;
  }
}

async function readGatewayOwner(query: StateStoreQuery, anchor: PostgresAgentAnchor): Promise<GatewayOwnerLease | null> {
  const [row] = await query(anchor, SELECT_GATEWAY_OWNER);
  if (!row) return null;
  return { owner: String(row.owner), heartbeatAt: String(row.heartbeat_at), host: holderHost(row.payload_json) };
}

export async function recoverDepartedGatewayOwner(input: {
  anchor: PostgresAgentAnchor;
  gatewayId: string;
  hostname: string;
  log: (message: string) => void;
  query?: StateStoreQuery;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<"absent" | "this-pod" | "recovered"> {
  const query = input.query ?? ((anchor, sql, values) => queryAgentStore(anchor, sql, values));
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + GATEWAY_OWNER_RECOVERY_WAIT_MS;
  let waiting = false;
  for (;;) {
    const lease = await readGatewayOwner(query, input.anchor);
    if (!lease) return "absent";
    if (lease.host === input.hostname) return "this-pod";
    if (!lease.host || !podBelongsToGateway(input.gatewayId, lease.host)) {
      throw new Error(`state owner ${lease.host ?? "<unreadable>"} is not a pod of gateway ${input.gatewayId}; refusing to recover its lease`);
    }
    const ageMs = now() - Number(lease.heartbeatAt);
    if (ageMs >= GATEWAY_OWNER_STALE_MS) {
      const removed = await query(input.anchor, DELETE_GATEWAY_OWNER, [lease.owner, lease.heartbeatAt]);
      if (removed.length === 1) {
        input.log(`[state-store] recovered the state owner lease of departed pod ${lease.host} (heartbeat ${Math.round(ageMs / 1000)}s old)`);
        return "recovered";
      }
    } else if (!waiting) {
      input.log(`[state-store] waiting for the state owner lease of pod ${lease.host} to go stale`);
      waiting = true;
    }
    if (now() >= deadline) {
      throw new Error(`state owner ${lease.host} renewed its lease ${Math.round(ageMs / 1000)}s ago; refusing to recover a live holder`);
    }
    await sleep(Math.max(1_000, Math.min(GATEWAY_OWNER_POLL_MS, GATEWAY_OWNER_STALE_MS - ageMs)));
  }
}

export async function prepareGatewayStateStore(input: {
  log: (message: string) => void;
  env?: NodeJS.ProcessEnv;
  hostname?: string;
  run?: OpenClawCommand;
  recover?: typeof recoverDepartedGatewayOwner;
}): Promise<void> {
  const env = input.env ?? process.env;
  if (!clusterBuilderGateway(env)) return;
  const stateRoot = openclawStateRoot(env);
  const anchor = readPostgresAgentAnchor(localStateStorePath(stateRoot));
  if (!anchor) return;
  await (input.recover ?? recoverDepartedGatewayOwner)({
    anchor,
    gatewayId: env.GATEWAY_ID?.trim() ?? "",
    hostname: input.hostname ?? os.hostname(),
    log: input.log,
  });
  if (fs.existsSync(clientCredentialStorePath(stateRoot))) return;
  input.log("[state-store] local client credentials are missing for the PostgreSQL state store; rebinding fresh local credentials (local clients pair again)");
  const result = await (input.run ?? runOpenClaw)(
    ["doctor", "--fix", "--yes", "--non-interactive"],
    { env },
  );
  if (result.code !== 0) {
    throw new Error(`client credential rebind failed (exit ${result.code}): ${(result.stderr || result.stdout).trim().slice(-400)}`);
  }
}
