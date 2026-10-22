import { describe, expect, it, vi } from "vitest";

import {
  builderActivateOperationId,
  builderRecoverOperationId,
  builderReturnOperationId,
  isBuilderActivateOperationIdFor,
  isBuilderReturnOperationIdFor,
  placementRetireOperationId,
  requestBuilderActivationLease,
  recordBuilderRuntimeActivity,
} from "./builder-activation-lease.js";

type Data = Record<string, unknown>;

function setPath(target: Data, path: string, value: unknown): void {
  const parts = path.split(".");
  let cursor = target;
  for (const part of parts.slice(0, -1)) {
    const next = cursor[part];
    if (!next || typeof next !== "object" || Array.isArray(next)) cursor[part] = {};
    cursor = cursor[part] as Data;
  }
  cursor[parts.at(-1)!] = value;
}

function fakeDb(seed: Record<string, Data>) {
  const docs = structuredClone(seed);
  const db = {
    doc(path: string) {
      return { path };
    },
    async runTransaction<T>(fn: (transaction: {
      get(ref: { path: string }): Promise<{ exists: boolean; data(): Data | undefined }>;
      update(ref: { path: string }, patch: Data): void;
    }) => Promise<T>): Promise<T> {
      const writes: Array<() => void> = [];
      const result = await fn({
        get: async (ref) => ({
          exists: docs[ref.path] !== undefined,
          data: () => docs[ref.path],
        }),
        update: (ref, patch) => {
          writes.push(() => {
            const target = docs[ref.path];
            if (!target) throw new Error(`missing ${ref.path}`);
            for (const [path, value] of Object.entries(patch)) setPath(target, path, value);
          });
        },
      });
      for (const write of writes) write();
      return result;
    },
  };
  return { db, docs };
}

function activeTrial(overrides: Data = {}): Data {
  return {
    username: "alice",
    onboardingStep: "complete",
    provisioning: {
      status: "complete",
      openclaw: { gatewayId: "shared-blue", slug: "alice" },
    },
    trialGrant: {
      schemaVersion: 3,
      offerId: "builder-signup",
      offerVersion: 1,
      personalTier: "personal",
      builderTier: "hobby",
      configHash: "config-a",
      claimedAt: 1_000,
      endsAt: 999_999,
    },
    ...overrides,
  };
}

function state(user: Data = activeTrial(), assignment: Data = {}) {
  return fakeDb({
    "users/uid-alice": user,
    "gateways/shared-blue/assignments/uid-alice": {
      uid: "uid-alice",
      slug: "alice",
      gatewayId: "shared-blue",
      state: "serving",
      epoch: 4,
      ...assignment,
    },
  });
}

function request(
  db: unknown,
  overrides: Partial<Parameters<typeof requestBuilderActivationLease>[0]> = {},
) {
  return requestBuilderActivationLease({
    db: db as never,
    uid: "uid-alice",
    reportingGatewayId: "shared-blue",
    assignmentEpoch: 4,
    eventKey: "mm-post:req-1",
    cause: "chat",
    observedAt: 5_000,
    createdBy: "gateway-edge:shared-blue",
    leaseIdFactory: () => "lease-one",
    now: 5_000,
    ...overrides,
  });
}

describe("requestBuilderActivationLease", () => {
  it("records one targetless, explicitly sized demand against the serving assignment", async () => {
    const { db, docs } = state();

    await expect(request(db)).resolves.toMatchObject({
      statusCode: 202,
      body: {
        status: "requested",
        leaseId: "lease-one",
        generation: 1,
        sizingTier: "s",
      },
    });

    expect(docs["users/uid-alice"]).toMatchObject({
      provisioning: {
        openclaw: {
          activationLease: {
            leaseId: "lease-one",
            generation: 1,
            status: "requested",
            sourceGatewayId: "shared-blue",
            sourceAssignmentEpoch: 4,
            eventKey: "mm-post:req-1",
            cause: "chat",
            entitlementTier: "hobby",
            sizingTier: "s",
          },
        },
      },
    });
    expect(
      (docs["users/uid-alice"].provisioning as Data).openclaw,
    ).not.toHaveProperty("targetGatewayId");
  });

  it("adopts duplicate demand without minting another lease generation", async () => {
    const { db } = state();
    const idFactory = vi.fn(() => "lease-one");

    const first = await request(db, { leaseIdFactory: idFactory });
    const second = await request(db, { leaseIdFactory: idFactory });

    expect(first.body.leaseId).toBe("lease-one");
    expect(second.body).toMatchObject({ leaseId: "lease-one", adopted: true });
    expect(idFactory).toHaveBeenCalledTimes(1);
  });

  it("rebases a targetless requested lease to a newly accepted serving assignment", async () => {
    const user = activeTrial({
      provisioning: {
        status: "complete",
        openclaw: {
          gatewayId: "shared-green",
          slug: "alice",
          activationLease: {
            leaseId: "lease-existing",
            generation: 7,
            status: "requested",
            cause: "chat",
            eventKey: "mm-post:old",
            requestedAt: 4_000,
            lastActiveAt: 4_000,
            requestedBy: "gateway-edge:shared-blue",
            sourceGatewayId: "shared-blue",
            sourceAssignmentEpoch: 4,
            entitlementTier: "hobby",
            sizingTier: "xs",
          },
        },
      },
    });
    const { db, docs } = fakeDb({
      "users/uid-alice": user,
      "gateways/shared-green/assignments/uid-alice": {
        uid: "uid-alice",
        slug: "alice",
        gatewayId: "shared-green",
        state: "serving",
        epoch: 8,
      },
    });

    await expect(request(db, {
      reportingGatewayId: "shared-green",
      assignmentEpoch: 8,
      eventKey: "mm-post:new",
      cause: "chat",
      observedAt: 9_000,
      createdBy: "openclaw-control:uid-alice:alice",
    })).resolves.toMatchObject({
      statusCode: 202,
      body: { leaseId: "lease-existing", generation: 7, status: "requested", adopted: true },
    });

    expect(docs["users/uid-alice"]).toMatchObject({
      provisioning: {
        openclaw: {
          activationLease: {
            leaseId: "lease-existing",
            generation: 7,
            status: "requested",
            sourceGatewayId: "shared-green",
            sourceAssignmentEpoch: 8,
            cause: "chat",
            eventKey: "mm-post:new",
            requestedAt: 9_000,
            lastActiveAt: 9_000,
            requestedBy: "openclaw-control:uid-alice:alice",
          },
        },
      },
    });
    expect(docs["users/uid-alice"]?.provisioning?.openclaw?.activationLease).not.toHaveProperty(
      "targetGatewayId",
    );
  });

  it.each(["requested", "provisioning", "activating", "active"])(
    "does not rebase an %s lease after it has a target",
    async (status) => {
      const user = activeTrial({
        provisioning: {
          status: "complete",
          openclaw: {
            gatewayId: "shared-green",
            slug: "alice",
            activationLease: {
              leaseId: "lease-existing",
              generation: 7,
              status,
              targetGatewayId: "run-alice",
              sourceGatewayId: "shared-blue",
              sourceAssignmentEpoch: 4,
            },
          },
        },
      });
      const { db, docs } = fakeDb({
        "users/uid-alice": user,
        "gateways/shared-green/assignments/uid-alice": {
          uid: "uid-alice",
          slug: "alice",
          gatewayId: "shared-green",
          state: "serving",
          epoch: 8,
        },
      });

      await expect(request(db, {
        reportingGatewayId: "shared-green",
        assignmentEpoch: 8,
        eventKey: "mm-post:new",
        cause: "chat",
        observedAt: 9_000,
      })).resolves.toMatchObject({ statusCode: 202, body: { adopted: true } });

      expect(docs["users/uid-alice"]).toMatchObject({
        provisioning: {
          openclaw: {
            activationLease: {
              status,
              targetGatewayId: "run-alice",
              sourceGatewayId: "shared-blue",
              sourceAssignmentEpoch: 4,
            },
          },
        },
      });
    },
  );

  it("acknowledges a late duplicate of a parked run without waking a new gateway", async () => {
    const parked = activeTrial({
      provisioning: {
        status: "complete",
        openclaw: {
          gatewayId: "shared-blue",
          slug: "alice",
          activationLease: {
            leaseId: "lease-old",
            generation: 7,
            status: "parked",
            eventKey: "run-start:run-1",
            sizingTier: "xs",
          },
        },
      },
    });
    const { db, docs } = state(parked);
    const idFactory = vi.fn(() => "lease-new");

    await expect(request(db, {
      eventKey: "run-start:run-1",
      cause: "run-start",
      leaseIdFactory: idFactory,
    })).resolves.toMatchObject({
      statusCode: 200,
      body: {
        status: "parked",
        leaseId: "lease-old",
        generation: 7,
        duplicate: true,
      },
    });

    expect(idFactory).not.toHaveBeenCalled();
    expect(docs["users/uid-alice"]).toEqual(parked);
  });

  it.each([
    ["mirror changed", activeTrial({
      provisioning: {
        status: "complete",
        openclaw: { gatewayId: "other", slug: "alice" },
      },
    }), {}],
    ["epoch changed", activeTrial(), { epoch: 5 }],
    ["assignment quiescing", activeTrial(), { state: "quiescing" }],
  ])("rejects a stale source fence when %s", async (_label, user, assignment) => {
    const { db, docs } = state(user, assignment);

    await expect(request(db)).resolves.toMatchObject({
      statusCode: 409,
      body: { code: "builder-runtime-assignment-stale" },
    });
    expect(
      ((docs["users/uid-alice"].provisioning as Data).openclaw as Data).activationLease,
    ).toBeUndefined();
  });

  it("preserves demand accepted while a return is already fenced", async () => {
    const returning = activeTrial({
      provisioning: {
        status: "complete",
        openclaw: {
          gatewayId: "shared-blue",
          slug: "alice",
          activationLease: {
            leaseId: "lease-old",
            generation: 7,
            status: "returning",
            targetGatewayId: "run-alice-old",
            blockedByOperationId: "return-op",
          },
        },
      },
    });
    const { db, docs } = state(returning);

    await expect(request(db)).resolves.toMatchObject({
      statusCode: 202,
      body: { status: "returning", pending: true, leaseId: "lease-old" },
    });
    expect(docs["users/uid-alice"]).toMatchObject({
      provisioning: {
        openclaw: {
          activationLease: {
            leaseId: "lease-old",
            generation: 7,
            targetGatewayId: "run-alice-old",
            pendingDemand: {
              eventKey: "mm-post:req-1",
              observedAt: 5_000,
              sourceGatewayId: "shared-blue",
              sourceAssignmentEpoch: 4,
            },
          },
        },
      },
    });
  });

  it("fails visibly when the Builder is unauthorized or requires manual sizing", async () => {
    const unauthorized = state({ ...activeTrial(), trialGrant: undefined });
    await expect(request(unauthorized.db)).resolves.toMatchObject({
      statusCode: 403,
      body: { code: "builder-runtime-not-entitled" },
    });

    const enterprise = state({
      ...activeTrial(),
      trialGrant: undefined,
      builderSubscription: { tier: "enterprise", status: "active" },
    });
    await expect(request(enterprise.db)).resolves.toMatchObject({
      statusCode: 409,
      body: { code: "builder-runtime-manual-size-required" },
    });
  });

  it("does not request an isolated gateway for a live Personal-only trial", async () => {
    const personalOnly = state(activeTrial({
      trialGrant: {
        ...activeTrial().trialGrant as Data,
        builderTier: null,
      },
    }));

    await expect(request(personalOnly.db)).resolves.toMatchObject({
      statusCode: 403,
      body: { code: "builder-runtime-not-entitled" },
    });
    expect(
      (personalOnly.docs["users/uid-alice"].provisioning as Data).openclaw,
    ).not.toHaveProperty("activationLease");
  });

  it("activates every Builder tier for an interactive chat demand, Hobby included", async () => {
    const { db, docs } = state();

    await expect(request(db, {
      cause: "chat",
      eventKey: "mm-post:req-1",
    })).resolves.toMatchObject({
      statusCode: 202,
      body: {
        status: "requested",
        leaseId: "lease-one",
        generation: 1,
        sizingTier: "s",
      },
    });

    expect(docs["users/uid-alice"]).toMatchObject({
      provisioning: {
        openclaw: {
          activationLease: {
            status: "requested",
            cause: "chat",
            entitlementTier: "hobby",
            sizingTier: "s",
          },
        },
      },
    });
  });

  it("rejects demand after interactive account access is lost", async () => {
    const { db } = state(activeTrial({
      accountLifecycle: { status: "suspended" },
    }));

    await expect(request(db)).resolves.toMatchObject({
      statusCode: 403,
      body: { code: "builder-runtime-not-interactive" },
    });
  });
});

describe("Builder runtime operation ids", () => {
  it("qualify each runtime operation with the allocation generation", () => {
    expect(builderActivateOperationId("alice-m-1234abcd", 3)).toBe("builder-activate-alice-m-1234abcd-g3");
    expect(builderReturnOperationId("alice-m-1234abcd", 3)).toBe("builder-return-alice-m-1234abcd-g3");
    expect(builderRecoverOperationId("alice-m-1234abcd", 3)).toBe("builder-recover-alice-m-1234abcd-g3");
    expect(placementRetireOperationId("uid-alice", "alice-m-1234abcd", 3))
      .toBe("placement-retire-uid-alice-alice-m-1234abcd-g3");
  });

  it("give a reused gateway distinct operations per generation", () => {
    expect(builderReturnOperationId("alice-m-1234abcd", 1))
      .not.toBe(builderReturnOperationId("alice-m-1234abcd", 2));
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects generation %s", (generation) => {
    expect(() => builderActivateOperationId("alice-m-1234abcd", generation)).toThrow(/generation/);
  });

  it("rejects an empty gateway id", () => {
    expect(() => builderReturnOperationId("", 1)).toThrow(/gateway/);
  });
});

describe("Builder runtime operation id recognition", () => {
  it("recognizes any generation of the exact gateway's operation", () => {
    expect(isBuilderReturnOperationIdFor("builder-return-alice-m-1234abcd-g7", "alice-m-1234abcd")).toBe(true);
    expect(isBuilderActivateOperationIdFor("builder-activate-alice-m-1234abcd-g1", "alice-m-1234abcd")).toBe(true);
  });

  it.each([
    ["builder-return-alice-m-1234abcd", "ungenerationed id"],
    ["builder-return-alice-m-1234abcd-g0", "zero generation"],
    ["builder-return-alice-m-1234abcd-g1-g2", "another gateway's suffix"],
    ["builder-activate-alice-m-1234abcd-g1", "another operation kind"],
    ["builder-return-bob-m-1234abcd-g1", "another gateway"],
  ])("rejects %s (%s)", (operationId) => {
    expect(isBuilderReturnOperationIdFor(operationId, "alice-m-1234abcd")).toBe(false);
  });

  it("rejects a missing gateway id", () => {
    expect(isBuilderReturnOperationIdFor("builder-return--g1", undefined)).toBe(false);
  });
});


describe("recordBuilderRuntimeActivity", () => {
  function running(status = "active", assignmentState = "serving", target = "builder-alice") {
    const user = activeTrial({ provisioning: { openclaw: { gatewayId: target,
      activationLease: { leaseId: "lease-one", generation: 2, status,
        targetGatewayId: "builder-alice", lastActiveAt: 1_000 } } } });
    return fakeDb({ "users/uid-alice": user,
      "gateways/builder-alice/assignments/uid-alice": { uid: "uid-alice", gatewayId: "builder-alice", state: assignmentState, epoch: 4 } });
  }
  it("refreshes active use on the current serving lease without replacing its identity", async () => {
    const { db, docs } = running();
    await expect(recordBuilderRuntimeActivity({ db: db as never, uid: "uid-alice", gatewayId: "builder-alice", now: 90_000 })).resolves.toBe(true);
    expect(docs["users/uid-alice"]).toMatchObject({ provisioning: { openclaw: { activationLease: {
      leaseId: "lease-one", generation: 2, status: "active", lastActiveAt: 90_000,
    } } } });
  });
  it.each(["parked", "requested", "provisioning", "activating", "returning", "failed"])("does not wake or extend a %s lease", async status => {
    const { db, docs } = running(status); const before = structuredClone(docs);
    await expect(recordBuilderRuntimeActivity({ db: db as never, uid: "uid-alice", gatewayId: "builder-alice", now: 90_000 })).resolves.toBe(false);
    expect(docs).toEqual(before);
  });
  it.each([["quiescing", "builder-alice"], ["serving", "shared-blue"]])("refuses a stale surface after assignment or placement changes", async (assignment, target) => {
    const { db, docs } = running("active", assignment, target); const before = structuredClone(docs);
    await expect(recordBuilderRuntimeActivity({ db: db as never, uid: "uid-alice", gatewayId: "builder-alice", now: 90_000 })).resolves.toBe(false);
    expect(docs).toEqual(before);
  });
  it("refuses another customer or an inactive account", async () => {
    const { db, docs } = running();
    await expect(recordBuilderRuntimeActivity({ db: db as never, uid: "uid-other", gatewayId: "builder-alice", now: 90_000 })).resolves.toBe(false);
    docs["users/uid-alice"].accountLifecycle = { status: "erasing" };
    await expect(recordBuilderRuntimeActivity({ db: db as never, uid: "uid-alice", gatewayId: "builder-alice", now: 90_000 })).resolves.toBe(false);
  });
  it("coalesces frequent input without writing an older activity timestamp", async () => {
    const { db, docs } = running();
    await recordBuilderRuntimeActivity({ db: db as never, uid: "uid-alice", gatewayId: "builder-alice", now: 90_000 });
    const before = structuredClone(docs);
    await expect(recordBuilderRuntimeActivity({ db: db as never, uid: "uid-alice", gatewayId: "builder-alice", now: 90_001 })).resolves.toBe(true);
    expect(docs).toEqual(before);
  });
  it("does not undo a return request while the active status is still visible", async () => {
    const { db, docs } = running();
    setPath(docs["users/uid-alice"], "provisioning.openclaw.activationLease.returnRequestedAt", 89_000);
    const before = structuredClone(docs);
    await expect(recordBuilderRuntimeActivity({ db: db as never, uid: "uid-alice", gatewayId: "builder-alice", now: 90_000 })).resolves.toBe(false);
    expect(docs).toEqual(before);
  });
  it("does not extend an expired Builder entitlement", async () => {
    const { db, docs } = running();
    const before = structuredClone(docs);
    await expect(recordBuilderRuntimeActivity({ db: db as never, uid: "uid-alice", gatewayId: "builder-alice", now: 1_000_000 })).resolves.toBe(false);
    expect(docs).toEqual(before);
  });
});
