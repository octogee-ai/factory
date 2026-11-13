import { describe, expect, it } from "vitest";

import { verifyWestPlatformRetirementPlan } from "../ops/verify-west-platform-retirement.mjs";

const change = (address: string, actions: string[]) => ({ address, actions });

describe("WEST platform retirement contract", () => {
  it("rejects every destructive action while normal protection is selected", () => {
    expect(() => verifyWestPlatformRetirementPlan({
      retirementEnabled: false,
      changes: [change("google_container_cluster.west", ["delete"])],
    })).toThrow("retirement mode is not enabled");
  });

  it("allows only the declared WEST global-address destruction set", () => {
    expect(verifyWestPlatformRetirementPlan({
      retirementEnabled: true,
      changes: [
        change('google_compute_global_address.west_ingress["gitea-ip-west"]', ["delete"]),
        change("google_compute_global_address.private_services", ["delete"]),
      ],
    })).toEqual("retirement");

    expect(() => verifyWestPlatformRetirementPlan({
      retirementEnabled: true,
      changes: [change('google_compute_global_address.monitoring_grafana', ["delete"])],
    })).toThrow("grafana-ip");
  });
});
