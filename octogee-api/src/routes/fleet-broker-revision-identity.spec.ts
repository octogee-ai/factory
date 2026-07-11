import { describe, expect, it } from "vitest";

import {
  isMacOpsRevisionAllowed,
  legacyMacOpsTokenAllowed,
  macOpsTokenIdsForDescription,
  resolveAssignedUsersRevisionGate,
  revisionIdFromGatewayPodName,
} from "./fleet-broker.js";

function gatewayStateDb(data: Record<string, unknown> | undefined) {
  return {
    collection: (name: string) => {
      if (name !== "gateways") throw new Error(`unexpected collection ${name}`);
      return {
        doc: () => ({
          get: async () => ({ exists: data !== undefined, data: () => data }),
          collection: (subcollection: string) => {
            if (subcollection !== "assignments") {
              throw new Error(`unexpected subcollection ${subcollection}`);
            }
            return { get: async () => ({ docs: [] }) };
          },
        }),
      };
    },
  };
}

describe("revisionIdFromGatewayPodName", () => {
  it("derives the immutable revision from the authenticated Deployment pod name", () => {
    expect(
      revisionIdFromGatewayPodName(
        "default",
        "octogee-gateway-default-r27-5bc5949d46-p946t",
      ),
    ).toBe("default-r27");
  });

  it("refuses pods outside the gateway Deployment naming contract", () => {
    expect(revisionIdFromGatewayPodName("default", "octogee-gateway-default-r27")).toBeNull();
    expect(revisionIdFromGatewayPodName("default", "octogee-gateway-other-r27-5bc5949d46-p946t")).toBeNull();
    expect(revisionIdFromGatewayPodName("default", "octogee-gateway-default-r027-5bc5949d46-p946t")).toBeNull();
  });
});

describe("macOpsTokenIdsForDescription", () => {
  it("does not select a target revision token when the source restarts", () => {
    expect(
      macOpsTokenIdsForDescription(
        [
          {
            id: "source-token",
            description: "Octogee Mac ops agent (OpenClaw) [revision=default-r2]",
          },
          {
            id: "target-token",
            description: "Octogee Mac ops agent (OpenClaw) [revision=default-r5]",
          },
        ],
        "Octogee Mac ops agent (OpenClaw) [revision=default-r2]",
      ),
    ).toEqual(["source-token"]);
  });
});

describe("isMacOpsRevisionAllowed", () => {
  it("allows only the durable live/source/target revisions", () => {
    const gateway = {
      desiredRelease: 5,
      liveRevisionId: "default-r2",
      roll: { sourceRevisionId: "default-r2", targetRevisionId: "default-r5" },
    };

    expect(isMacOpsRevisionAllowed("default", "default-r2", gateway)).toBe(true);
    expect(isMacOpsRevisionAllowed("default", "default-r5", gateway)).toBe(true);
    expect(isMacOpsRevisionAllowed("default", "default-r99", gateway)).toBe(false);
    expect(isMacOpsRevisionAllowed("default", "default-r2", undefined)).toBe(false);
  });

  it("allows a prewarmed desired revision before traffic leaves the live revision", () => {
    const gateway = {
      desiredRelease: 6,
      liveRevisionId: "default-r2",
      roll: null,
    };

    expect(isMacOpsRevisionAllowed("default", "default-r2", gateway)).toBe(true);
    expect(isMacOpsRevisionAllowed("default", "default-r6", gateway)).toBe(true);
    expect(isMacOpsRevisionAllowed("default", "default-r5", gateway)).toBe(false);
  });
});

describe("fleet broker durable root boundary", () => {
  const incompleteRoot = { gatewayId: "default", internalUrl: "http://legacy-should-not-run" };

  it("permits the empty-revision legacy roster path only when the root is absent", async () => {
    await expect(
      resolveAssignedUsersRevisionGate(gatewayStateDb(undefined) as never, "default", ""),
    ).resolves.toEqual({ allowed: true, liveRevisionId: null });
    await expect(
      resolveAssignedUsersRevisionGate(gatewayStateDb(incompleteRoot) as never, "default", ""),
    ).resolves.toEqual({ allowed: false });
  });

  it("requires a durable root when a routing roster is requested", async () => {
    await expect(
      resolveAssignedUsersRevisionGate(
        gatewayStateDb(undefined) as never,
        "default",
        "default-r1",
        { requireDurableRoot: true },
      ),
    ).resolves.toEqual({ allowed: false });
  });

  it("does not mint a legacy MAC token when an invalid root already exists", async () => {
    const allowed = await legacyMacOpsTokenAllowed(
      gatewayStateDb(incompleteRoot) as never,
      {
        kind: "gateway",
        gatewayId: "default",
        podName: "octogee-gateway-default-123",
        podUid: "pod-uid",
      } as never,
    );

    expect(allowed).toBe(false);
  });
});
