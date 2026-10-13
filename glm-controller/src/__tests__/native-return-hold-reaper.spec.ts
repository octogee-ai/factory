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
  for (const [id, data] of Object.entries(input.gateways)) {
    docs[`glmGateways/${id}`] = data;
    docs[`gateways/${id}`] = { gatewayClass: "builder", ownerUid: "alice", builderSlug: "alice", desiredStatus: "paused" };
  }
  for (const [id, data] of Object.entries(input.operations ?? {})) docs[`glmOperations/${id}`] = data;
  const snapshot = (path: string) => ({ id: path.split("/")[1], exists: !!docs[path], data: () => structuredClone(docs[path]) });
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
  const vm = { describe: vi.fn(async (): Promise<{ status: string; instanceId: string } | null> => ({ status: "TERMINATED", instanceId: "vm-1" })) };
  const deps = { vm: vm as never, db: db as never, informer: informer as never, log, now: () => NOW };
  return { deps, docs, writes, log, scan, vm };
}

const heldGateway = (returnOperationId: string) => ({
  runtime: "gce-vm",
  vm: { instanceName: "computer", instanceId: "vm-1", zone: "us-central1-a" },
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

  it.each(["failed", "succeeded", "missing"])("retains a %s operation's hold while Compute still runs", async status => {
    const h = harness({ gateways: { native: heldGateway("return-op") },
      operations: status === "missing" ? {} : { "return-op": { kind: "migrate-customer", status, cutoverCommittedAt: 600 } } });
    h.vm.describe.mockResolvedValue({ status: "RUNNING", instanceId: "vm-1" });
    expect(await runNativeReturnHoldReaperTick(h.deps)).toEqual({ scanned: 1, released: 0 });
    expect(h.writes).toEqual([]);
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

  it.each([{ kind: "migrate-customer" }, { kind: "migrate-customer", status: 7 }])(
    "keeps the hold and logs when the return operation record is malformed (%o), still sweeping other gateways",
    async (operation) => {
      const h = harness({
        gateways: { broken: heldGateway("builder-return-broken"), native: heldGateway("builder-return-native") },
        operations: {
          "builder-return-broken": operation,
          "builder-return-native": { kind: "migrate-customer", status: "failed" },
        },
      });
      expect(await runNativeReturnHoldReaperTick(h.deps)).toEqual({ scanned: 2, released: 1 });
      expect(h.docs["glmGateways/broken"].vmHome.returnOperationId).toBe("builder-return-broken");
      expect(h.docs["glmGateways/native"].vmHome.returnOperationId).toBeUndefined();
      expect(h.log).toHaveBeenCalledWith(expect.stringMatching(/native-return-hold-reaper.*broken.*builder-return-broken.*malformed status/));
    },
  );

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
  it.each(["STOPPING", "replacement", "read-failure", "binding-missing"])("retains terminal holds without exact stop proof: %s", async kind => {
    const h = harness({ gateways: { native: heldGateway("return-op") }, operations: { "return-op": { status: "failed" } } });
    if (kind === "STOPPING") h.vm.describe.mockResolvedValue({ status: "STOPPING", instanceId: "vm-1" });
    if (kind === "replacement") h.vm.describe.mockResolvedValue({ status: "STOPPED", instanceId: "vm-2" });
    if (kind === "read-failure") h.vm.describe.mockRejectedValue(new Error("Compute unavailable"));
    if (kind === "binding-missing") delete h.docs["glmGateways/native"].vm.instanceId;
    expect(await runNativeReturnHoldReaperTick(h.deps)).toMatchObject({ released: 0 }); expect(h.writes).toEqual([]);
  });

  it.each(["hold", "claim", "instance", "desired"])("revalidates %s after the Compute read", async kind => {
    const h = harness({ gateways: { native: heldGateway("return-op") }, operations: { "return-op": { status: "failed", startedAt: 1 } } });
    h.vm.describe.mockImplementation(async () => {
      if (kind === "hold") h.docs["glmGateways/native"].vmHome.checkpointRequestedAt = 501;
      if (kind === "claim") h.docs["glmOperations/return-op"] = { status: "running", startedAt: 2 };
      if (kind === "instance") h.docs["glmGateways/native"].vm.instanceId = "vm-2";
      if (kind === "desired") h.docs["gateways/native"].desiredStatus = "running";
      return { status: "TERMINATED", instanceId: "vm-1" };
    });
    expect(await runNativeReturnHoldReaperTick(h.deps)).toMatchObject({ released: 0 }); expect(h.writes).toEqual([]);
  });

  it("releases a proven uncommitted rollback while the source remains its owner's assigned runtime", async () => {
    const h = harness({ gateways: { native: heldGateway("return-op") }, operations: { "return-op": { kind: "migrate-customer", status: "rolled-back", input: { uid: "alice", fromGatewayId: "native" } } } });
    h.docs["gateways/native"].desiredStatus = "running";
    h.docs["users/alice"] = { provisioning: { openclaw: { gatewayId: "native" } } };
    h.vm.describe.mockResolvedValue({ status: "RUNNING", instanceId: "vm-1" });
    expect(await runNativeReturnHoldReaperTick(h.deps)).toMatchObject({ released: 1 }); expect(h.vm.describe).not.toHaveBeenCalled();
  });

  it("does not infer rollback from a missing operation even with an assigned running source", async () => {
    const h = harness({ gateways: { native: heldGateway("return-op") } });
    h.docs["gateways/native"].desiredStatus = "running";
    h.docs["users/alice"] = { provisioning: { openclaw: { gatewayId: "native" } } };
    expect(await runNativeReturnHoldReaperTick(h.deps)).toMatchObject({ released: 0 }); expect(h.writes).toEqual([]);
  });

});
