import { describe, expect, it } from "vitest";
import { BUILDER_TIERS } from "@octogee/shared/types/billing-tiers";
import { resolveBuilderComputerPolicy } from "../vm-gateway-runtime.js";

describe("Builder tier computer placement", () => {
  it.each([
    ["hobby", "s", 20, "gce-vm", "x11", "e2-medium", "STANDARD", { sizeGb: 80, type: "pd-balanced" }, 10, 100],
    ["pro", "m", 100, "gce-vm", "omarchy", "e2-standard-2", "STANDARD", { sizeGb: 80, type: "pd-ssd" }, 50, 500],
    ["team", "l", 200, "gce-vm", "omarchy", "e2-standard-4", "STANDARD", { sizeGb: 80, type: "pd-ssd" }, 100, 1024],
  ] as const)("keeps %s home capacity separate from project storage", (tier, sizing, price, runtime, desktop, machineType, provisioningModel, bootDisk, homeSizeGiB, projectStorageGb) => {
    expect(BUILDER_TIERS[tier]).toMatchObject({ instance: sizing, monthlyPrice: price });
    expect(BUILDER_TIERS[tier].fallbackStorageGb).toBe(projectStorageGb);
    expect(resolveBuilderComputerPolicy(sizing)).toEqual({ runtime, desktop, machineType, provisioningModel, bootDisk, homeSizeGiB });
  });

  it("uses Hobby sizing for an unspecified Builder and rejects a shared-only floor", () => {
    expect(resolveBuilderComputerPolicy(undefined).desktop).toBe("x11");
    expect(() => resolveBuilderComputerPolicy("xs")).toThrow(/Builder computer/);
  });
});
