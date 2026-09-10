import { describe, expect, it, vi } from "vitest";
import { FieldValue } from "firebase-admin/firestore";
import { runNativeReturnHoldReaperTick } from "../native-return-hold-reaper.js";

const NOW = 1_700_000_000_000;

function harness(input: {
  gateways: Record<string, Record<string, any>>;
  operations?: Record<string, Record<string, any>>;
  mirrorStale?: boolean;
}) {
  const docs: Record<string, Record<string, any>> = {};
  for (const [id, data] of Object.entries(input.gateways)) docs[`glmGateways/${id}`] = data;
  for (const [id, data] of Object.entries(input.operations ?? {})) docs[`glmOperations/${id}`] = data;
  const snapshot = (path: string) => ({ id: path.split("/")[1], exists: !!docs[path], data: () => docs[path] });
  const writes: Array<{ path: string; op: string; data: Record<string, unknown> }> = [];
  const applyUpdate = (path: string, data: Record<string, unknown>) => {
    writes.push({ path, op: "update", data });
    for (const [key, value] of Object.entries(data)) {
      const [parent, field] = key.split(".");
      if (value instanceof FieldValue) delete docs[path][parent][field];
      else docs[path][parent][field] = value;
    }
  };
  const ref = (path: string) => ({
    path,
    get: async () => snapshot(path),
  });
  const db = {
    collection: (collection: string) => ({
      doc: (id: string) => ref(`${collection}/${id}`),
      get: async () => ({ docs: Object.keys(input.gateways).map((id) => snapshot(`glmGateways/${id}`)) }),
    }),
    runTransaction: async (body: (tx: unknown) => Promise<unknown>) => body({
      get: async (r: { path: string }) => snapshot(r.path),
      update: (r: { path: string }, data: Record<string, unknown>) => applyUpdate(r.path, data),
      set: (r: { path: string }, data: Record<string, unknown>) => { writes.push({ path: r.path, op: "set", data }); docs[r.path] = data; },
    }),
  };
  const scan = vi.fn(db.collection("glmGateways").get);
  db.collection = ((collection: string) => ({
    doc: (id: string) => ref(`${collection}/${id}`),
    get: scan,
  })) as typeof db.collection;
  const informer = {
    glmGateways: () => (input.mirrorStale
      ? null
      : Object.keys(input.gateways).map((id) => snapshot(`glmGateways/${id}`))),
  };
  const log = vi.fn();
  const deps = { db: db as never, informer: informer as never, log, now: () => NOW };
  return { deps, docs, writes, log, scan };
}

const heldGateway = (returnOperationId: string) => ({
  runtime: "gce-vm",
  vm: { instanceName: "computer" },
  vmHome: { returnOperationId, checkpointRequestedAt: 500, parkRequestedAt: 500, lastCheckpoint: { completedAt: 400 } },
});

describe("native return hold reaper", () => {
  it.each(["failed", "succeeded", "rolled-back"])(
    "releases a hold whose return operation is %s and journals the release",
    async (status) => {
      const h = harness({
        gateways: { native: heldGateway("builder-return-native") },
        operations: { "builder-return-native": { kind: "migrate-customer", status } },
      });
      const result = await runNativeReturnHoldReaperTick(h.deps);
      expect(result).toEqual({ scanned: 1, released: 1 });
      expect(h.docs["glmGateways/native"].vmHome).toEqual({ lastCheckpoint: { completedAt: 400 } });
      const journal = h.docs["glmOperations/native-return-hold-release-native-builder-return-native"];
      expect(journal).toMatchObject({
        kind: "migrate-customer",
        status: "succeeded",
        origin: "automatic",
        createdBy: "glm-controller-native-return-hold-reaper",
        createdAt: NOW,
        completedAt: NOW,
        gatewayId: "native",
        input: { gatewayId: "native", returnOperationId: "builder-return-native", returnOperationStatus: status },
        output: { released: true },
      });
      expect(journal.expireAt).toBeDefined();
      expect(h.log).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`native-return-hold-reaper.*native.*builder-return-native is ${status}`)));
    },
  );

  it("releases a hold whose return operation no longer exists", async () => {
    const h = harness({ gateways: { native: heldGateway("builder-return-native") } });
    expect(await runNativeReturnHoldReaperTick(h.deps)).toEqual({ scanned: 1, released: 1 });
    expect(h.docs["glmGateways/native"].vmHome.returnOperationId).toBeUndefined();
    expect(h.docs["glmOperations/native-return-hold-release-native-builder-return-native"].input)
      .toMatchObject({ returnOperationStatus: "missing" });
  });

  it.each(["pending", "running"])("keeps the hold while the return operation is %s", async (status) => {
    const h = harness({
      gateways: { native: heldGateway("builder-return-native") },
      operations: { "builder-return-native": { kind: "migrate-customer", status } },
    });
    expect(await runNativeReturnHoldReaperTick(h.deps)).toEqual({ scanned: 1, released: 0 });
    expect(h.writes).toEqual([]);
    expect(h.docs["glmGateways/native"].vmHome.returnOperationId).toBe("builder-return-native");
  });

  it("ignores gateways without a return hold, including plain park checkpoints", async () => {
    const h = harness({
      gateways: {
        parked: { runtime: "gce-vm", vmHome: { checkpointRequestedAt: 500, parkRequestedAt: 500 } },
        cluster: { runtime: "cluster" },
      },
    });
    expect(await runNativeReturnHoldReaperTick(h.deps)).toEqual({ scanned: 2, released: 0 });
    expect(h.writes).toEqual([]);
  });

  it("re-checks the hold inside the transaction and leaves a hold that moved to another operation", async () => {
    const h = harness({
      gateways: { native: heldGateway("builder-return-native") },
      operations: { "builder-return-native": { kind: "migrate-customer", status: "failed" } },
    });
    const original = h.deps.db.runTransaction;
    h.deps.db.runTransaction = (async (body: (tx: unknown) => Promise<unknown>) => {
      h.docs["glmGateways/native"].vmHome.returnOperationId = "builder-return-native-2";
      return original(body);
    }) as typeof original;
    expect(await runNativeReturnHoldReaperTick(h.deps)).toEqual({ scanned: 1, released: 0 });
    expect(h.writes).toEqual([]);
  });

  it("does not journal twice when the release journal already exists", async () => {
    const h = harness({
      gateways: { native: heldGateway("builder-return-native") },
      operations: {
        "builder-return-native": { kind: "migrate-customer", status: "failed" },
        "native-return-hold-release-native-builder-return-native": { status: "succeeded", createdAt: 1 },
      },
    });
    expect(await runNativeReturnHoldReaperTick(h.deps)).toEqual({ scanned: 1, released: 1 });
    expect(h.docs["glmGateways/native"].vmHome.returnOperationId).toBeUndefined();
    expect(h.docs["glmOperations/native-return-hold-release-native-builder-return-native"].createdAt).toBe(1);
    expect(h.writes.filter((w) => w.op === "set")).toEqual([]);
  });

  it("falls back to a scan when the glmGateways mirror is stale", async () => {
    const h = harness({
      gateways: { native: heldGateway("builder-return-native") },
      operations: { "builder-return-native": { kind: "migrate-customer", status: "failed" } },
      mirrorStale: true,
    });
    expect(await runNativeReturnHoldReaperTick(h.deps)).toEqual({ scanned: 1, released: 1 });
    expect(h.scan).toHaveBeenCalledOnce();
  });
});
