import { describe, expect, it, vi } from "vitest";

import { requestBuilderActivationLease } from "../dist/builder-activation-lease.js";

type Data = Record<string, unknown>;

function fakeDb(seed: Record<string, Data>) {
  const docs = structuredClone(seed);
  return {
    doc: (path: string) => ({ path }),
    runTransaction: async <T>(body: (transaction: {
      get(ref: { path: string }): Promise<{ exists: boolean; data(): Data | undefined }>;
      update(ref: { path: string }, patch: Data): void;
    }) => Promise<T>): Promise<T> => body({
      get: async (ref) => ({
        exists: docs[ref.path] !== undefined,
        data: () => docs[ref.path],
      }),
      update: vi.fn(),
    }),
  };
}

describe("@octogee/core/builder-activation-lease runtime artifact", () => {
  it("acknowledges a late parked duplicate without allocating another generation", async () => {
    const db = fakeDb({
      "users/uid-alice": {
        username: "alice",
        onboardingStep: "complete",
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
      },
      "gateways/shared-blue/assignments/uid-alice": {
        uid: "uid-alice",
        slug: "alice",
        gatewayId: "shared-blue",
        state: "serving",
        epoch: 4,
      },
    });
    const leaseIdFactory = vi.fn(() => "lease-new");

    await expect(requestBuilderActivationLease({
      db: db as never,
      uid: "uid-alice",
      reportingGatewayId: "shared-blue",
      assignmentEpoch: 4,
      eventKey: "run-start:run-1",
      cause: "run-start",
      observedAt: 5_000,
      createdBy: "gateway-edge:shared-blue",
      leaseIdFactory,
      now: 5_000,
    })).resolves.toMatchObject({
      statusCode: 200,
      body: {
        status: "parked",
        leaseId: "lease-old",
        generation: 7,
        duplicate: true,
      },
    });

    expect(leaseIdFactory).not.toHaveBeenCalled();
  });
});
