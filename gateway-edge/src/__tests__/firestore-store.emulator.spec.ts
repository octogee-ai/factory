import { describe, expect, it } from "vitest";
import { setupEmulatorTest } from "@octogee/test-helpers/firestore-emulator";
import { createFirestorePlatformStateStore } from "@octogee/core/testing/firestore-store";
import type { GatewayAssignment, GatewayRoot } from "@octogee/core/platform-state";
import { db } from "../lib/db.js";

setupEmulatorTest();

const store = createFirestorePlatformStateStore({ db });

const gateway: GatewayRoot = {
  gatewayId: "shared-1",
  createdAt: 1,
  createdBy: "test",
  updatedAt: 1,
  updatedBy: "test",
  latestRelease: 1,
  desiredRelease: 1,
  liveRelease: 1,
  desiredStatus: "running",
  configSchemaVersion: 1,
  profile: null,
  gatewayClass: "shared",
  imageProfile: "standard",
  sizingTier: null,
  gcpProject: null,
  gatewayContainerSecurityContext: null,
  serviceAccountName: null,
  serviceAccount: null,
  builderAccess: null,
  ownerUid: null,
  builderSlug: null,
  modelBrokerLimits: null,
  preemption: null,
};

const assignment: GatewayAssignment = {
  uid: "ada",
  slug: "ada",
  gatewayId: "shared-1",
  source: "onboarding",
  state: "serving",
  epoch: 1,
  createdAt: 2,
  updatedAt: 2,
  updatedByOperationId: null,
};

describe("Firestore platform-state test store", () => {
  it("round-trips a user, a gateway and an assignment through the emulator", async () => {
    await store.users.records.create({ uid: "ada", createdAt: 1 });
    await store.users.records.patch("ada", { slug: "ada", role: "admin" });
    await store.users.records.setGatewayMirror("ada", { gatewayId: "shared-1" });
    await store.gateways.roots.create(gateway);
    await store.gateways.assignments.create(assignment);

    expect(await store.users.records.get("ada")).toMatchObject({
      uid: "ada",
      slug: "ada",
      role: "admin",
      gateway: { gatewayId: "shared-1" },
    });
    expect(await store.gateways.roots.get("shared-1")).toMatchObject(gateway);
    expect(await store.gateways.assignments.get("shared-1", "ada")).toMatchObject(assignment);
  });
});
