import { describe, expect, it, vi } from "vitest";

import { requestBuilderActivationLease } from "./builder-activation-lease.js";

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
    eventKey: "ticket:req-1",
    cause: "ticket",
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
        sizingTier: "xs",
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
            eventKey: "ticket:req-1",
            cause: "ticket",
            entitlementTier: "hobby",
            sizingTier: "xs",
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
              eventKey: "ticket:req-1",
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
