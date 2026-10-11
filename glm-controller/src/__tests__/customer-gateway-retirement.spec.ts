import { describe, expect, it, vi } from "vitest";

import { ensureOwnedGatewaysRetired } from "../lib/customer-ops/customer-gateway-retirement.js";

interface Root {
  ownerUid: string | null;
  gatewayClass: "shared" | "builder";
  desiredStatus: "running" | "paused" | "retired";
  allocation?: { kind: string; claimedByUid?: string; leaseId?: string; generation?: number };
  builderSlug?: string;
  retirementVersion?: number;
  retirementClaim?: { operationId: string; version: number; phase: string };
}

function harness(
  roots: Record<string, Root>,
  operations: Record<string, Record<string, unknown>> = {},
  users: Record<string, Record<string, unknown>> = {},
  runtimes: Record<string, Record<string, unknown>> = {},
  assignments: string[] = [],
  subcollections: Record<string, string[]> = {},
  recoveryReceipts: Record<string, Record<string, unknown>> = {},
) {
  const deleted: string[] = [];
  const committed: string[][] = [];
  const failures = { commit: false };
  const collections = (path: string) => Object.keys(subcollections)
    .filter((name) => name.startsWith(`${path}/`) && !name.slice(path.length + 1).includes("/"))
    .map((name) => ({ id: name.split("/").at(-1), path: name }));
  const erase = (path: string, recursive = false) => {
    deleted.push(path);
    if (path.split("/").length === 2) {
      if (path.startsWith("gateways/")) delete roots[path.slice("gateways/".length)];
      if (path.startsWith("glmOperations/")) delete operations[path.slice("glmOperations/".length)];
      if (path.startsWith("gatewayRecoveryReceipts/")) delete recoveryReceipts[path.slice("gatewayRecoveryReceipts/".length)];
    }
    if (recursive) {
      for (const name of Object.keys(subcollections)) {
        if (name === path || name.startsWith(`${path}/`)) delete subcollections[name];
      }
    }
  };
  const gatewayRef = (id: string) => ({
    path: `gateways/${id}`,
    get: async () => ({ exists: roots[id] !== undefined, data: () => roots[id] }),
    collection: () => ({ get: async () => ({ empty: assignments.length === 0 }) }),
    listCollections: async () => collections(`gateways/${id}`),
  });
  const operationRef = (id: string) => ({
    path: `glmOperations/${id}`,
    get: async () => ({ exists: operations[id] !== undefined, data: () => operations[id] }),
    listCollections: async () => collections(`glmOperations/${id}`),
  });
  const db = {
    collection: (name: string) => ({
      doc: (id: string) => {
        if (name === "gateways") return gatewayRef(id);
        if (name === "glmGateways") return { get: async () => ({ exists: runtimes[id] !== undefined, data: () => runtimes[id] }) };
        if (name === "gatewayRecoveryReceipts") return {
          path: `${name}/${id}`,
          get: async () => ({ exists: recoveryReceipts[id] !== undefined, data: () => recoveryReceipts[id] }),
          listCollections: async () => collections(`${name}/${id}`),
        };
        if (name === "users") {
          return {
            path: `users/${id}`,
            get: async () => ({ exists: users[id] !== undefined, data: () => users[id] }),
          };
        }
        return operationRef(id);
      },
      where: (_field: string, _op: string, uid: string) => ({
        get: async () => ({
          empty: name === "users" ? Object.keys(users).length === 0 : false,
          docs: name === "gateways"
            ? Object.entries(roots)
                .filter(([, root]) => root.ownerUid === uid)
                .map(([id, root]) => ({ id, data: () => root, ref: gatewayRef(id) }))
            : [],
        }),
      }),
    }),
    runTransaction: async (action: (transaction: {
      get: (ref: { get: () => Promise<unknown> }) => Promise<unknown>;
      delete: (ref: { path: string }) => void;
    }) => Promise<unknown>) => {
      const pending: string[] = [];
      const result = await action({ get: (ref) => ref.get(), delete: (ref) => { pending.push(ref.path); } });
      if (pending.length > 0) {
        if (failures.commit) throw new Error("retirement cleanup commit unavailable");
        committed.push(pending);
        for (const path of pending) erase(path);
      }
      return result;
    },
    recursiveDelete: async (ref: { path: string }) => {
      erase(ref.path, true);
    },
  };
  return { db, deleted, committed, failures };
}

function retiredRoot(operationId: string): Root {
  return {
    ownerUid: "uid-1", gatewayClass: "builder", desiredStatus: "retired",
    retirementVersion: 1, retirementClaim: { operationId, version: 1, phase: "claimed" },
  };
}

function retirementOperation(status: string): Record<string, unknown> {
  return {
    kind: "retire-gateway", status, gatewayId: "builder-alice",
    input: { gatewayId: "builder-alice", retirementClaimVersion: 1, uid: "uid-1" },
  };
}

function recoveredRoot(operationId: string): Root {
  return {
    ...retiredRoot(operationId), builderSlug: "alice",
    allocation: { kind: "disposable-builder", claimedByUid: "uid-1", leaseId: "lease-1", generation: 1 },
  };
}

function recoveryOperation(): Record<string, unknown> {
  return {
    kind: "recover-unreachable-disposable", status: "succeeded", gatewayId: "builder-alice",
    input: { uid: "uid-1", builderSlug: "alice", gatewayId: "builder-alice", leaseId: "lease-1", generation: 1 },
    recoveryReceipt: { schemaVersion: 1, pods: 0 },
  };
}

describe("owned customer gateway retirement", () => {
  it("follows the recorded placement retirement operation after it succeeds", async () => {
    const operationId = "placement-retire-owner-builder-alice";
    const { db, deleted } = harness({ "builder-alice": retiredRoot(operationId) }, {
      [operationId]: retirementOperation("succeeded"),
    });
    const claimRetirement = vi.fn();
    await expect(ensureOwnedGatewaysRetired({ db: db as never, uid: "uid-1", deletionId: "delete-1", now: 100, claimRetirement: claimRetirement as never }))
      .resolves.toBe("retired");
    expect(deleted).toEqual(["gateways/builder-alice", `glmOperations/${operationId}`]);
    expect(claimRetirement).not.toHaveBeenCalled();
  });

  it("atomically erases both owned recovery artifacts before losing the owned gateway", async () => {
    const operationId = "placement-retire-owner-builder-alice";
    const recoveryId = "builder-recover-builder-alice";
    const roots = { "builder-alice": recoveredRoot(operationId) };
    const operations = { [operationId]: retirementOperation("succeeded"), [recoveryId]: recoveryOperation() };
    const receipts = { [recoveryId]: recoveryOperation() };
    const { db, committed } = harness(roots, operations, {}, {}, [], {}, receipts);
    const input = { db: db as never, uid: "uid-1", deletionId: "delete-1", now: 100 };

    await expect(ensureOwnedGatewaysRetired(input)).resolves.toBe("retired");
    expect(committed).toEqual([[
      "gateways/builder-alice", `glmOperations/${operationId}`,
      `glmOperations/${recoveryId}`, `gatewayRecoveryReceipts/${recoveryId}`,
    ]]);
    expect(roots).toEqual({});
    expect(operations).toEqual({});
    expect(receipts).toEqual({});
    await expect(ensureOwnedGatewaysRetired(input)).resolves.toBe("not-owned");
  });

  it.each(["children", "commit"])("retries %s failure without losing the recovery privacy cleanup path", async (failure) => {
    const operationId = "placement-retire-owner-builder-alice";
    const recoveryId = "builder-recover-builder-alice";
    const roots = { "builder-alice": recoveredRoot(operationId) };
    const operations = { [operationId]: retirementOperation("succeeded"), [recoveryId]: recoveryOperation() };
    const receipts = { [recoveryId]: recoveryOperation() };
    const subcollections = { [`gatewayRecoveryReceipts/${recoveryId}/details`]: ["private-context"] };
    const { db, failures, committed } = harness(roots, operations, {}, {}, [], subcollections, receipts);
    const recursiveDelete = db.recursiveDelete;
    const cleanup = vi.spyOn(db, "recursiveDelete");
    if (failure === "children") cleanup.mockRejectedValue(new Error("recovery child cleanup unavailable"));
    else failures.commit = true;
    const input = { db: db as never, uid: "uid-1", deletionId: "delete-1", now: 100 };

    await expect(ensureOwnedGatewaysRetired(input)).rejects.toThrow(/unavailable/);
    expect(roots["builder-alice"]).toBeDefined();
    expect(operations[operationId]).toBeDefined();
    expect(operations[recoveryId]).toBeDefined();
    expect(receipts[recoveryId]).toBeDefined();
    expect(committed).toEqual([]);

    failures.commit = false;
    cleanup.mockImplementation(recursiveDelete);
    await expect(ensureOwnedGatewaysRetired(input)).resolves.toBe("retired");
    expect(roots).toEqual({});
    expect(operations).toEqual({});
    expect(receipts).toEqual({});
    expect(subcollections).toEqual({});
    expect(committed).toHaveLength(1);
    expect(committed[0]).toHaveLength(4);
  });

  it.each(["legacy operation", "receipt"])("refuses foreign or mismatched %s recovery identity", async (artifact) => {
    for (const change of [
      { uid: "foreign" }, { gatewayId: "foreign" }, { builderSlug: "foreign" },
      { leaseId: "new-incarnation" }, { generation: 2 },
    ]) {
      const operationId = "placement-retire-owner-builder-alice";
      const recoveryId = "builder-recover-builder-alice";
      const roots = { "builder-alice": recoveredRoot(operationId) };
      const recovery = recoveryOperation();
      recovery.input = { ...recovery.input, ...change };
      const operations = {
        [operationId]: retirementOperation("succeeded"),
        ...(artifact === "legacy operation" ? { [recoveryId]: recovery } : {}),
      };
      const receipts = artifact === "receipt" ? { [recoveryId]: recovery } : {};
      const { db, deleted } = harness(roots, operations, {}, {}, [], {}, receipts);

      await expect(ensureOwnedGatewaysRetired({ db: db as never, uid: "uid-1", deletionId: "delete-1", now: 100 }))
        .rejects.toThrow(/recovery.*does not match/);
      expect(deleted).toEqual([]);
      expect(roots["builder-alice"]).toBeDefined();
    }
  });

  it("revalidates recovery ownership after child cleanup before any parent deletion", async () => {
    const operationId = "placement-retire-owner-builder-alice";
    const recoveryId = "builder-recover-builder-alice";
    const roots = { "builder-alice": recoveredRoot(operationId) };
    const operations = { [operationId]: retirementOperation("succeeded") };
    const receipts = { [recoveryId]: recoveryOperation() };
    const { db, committed } = harness(roots, operations, {}, {}, [], {
      "gateways/builder-alice/releases": ["release-1"],
    }, receipts);
    const recursiveDelete = db.recursiveDelete;
    vi.spyOn(db, "recursiveDelete").mockImplementation(async (ref) => {
      await recursiveDelete(ref);
      receipts[recoveryId] = { ...recoveryOperation(), input: { uid: "other", gatewayId: "builder-alice" } };
    });

    await expect(ensureOwnedGatewaysRetired({ db: db as never, uid: "uid-1", deletionId: "delete-1", now: 100 }))
      .rejects.toThrow(/recovery.*does not match/);
    expect(roots["builder-alice"]).toBeDefined();
    expect(operations[operationId]).toBeDefined();
    expect(receipts[recoveryId].input).toEqual({ uid: "other", gatewayId: "builder-alice" });
    expect(committed).toEqual([]);
  });

  it("keeps a newly appearing recovery artifact discoverable until its children are cleaned", async () => {
    const operationId = "placement-retire-owner-builder-alice";
    const recoveryId = "builder-recover-builder-alice";
    const roots = { "builder-alice": recoveredRoot(operationId) };
    const operations = { [operationId]: retirementOperation("succeeded") };
    const receipts: Record<string, Record<string, unknown>> = {};
    const subcollections: Record<string, string[]> = { "gateways/builder-alice/releases": ["release-1"] };
    const { db, committed } = harness(roots, operations, {}, {}, [], subcollections, receipts);
    const recursiveDelete = db.recursiveDelete;
    const cleanup = vi.spyOn(db, "recursiveDelete").mockImplementation(async (ref) => {
      await recursiveDelete(ref);
      receipts[recoveryId] = recoveryOperation();
      subcollections[`gatewayRecoveryReceipts/${recoveryId}/details`] = ["private-context"];
    });
    const input = { db: db as never, uid: "uid-1", deletionId: "delete-1", now: 100 };

    await expect(ensureOwnedGatewaysRetired(input)).resolves.toBe("retirement-pending");
    expect(roots["builder-alice"]).toBeDefined();
    expect(receipts[recoveryId]).toBeDefined();
    expect(committed).toEqual([]);

    cleanup.mockImplementation(recursiveDelete);
    await expect(ensureOwnedGatewaysRetired(input)).resolves.toBe("retired");
    expect(roots).toEqual({});
    expect(operations).toEqual({});
    expect(receipts).toEqual({});
    expect(subcollections).toEqual({});
  });

  it("keeps a placement receipt discoverable after partial child cleanup fails and retries it", async () => {
    const operationId = "placement-retire-owner-builder-alice";
    const roots = { "builder-alice": retiredRoot(operationId) };
    const operation = retirementOperation("succeeded");
    operation.input = { ...operation.input, builderSlug: "alice" };
    const operations = { [operationId]: operation };
    const subcollections = {
      "gateways/builder-alice/releases": ["release-1"],
      [`glmOperations/${operationId}/details`]: ["owner-details"],
    };
    const { db, committed } = harness(roots, operations, {}, {}, [], subcollections);
    const recursiveDelete = db.recursiveDelete;
    const cleanup = vi.spyOn(db, "recursiveDelete").mockImplementation(async (ref) => {
      if (ref.path.startsWith("glmOperations/")) throw new Error("receipt child cleanup unavailable");
      await recursiveDelete(ref);
    });
    const input = { db: db as never, uid: "uid-1", deletionId: "delete-1", now: 100 };

    await expect(ensureOwnedGatewaysRetired(input)).rejects.toThrow(/cleanup unavailable/);
    expect(roots["builder-alice"]?.retirementClaim?.operationId).toBe(operationId);
    expect(operations[operationId]).toBe(operation);
    expect(subcollections).toEqual({ [`glmOperations/${operationId}/details`]: ["owner-details"] });
    expect(committed).toEqual([]);

    cleanup.mockImplementation(recursiveDelete);
    await expect(ensureOwnedGatewaysRetired(input)).resolves.toBe("retired");
    expect(roots).toEqual({});
    expect(operations).toEqual({});
    expect(subcollections).toEqual({});
    expect(committed).toEqual([["gateways/builder-alice", `glmOperations/${operationId}`]]);
  });

  it("keeps both roots on a final commit failure and atomically deletes them on retry", async () => {
    const operationId = "placement-retire-owner-builder-alice";
    const roots = { "builder-alice": retiredRoot(operationId) };
    const operations = { [operationId]: retirementOperation("succeeded") };
    const { db, failures, committed } = harness(roots, operations);
    const input = { db: db as never, uid: "uid-1", deletionId: "delete-1", now: 100 };
    failures.commit = true;

    await expect(ensureOwnedGatewaysRetired(input)).rejects.toThrow(/commit unavailable/);
    expect(roots["builder-alice"]?.retirementClaim?.operationId).toBe(operationId);
    expect(operations[operationId]).toBeDefined();
    expect(committed).toEqual([]);

    failures.commit = false;
    await expect(ensureOwnedGatewaysRetired(input)).resolves.toBe("retired");
    expect(committed).toEqual([["gateways/builder-alice", `glmOperations/${operationId}`]]);
    expect(roots).toEqual({});
    expect(operations).toEqual({});
  });

  it.each(["owner", "claim", "receipt", "retention"])("revalidates %s after child cleanup before deleting either root", async (changed) => {
    const operationId = "placement-retire-owner-builder-alice";
    const roots = { "builder-alice": retiredRoot(operationId) };
    const operations = { [operationId]: retirementOperation("succeeded") };
    const { db, committed } = harness(roots, operations, {}, {}, [], {
      "gateways/builder-alice/releases": ["release-1"],
    });
    const recursiveDelete = db.recursiveDelete;
    vi.spyOn(db, "recursiveDelete").mockImplementation(async (ref) => {
      await recursiveDelete(ref);
      if (changed === "owner") roots["builder-alice"] = { ...retiredRoot(operationId), ownerUid: "other" };
      if (changed === "claim") roots["builder-alice"] = retiredRoot("new-retirement");
      if (changed === "receipt") operations[operationId] = { ...retirementOperation("succeeded"), input: { gatewayId: "foreign" } };
      if (changed === "retention") operations[operationId] = {
        ...retirementOperation("succeeded"),
        input: { ...retirementOperation("succeeded").input, retainData: true },
      };
    });

    await expect(ensureOwnedGatewaysRetired({ db: db as never, uid: "uid-1", deletionId: "delete-1", now: 100 }))
      .rejects.toThrow(/ownership changed|retirement claim changed|retirement operation does not match|retained resources/);
    expect(roots["builder-alice"]).toBeDefined();
    expect(operations[operationId]).toBeDefined();
    expect(committed).toEqual([]);
  });

  it.each(["runtime", "assignment", "customer", "handoff"])("keeps both roots when %s state appears during child cleanup", async (remaining) => {
    const operationId = "placement-retire-owner-builder-alice";
    const roots = { "builder-alice": retiredRoot(operationId) };
    const operations: Record<string, Record<string, unknown>> = { [operationId]: retirementOperation("succeeded") };
    const users: Record<string, Record<string, unknown>> = {};
    const runtimes: Record<string, Record<string, unknown>> = {};
    const assignments: string[] = [];
    const subcollections: Record<string, string[]> = {
      "gateways/builder-alice/releases": ["release-1"],
      "gateways/builder-alice/assignments": [],
    };
    const { db, deleted, committed } = harness(roots, operations, users, runtimes, assignments, subcollections);
    const recursiveDelete = db.recursiveDelete;
    vi.spyOn(db, "recursiveDelete").mockImplementation(async (ref) => {
      await recursiveDelete(ref);
      if (remaining === "runtime") runtimes["builder-alice"] = {};
      if (remaining === "assignment") {
        assignments.push("uid-2");
        subcollections["gateways/builder-alice/assignments"] = ["uid-2"];
      }
      if (remaining === "customer") users["uid-2"] = {};
      if (remaining === "handoff") operations["builder-return-builder-alice"] = {
        status: "failed", schedulerHandoffReleased: false,
        schedulerHandoff: { migrationId: "move-1", fromGatewayId: "builder-alice", toGatewayId: "shared-new", uid: "uid-1", slug: "alice" },
      };
    });

    await expect(ensureOwnedGatewaysRetired({ db: db as never, uid: "uid-1", deletionId: "delete-1", now: 100 }))
      .resolves.toBe("retirement-pending");
    expect(roots["builder-alice"]).toBeDefined();
    expect(operations[operationId]).toBeDefined();
    expect(deleted).toEqual(["gateways/builder-alice/releases"]);
    expect(committed).toEqual([]);
    if (remaining === "assignment") expect(subcollections["gateways/builder-alice/assignments"]).toEqual(["uid-2"]);
  });

  it("surfaces the actual existing retirement failure", async () => {
    const operationId = "placement-retire-owner-builder-alice";
    const { db, deleted } = harness({ "builder-alice": retiredRoot(operationId) }, {
      [operationId]: { ...retirementOperation("failed"), error: "RESOURCE_NOT_FOUND during computer deletion" },
    });
    await expect(ensureOwnedGatewaysRetired({ db: db as never, uid: "uid-1", deletionId: "delete-1", now: 100 }))
      .rejects.toThrow(/retirement failed: RESOURCE_NOT_FOUND/);
    expect(deleted).toEqual([]);
  });

  it.each(["pending", "running", "absent"])("keeps %s existing retirement blocked", async (status) => {
    const operationId = "placement-retire-owner-builder-alice";
    const { db, deleted } = harness({ "builder-alice": retiredRoot(operationId) }, status === "absent" ? {} : {
      [operationId]: retirementOperation(status),
    });
    const claimRetirement = vi.fn();
    await expect(ensureOwnedGatewaysRetired({ db: db as never, uid: "uid-1", deletionId: "delete-1", now: 100, claimRetirement: claimRetirement as never }))
      .resolves.toBe("retirement-pending");
    expect(deleted).toEqual([]);
    expect(claimRetirement).not.toHaveBeenCalled();
  });

  it.each([
    { label: "foreign gateway", change: { input: { gatewayId: "foreign", retirementClaimVersion: 1 } } },
    { label: "foreign owner", change: { input: { gatewayId: "builder-alice", retirementClaimVersion: 1, uid: "other" } } },
    { label: "wrong kind", change: { kind: "add-gateway" } },
    { label: "old claim", change: { input: { gatewayId: "builder-alice", retirementClaimVersion: 2 } } },
  ])("rejects $label retirement receipts", async ({ change }) => {
    const operationId = "delete-retire-delete-1-builder-alice";
    const { db, deleted } = harness({ "builder-alice": retiredRoot(operationId) }, {
      [operationId]: { ...retirementOperation("succeeded"), ...change },
    });
    await expect(ensureOwnedGatewaysRetired({ db: db as never, uid: "uid-1", deletionId: "delete-1", now: 100 }))
      .rejects.toThrow(/retirement operation does not match/);
    expect(deleted).toEqual([]);
  });

  it.each(["retainData", "retainServiceAccount"])("rejects a completed retirement retaining %s", async (flag) => {
    const operationId = "placement-retire-owner-builder-alice";
    const operation = retirementOperation("succeeded");
    operation.input = { ...operation.input, [flag]: true };
    const { db, deleted } = harness({ "builder-alice": retiredRoot(operationId) }, { [operationId]: operation });
    await expect(ensureOwnedGatewaysRetired({ db: db as never, uid: "uid-1", deletionId: "delete-1", now: 100 }))
      .rejects.toThrow(/retained resources/);
    expect(deleted).toEqual([]);
  });

  it("does not complete a retired root without a validated claim", async () => {
    const root = retiredRoot("delete-retire-delete-1-builder-alice");
    delete root.retirementClaim;
    const { db, deleted } = harness({ "builder-alice": root }, {
      "delete-retire-delete-1-builder-alice": retirementOperation("succeeded"),
    });
    await expect(ensureOwnedGatewaysRetired({ db: db as never, uid: "uid-1", deletionId: "delete-1", now: 100 }))
      .rejects.toThrow(/invalid retirement claim/);
    expect(deleted).toEqual([]);
  });

  it.each(["runtime", "assignment", "customer"])("blocks succeeded retirement cleanup while a %s remains", async (remaining) => {
    const operationId = "delete-retire-delete-1-builder-alice";
    const { db, deleted } = harness({ "builder-alice": retiredRoot(operationId) }, {
      [operationId]: retirementOperation("succeeded"),
    }, remaining === "customer" ? { "uid-1": {} } : {},
    remaining === "runtime" ? { "builder-alice": {} } : {},
    remaining === "assignment" ? ["uid-1"] : []);
    await expect(ensureOwnedGatewaysRetired({ db: db as never, uid: "uid-1", deletionId: "delete-1", now: 100 }))
      .resolves.toBe("retirement-pending");
    expect(deleted).toEqual([]);
  });

  it.each(["owner", "claim"])("revalidates the %s after selecting the owned root", async (changed) => {
    const operationId = "placement-retire-owner-builder-alice";
    const roots = { "builder-alice": retiredRoot(operationId) };
    const { db, deleted } = harness(roots, { [operationId]: retirementOperation("succeeded") });
    const runTransaction = db.runTransaction;
    db.runTransaction = async (action) => {
      roots["builder-alice"] = changed === "owner"
        ? { ...retiredRoot(operationId), ownerUid: "other" }
        : retiredRoot("new-retirement");
      return runTransaction(action);
    };
    await expect(ensureOwnedGatewaysRetired({ db: db as never, uid: "uid-1", deletionId: "delete-1", now: 100 }))
      .rejects.toThrow(changed === "owner" ? /ownership changed/ : /retirement claim changed/);
    expect(deleted).toEqual([]);
  });

  it.each(["builder-activate", "builder-return"])("waits for %s handoff release after retirement succeeds", async (prefix) => {
    const operationId = "placement-retire-owner-builder-alice";
    const operations = {
      [operationId]: retirementOperation("succeeded"),
      [`${prefix}-builder-alice`]: {
        status: "failed", schedulerHandoffReleased: false,
        schedulerHandoff: { migrationId: "move-1", fromGatewayId: "builder-alice", toGatewayId: "shared-new", uid: "uid-1", slug: "alice" },
      },
    };
    const { db, deleted } = harness({ "builder-alice": retiredRoot(operationId) }, operations);
    const input = { db: db as never, uid: "uid-1", deletionId: "delete-1", now: 100 };
    await expect(ensureOwnedGatewaysRetired(input)).resolves.toBe("retirement-pending");
    expect(deleted).toEqual([]);
    operations[`${prefix}-builder-alice`].schedulerHandoffReleased = true;
    await expect(ensureOwnedGatewaysRetired(input)).resolves.toBe("retired");
  });

  it("retires the owned disposable Builder gateway while the user's current placement is shared", async () => {
    const { db } = harness({
      default: { ownerUid: null, gatewayClass: "shared", desiredStatus: "running" },
      "builder-alice": {
        ownerUid: "uid-1",
        gatewayClass: "builder",
        desiredStatus: "running",
        allocation: { kind: "disposable-builder" },
      },
    });
    const claimRetirement = vi.fn(async () => ({ version: 1 }));

    await expect(ensureOwnedGatewaysRetired({
      db: db as never,
      uid: "uid-1",
      deletionId: "delete-1",
      now: 100,
      claimRetirement: claimRetirement as never,
    })).resolves.toBe("retirement-pending");

    expect(claimRetirement).toHaveBeenCalledWith(expect.objectContaining({
      gatewayId: "builder-alice",
      operationId: "delete-retire-delete-1-builder-alice",
    }));
  });

  it("stamps customer-deletion retirement work as automatic", async () => {
    const { db } = harness({
      "builder-alice": {
        ownerUid: "uid-1",
        gatewayClass: "builder",
        desiredStatus: "running",
        allocation: { kind: "disposable-builder" },
      },
    });
    const claimRetirement = vi.fn(async () => ({ version: 1 }));

    await ensureOwnedGatewaysRetired({
      db: db as never,
      uid: "uid-1",
      deletionId: "delete-1",
      now: 100,
      claimRetirement: claimRetirement as never,
    });

    expect(claimRetirement).toHaveBeenCalledWith(expect.objectContaining({
      operation: expect.objectContaining({ origin: "automatic" }),
    }));
  });

  it("retires a disposable root during suspension cleanup", async () => {
    const { db } = harness({
      "run-alice": {
        ownerUid: "uid-1",
        gatewayClass: "builder",
        desiredStatus: "running",
        allocation: { kind: "disposable-builder" },
      },
    });
    const claimRetirement = vi.fn(async () => ({ version: 1 }));

    await expect(ensureOwnedGatewaysRetired({
      db: db as never,
      uid: "uid-1",
      deletionId: "delete-1",
      now: 100,
      claimRetirement: claimRetirement as never,
    })).resolves.toBe("retirement-pending");

    expect(claimRetirement).toHaveBeenCalledTimes(1);
    expect(claimRetirement).toHaveBeenCalledWith(expect.objectContaining({
      gatewayId: "run-alice",
    }));
  });

  it("deletes every durable gateway root only after its retirement operation succeeds", async () => {
    const operationId = "delete-retire-delete-1-builder-alice";
    const { db, deleted } = harness(
      {
        "builder-alice": {
          ownerUid: "uid-1",
          gatewayClass: "builder",
          desiredStatus: "retired",
          retirementVersion: 1,
          retirementClaim: { operationId, version: 1, phase: "claimed" },
          allocation: { kind: "disposable-builder" },
        },
      },
      { [operationId]: { ...retirementOperation("succeeded"), origin: "automatic" } },
    );

    await expect(ensureOwnedGatewaysRetired({
      db: db as never,
      uid: "uid-1",
      deletionId: "delete-1",
      now: 100,
      claimRetirement: vi.fn() as never,
    })).resolves.toBe("retired");

    expect(deleted).toEqual([
      "gateways/builder-alice",
      `glmOperations/${operationId}`,
    ]);
  });

  it("cleans up a succeeded retirement for a missing-origin operation", async () => {
    const operationId = "delete-retire-delete-1-builder-alice";
    const { db, deleted } = harness(
      {
        "builder-alice": {
          ownerUid: "uid-1",
          gatewayClass: "builder",
          desiredStatus: "retired",
          retirementVersion: 1,
          retirementClaim: { operationId, version: 1, phase: "claimed" },
          allocation: { kind: "disposable-builder" },
        },
      },
      { [operationId]: retirementOperation("succeeded") },
    );

    await expect(ensureOwnedGatewaysRetired({
      db: db as never,
      uid: "uid-1",
      deletionId: "delete-1",
      now: 100,
      claimRetirement: vi.fn() as never,
    })).resolves.toBe("retired");

    expect(deleted).toEqual(["gateways/builder-alice", `glmOperations/${operationId}`]);
  });

  it("leaves a shared gateway alone even if malformed ownership data points at the customer", async () => {
    const { db } = harness({
      default: { ownerUid: "uid-1", gatewayClass: "shared", desiredStatus: "running" },
    });
    const claimRetirement = vi.fn();

    await expect(ensureOwnedGatewaysRetired({
      db: db as never,
      uid: "uid-1",
      deletionId: "delete-1",
      now: 100,
      claimRetirement: claimRetirement as never,
    })).resolves.toBe("not-owned");
    expect(claimRetirement).not.toHaveBeenCalled();
  });

  it("retires a legacy owner root without a disposable allocation", async () => {
    const { db } = harness({
      "legacy-builder": {
        ownerUid: "uid-1",
        gatewayClass: "builder",
        desiredStatus: "running",
      },
    });
    const claimRetirement = vi.fn(async () => ({ version: 1 }));

    await expect(ensureOwnedGatewaysRetired({
      db: db as never,
      uid: "uid-1",
      deletionId: "delete-1",
      now: 100,
      claimRetirement: claimRetirement as never,
    })).resolves.toBe("retirement-pending");

    expect(claimRetirement).toHaveBeenCalledWith(expect.objectContaining({
      gatewayId: "legacy-builder",
    }));
  });
});
