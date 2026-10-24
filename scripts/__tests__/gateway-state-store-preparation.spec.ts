import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GATEWAY_OWNER_RECOVERY_WAIT_MS,
  GATEWAY_OWNER_STALE_MS,
  prepareGatewayStateStore,
  recoverDepartedGatewayOwner,
  type StateStoreQuery,
} from "../lib/gateway-state-store-preparation.js";

const GATEWAY = "jane-s-1a2b3c4d";
const THIS_POD = `octogee-gateway-${GATEWAY}-7f9c5d8b6-new01`;
const DEPARTED_POD = `octogee-gateway-${GATEWAY}-7f9c5d8b6-old01`;
const anchor = { storeId: "92c817cc-770f-466d-b4a6-4e9b02998363", schema: "octogee_state_92c817cc770f466d" };

function leaseStore(initial: { owner: string; heartbeatAt: number; host: string } | null) {
  let row = initial ? { ...initial } : null;
  const deletes: unknown[][] = [];
  const query: StateStoreQuery = async (_anchor, sql, values = []) => {
    if (sql.startsWith("SELECT")) {
      return row ? [{ owner: row.owner, heartbeat_at: String(row.heartbeatAt), payload_json: JSON.stringify({ owner: { pid: 42, host: row.host } }) }] : [];
    }
    deletes.push(values);
    if (row && values[0] === row.owner && values[1] === String(row.heartbeatAt)) {
      row = null;
      return [{ owner: values[0] }];
    }
    return [];
  };
  return { query, deletes, current: () => row, renew: (heartbeatAt: number) => { if (row) row.heartbeatAt = heartbeatAt; } };
}

function clock(start: number) {
  let time = start;
  return { now: () => time, sleep: async (ms: number) => { time += ms; } };
}

describe("recoverDepartedGatewayOwner", () => {
  it("leaves an absent lease and one held by this pod to OpenClaw", async () => {
    const empty = leaseStore(null);
    await expect(recoverDepartedGatewayOwner({ anchor, gatewayId: GATEWAY, hostname: THIS_POD, log: () => {}, query: empty.query })).resolves.toBe("absent");
    const own = leaseStore({ owner: "o1", heartbeatAt: 0, host: THIS_POD });
    await expect(recoverDepartedGatewayOwner({ anchor, gatewayId: GATEWAY, hostname: THIS_POD, log: () => {}, query: own.query, ...clock(10 * 60_000) })).resolves.toBe("this-pod");
    expect(own.deletes).toEqual([]);
  });

  it("refuses to touch a lease held by another gateway's pod", async () => {
    const foreign = leaseStore({ owner: "o1", heartbeatAt: 0, host: "octogee-gateway-other-s-99999999-7f9c5d8b6-x1" });
    await expect(recoverDepartedGatewayOwner({ anchor, gatewayId: GATEWAY, hostname: THIS_POD, log: () => {}, query: foreign.query, ...clock(10 * 60_000) }))
      .rejects.toThrow(/not a pod of gateway/);
    expect(foreign.deletes).toEqual([]);
    expect(foreign.current()).not.toBeNull();
  });

  it("removes exactly the stale lease of a departed pod of this gateway", async () => {
    const start = 1_000_000;
    const departed = leaseStore({ owner: "o1", heartbeatAt: start - GATEWAY_OWNER_STALE_MS - 1, host: DEPARTED_POD });
    const logs: string[] = [];
    await expect(recoverDepartedGatewayOwner({ anchor, gatewayId: GATEWAY, hostname: THIS_POD, log: (m) => logs.push(m), query: departed.query, ...clock(start) }))
      .resolves.toBe("recovered");
    expect(departed.deletes).toEqual([["o1", String(start - GATEWAY_OWNER_STALE_MS - 1)]]);
    expect(departed.current()).toBeNull();
    expect(logs.join("\n")).toContain(`departed pod ${DEPARTED_POD}`);
  });

  it("waits for a recently renewed lease to go stale before removing it", async () => {
    const start = 1_000_000;
    const recent = leaseStore({ owner: "o1", heartbeatAt: start - 10_000, host: DEPARTED_POD });
    const time = clock(start);
    await expect(recoverDepartedGatewayOwner({ anchor, gatewayId: GATEWAY, hostname: THIS_POD, log: () => {}, query: recent.query, ...time }))
      .resolves.toBe("recovered");
    expect(time.now() - (start - 10_000)).toBeGreaterThanOrEqual(GATEWAY_OWNER_STALE_MS);
    expect(recent.current()).toBeNull();
  });

  it("refuses a holder that keeps renewing until the wait ends", async () => {
    const start = 1_000_000;
    const live = leaseStore({ owner: "o1", heartbeatAt: start, host: DEPARTED_POD });
    const time = clock(start);
    const sleep = async (ms: number) => { await time.sleep(ms); live.renew(time.now()); };
    await expect(recoverDepartedGatewayOwner({ anchor, gatewayId: GATEWAY, hostname: THIS_POD, log: () => {}, query: live.query, now: time.now, sleep }))
      .rejects.toThrow(/refusing to recover a live holder/);
    expect(time.now() - start).toBeGreaterThanOrEqual(GATEWAY_OWNER_RECOVERY_WAIT_MS);
    expect(live.current()).not.toBeNull();
  });
});

describe("prepareGatewayStateStore", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  function stateRoot(kind: "anchor" | "sqlite", credentials: boolean): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-state-store-"));
    roots.push(root);
    fs.mkdirSync(path.join(root, "state"));
    const db = new DatabaseSync(path.join(root, "state", "openclaw.sqlite"));
    if (kind === "anchor") {
      db.exec("CREATE TABLE openclaw_engine_anchor (store_id TEXT NOT NULL, engine TEXT NOT NULL, schema TEXT NOT NULL)");
      db.prepare("INSERT INTO openclaw_engine_anchor VALUES (?, 'postgres', ?)").run(anchor.storeId, anchor.schema);
    } else {
      db.exec("CREATE TABLE cron_jobs (id TEXT)");
    }
    db.close();
    if (credentials) {
      fs.mkdirSync(path.join(root, "client"));
      fs.writeFileSync(path.join(root, "client", "credentials.sqlite"), "");
    }
    return root;
  }

  const builderEnv = (root: string) => ({ GATEWAY_CLASS: "builder", GATEWAY_RUNTIME_KIND: "cluster", GATEWAY_ID: GATEWAY, OPENCLAW_STATE_DIR: root });

  it("does nothing outside a cluster Builder or for SQLite state", async () => {
    const recover = vi.fn();
    const run = vi.fn();
    const anchored = stateRoot("anchor", false);
    await prepareGatewayStateStore({ log: () => {}, env: { ...builderEnv(anchored), GATEWAY_RUNTIME_KIND: "gce-vm" }, recover, run });
    await prepareGatewayStateStore({ log: () => {}, env: { ...builderEnv(anchored), GATEWAY_CLASS: "shared" }, recover, run });
    await prepareGatewayStateStore({ log: () => {}, env: builderEnv(stateRoot("sqlite", false)), recover, run });
    expect(recover).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("recovers the owner lease and keeps existing local credentials", async () => {
    const recover = vi.fn(async () => "recovered" as const);
    const run = vi.fn();
    await prepareGatewayStateStore({ log: () => {}, env: builderEnv(stateRoot("anchor", true)), hostname: THIS_POD, recover, run });
    expect(recover).toHaveBeenCalledWith(expect.objectContaining({ anchor, gatewayId: GATEWAY, hostname: THIS_POD }));
    expect(run).not.toHaveBeenCalled();
  });

  it("rebinds fresh client credentials after the owner lease when they are missing", async () => {
    const order: string[] = [];
    const recover = vi.fn(async () => { order.push("recover"); return "absent" as const; });
    const run = vi.fn(async () => { order.push("rebind"); return { code: 0, stdout: "" }; });
    const root = stateRoot("anchor", false);
    await prepareGatewayStateStore({ log: () => {}, env: builderEnv(root), hostname: THIS_POD, recover, run });
    expect(order).toEqual(["recover", "rebind"]);
    expect(run).toHaveBeenCalledWith(
      ["doctor", "--fix", "--yes", "--non-interactive"],
      { env: builderEnv(root) },
    );
  });

  it("fails the start when the credential rebind fails", async () => {
    const run = vi.fn(async () => ({ code: 1, stdout: "", stderr: "Gateway owner is still live" }));
    await expect(prepareGatewayStateStore({ log: () => {}, env: builderEnv(stateRoot("anchor", false)), hostname: THIS_POD, recover: async () => "absent", run }))
      .rejects.toThrow(/client credential rebind failed \(exit 1\): Gateway owner is still live/);
  });
});
