import { describe, expect, it } from "vitest";

import {
  isMacOpsRevisionAllowed,
  macOpsTokenIdsForDescription,
  revisionIdFromGatewayPodName,
} from "./fleet-broker.js";

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
