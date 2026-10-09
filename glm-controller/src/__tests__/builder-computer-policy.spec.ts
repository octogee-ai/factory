import { describe, expect, it } from "vitest";
import { BUILDER_TIERS } from "@octogee/shared/types/billing-tiers";
import { resolveBuilderComputerPolicy } from "../vm-gateway-runtime.js";

describe("Builder tier computer placement", () => {
  it.each([
    ["hobby", "s", 20, "cluster", "x11", null, 10, 100],
    ["pro", "m", 100, "gce-vm", "omarchy", "n2-standard-2", 50, 500],
    ["team", "l", 200, "gce-vm", "omarchy", "n2-standard-4", 100, 1024],
  ] as const)("keeps %s home capacity separate from project storage", (tier, sizing, price, runtime, desktop, machineType, homeSizeGiB, projectStorageGb) => {
    expect(BUILDER_TIERS[tier]).toMatchObject({ instance: sizing, monthlyPrice: price });
    expect(BUILDER_TIERS[tier].fallbackStorageGb).toBe(projectStorageGb);
    expect(resolveBuilderComputerPolicy(sizing)).toEqual({ runtime, desktop, machineType, homeSizeGiB });
  });

  it("uses Hobby sizing for an unspecified Builder and rejects a shared-only floor", () => {
    expect(resolveBuilderComputerPolicy(undefined).runtime).toBe("cluster");
    expect(() => resolveBuilderComputerPolicy("xs")).toThrow(/Builder computer/);
  });
});
