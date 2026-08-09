import { describe, expect, it } from "vitest";
import {
  listFleetGatewayRuntimes,
  readFleetGatewayRuntime,
} from "../ops/fleet.js";

type Docs = Record<string, Record<string, unknown>>;

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
    openclawOverrides: null,
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

function database(docs: Docs, gatewayIds: readonly string[] = []): {
  doc(path: string): { get(): Promise<{ exists: boolean; data(): Record<string, unknown> | undefined }> };
  collection(name: string): {
    get(): Promise<{ docs: Array<{ id: string; data(): Record<string, unknown> | undefined }> }>;
  };
} {
  return {
    doc(path) {
      return {
        get: async () => ({
          exists: docs[path] !== undefined,
          data: () => docs[path],
        }),
      };
    },
    collection(name) {
      if (name !== "gateways") throw new Error(`unexpected collection ${name}`);
      return {
        get: async () => ({
          docs: gatewayIds.map((id) => ({ id, data: () => docs[`gateways/${id}`] })),
        }),
      };
    },
  };
}

describe("fleet durable gateway runtime", () => {
  it("reads the runtime heartbeat from the bare-id doc", async () => {
    const db = database({
      "gateways/default": gatewayRoot("default"),
      "glmGateways/default": runtimeDoc("default"),
    });

    await expect(readFleetGatewayRuntime(db as never, "default")).resolves.toEqual({
      gatewayId: "default",
      desiredStatus: "running",
      profile: "standard",
      heartbeat: {
        status: "ready",
        mountedCustomers: ["alice"],
      },
    });
  });

  it("fails closed for an existing malformed root instead of reading its bare glm doc", async () => {
    const db = database({
      "gateways/default": { gatewayId: "default" },
      "glmGateways/default": {
        heartbeat: { status: "ready", mountedCustomers: ["alice"] },
      },
    });

    await expect(readFleetGatewayRuntime(db as never, "default")).resolves.toBeNull();
  });

  it("lists durable root identities from their bare-id runtime docs", async () => {
    const db = database({
      "gateways/default": gatewayRoot("default"),
      "glmGateways/default": runtimeDoc("default"),
    }, ["default"]);

    await expect(listFleetGatewayRuntimes(db as never)).resolves.toEqual([
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
