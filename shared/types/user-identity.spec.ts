import { expect, it } from "vitest";
import { parseUserIdentity } from "./user-identity.js";

const claimed = {
  gatewayId: "builder-alice", state: "claimed", ownerUid: "uid-alice", builderSlug: "alice",
  leaseId: "lease-alice", generation: 3,
};

it("keeps ordinary user identity independent of Native boot admission", () => {
  expect(parseUserIdentity(claimed, claimed.gatewayId)).toEqual(claimed);
});

it.each(["normal", "prelaunch"])("retains the broker's %s boot decision", bootMode => {
  const identity = { ...claimed, bootMode };
  expect(parseUserIdentity(identity, claimed.gatewayId)).toEqual(identity);
});

it("retains the current activation identity for target restart recovery", () => {
  const identity = { ...claimed, bootMode: "activating", activationMigrationId: "mig-builder-activate-builder-alice-g3" };
  expect(parseUserIdentity(identity, claimed.gatewayId)).toEqual(identity);
});

it.each([
  { bootMode: "unrecognized" },
  { bootMode: "activating" },
  { bootMode: "activating", activationMigrationId: "" },
])("rejects an unusable Native boot decision: %j", boot => {
  expect(parseUserIdentity({ ...claimed, ...boot }, claimed.gatewayId)).toBeNull();
});
