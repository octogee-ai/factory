import { describe, expect, it } from "vitest";
import { MalformedRecordError } from "@octogee/core/platform-state";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import {
  listFleetGatewayRuntimes,
  readFleetGatewayRuntime,
} from "../ops/fleet.js";

function gatewayRoot(
  gatewayId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    gatewayId,
    createdAt: 1,
    createdBy: "test",
    updatedAt: 1,
    updatedBy: "test",
    latestRelease: 2,
    desiredRelease: 2,
    liveRelease: 2,
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
    ...overrides,
  };
}

function runtimeDoc(
  gatewayId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    docKind: "runtime",
    gatewayId,
    release: 2,
    lifecycle: "serving",
    heartbeat: {
      status: "ready",
      mountedCustomers: ["alice"],
    },
    ...overrides,
  };
}

describe("fleet durable gateway runtime", () => {
  it("reads the runtime heartbeat from the bare-id doc", async () => {
    const store = createDocumentFixtureStore({
      "gateways/default": gatewayRoot("default"),
      "glmGateways/default": runtimeDoc("default"),
    });

    await expect(readFleetGatewayRuntime(store, "default")).resolves.toEqual({
      gatewayId: "default",
      desiredStatus: "running",
      profile: "standard",
      heartbeat: {
        status: "ready",
        mountedCustomers: ["alice"],
      },
    });
  });

  it("refuses an existing malformed root instead of reading its bare glm doc", async () => {
    const store = createDocumentFixtureStore({
      "gateways/default": { gatewayId: "default" },
      "glmGateways/default": {
        heartbeat: { status: "ready", mountedCustomers: ["alice"] },
      },
    });

    await expect(readFleetGatewayRuntime(store, "default")).rejects.toBeInstanceOf(MalformedRecordError);
  });

  it("lists durable root identities from their bare-id runtime docs", async () => {
    const store = createDocumentFixtureStore({
      "gateways/default": gatewayRoot("default"),
      "glmGateways/default": runtimeDoc("default"),
    });

    await expect(listFleetGatewayRuntimes(store)).resolves.toEqual([
      {
        gatewayId: "default",
        runtime: {
          gatewayId: "default",
          desiredStatus: "running",
          profile: "standard",
          heartbeat: {
            status: "ready",
            mountedCustomers: ["alice"],
          },
        },
      },
    ]);
  });
});
