import { describe, expect, it } from "vitest";
import {
  verifyPostdeployInventory,
  verifyPredeployInventory,
} from "../ops/verify-firebase-function-release.mjs";

const targetRegion = "us-west1";
const desired = {
  scheduledJob: {
    __endpoint: {
      platform: "gcfv2",
      region: targetRegion,
      scheduleTrigger: {},
    },
  },
  firestoreTrigger: {
    __endpoint: {
      platform: "gcfv2",
      region: targetRegion,
      eventTrigger: { eventType: "google.cloud.firestore.document.v1.written" },
    },
  },
};

const inventory = [
  {
    codebase: "default",
    id: "scheduledJob",
    region: targetRegion,
    platform: "gcfv2",
    state: "ACTIVE",
    scheduleTrigger: {},
    runServiceId: "scheduledjob",
    serviceAccount: "123-compute@developer.gserviceaccount.com",
  },
  {
    codebase: "default",
    id: "firestoreTrigger",
    region: targetRegion,
    platform: "gcfv2",
    state: "ACTIVE",
    eventTrigger: {},
    runServiceId: "firestoretrigger",
    serviceAccount: "123-compute@developer.gserviceaccount.com",
  },
];

describe("Firebase function release verifier", () => {
  it("requires the exact active trigger inventory and emits scheduled IAM checks", () => {
    expect(verifyPostdeployInventory(inventory, desired, targetRegion)).toEqual([
      {
        runServiceId: "scheduledjob",
        serviceAccount: "123-compute@developer.gserviceaccount.com",
      },
    ]);
  });

  it.each([
    ["missing", inventory.slice(0, 1)],
    ["unexpected", [...inventory, { ...inventory[1], id: "stale" }]],
    ["inactive", inventory.map((entry) => entry.id === "scheduledJob" ? { ...entry, state: "FAILED" } : entry)],
    ["wrong trigger", inventory.map((entry) => entry.id === "scheduledJob" ? { ...entry, scheduleTrigger: undefined, eventTrigger: {} } : entry)],
  ])("rejects a %s deployed inventory", (_case, deployed) => {
    expect(() => verifyPostdeployInventory(deployed, desired, targetRegion)).toThrow();
  });

  it("rejects HTTP, callable, and non-Gen2 desired exports", () => {
    for (const endpoint of [
      { platform: "gcfv2", callableTrigger: {} },
      { platform: "gcfv2", httpsTrigger: {} },
      { platform: "gcfv1", eventTrigger: {} },
    ]) {
      expect(() => verifyPostdeployInventory([], { unsafe: { __endpoint: endpoint } }, targetRegion)).toThrow();
    }
  });

  it("allows only explicitly retired functions during the predeploy deletion guard", () => {
    const stale = { ...inventory[1], id: "retired" };

    expect(() => verifyPredeployInventory([...inventory, stale], desired, targetRegion, ["retired"]))
      .not.toThrow();
    expect(() => verifyPredeployInventory([...inventory, stale], desired, targetRegion, []))
      .toThrow("Unplanned Functions deletion blocked");
  });
});
