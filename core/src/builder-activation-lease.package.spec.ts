import { describe, expect, it, vi } from "vitest";

import { requestBuilderActivationLease } from "../dist/builder-activation-lease.js";
import type { PlatformStateStore } from "./platform-state/store.js";

function parkedBuilderStore(): PlatformStateStore {
  const builder = {
    uid: "uid-alice",
    slug: "alice",
    gateway: { gatewayId: "shared-blue" },
    accountLifecycle: null,
    fences: {},
    activationLease: {
      leaseId: "lease-old",
      generation: 7,
      status: "parked",
      eventKey: "run-start:run-1",
      sizingTier: "xs",
    },
  };
  const assignment = {
    uid: "uid-alice",
    slug: "alice",
    gatewayId: "shared-blue",
    source: "onboarding",
    state: "serving",
    epoch: 4,
  };
  const transaction = {
    builders: { records: { get: async () => builder } },
    gateways: { assignments: { get: async () => assignment } },
  };
  return {
    builders: transaction.builders,
    transaction: async (_options: unknown, body: (tx: unknown) => Promise<unknown>) => body(transaction),
  } as unknown as PlatformStateStore;
}

describe("@octogee/core/builder-activation-lease runtime artifact", () => {
  it("acknowledges a late parked duplicate without allocating another generation", async () => {
    const leaseIdFactory = vi.fn(() => "lease-new");

    await expect(requestBuilderActivationLease({
      store: parkedBuilderStore(),
      readBuilderTier: async () => "hobby",
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
