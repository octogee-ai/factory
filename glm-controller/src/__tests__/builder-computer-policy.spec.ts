import { describe, expect, it } from "vitest";
import { FIXTURE_SIZING_PROFILES } from "@octogee/core/testing/journal-store";
import { BUILDER_TIERS } from "@octogee/shared/types/billing-tiers";
import { resolveBuilderComputerPolicy } from "../vm-gateway-runtime.js";

function storeWith(sizingProfiles: Record<string, unknown>) {
  return {
    config: { orchestrator: { get: async () => ({ sizingProfiles }) } },
  } as unknown as Parameters<typeof resolveBuilderComputerPolicy>[0];
}

const store = storeWith(FIXTURE_SIZING_PROFILES);

describe("Builder tier computer placement", () => {
  it.each([
    ["hobby", "s", 20, "gce-vm", "x11", "e2-medium", "STANDARD", { sizeGb: 80, type: "pd-balanced" }, 10, 100],
    ["pro", "m", 100, "gce-vm", "omarchy", "e2-standard-2", "STANDARD", { sizeGb: 80, type: "pd-ssd" }, 50, 500],
    ["team", "l", 200, "gce-vm", "omarchy", "e2-standard-4", "STANDARD", { sizeGb: 80, type: "pd-ssd" }, 100, 1024],
  ] as const)("keeps %s home capacity separate from project storage", async (tier, sizing, price, runtime, desktop, machineType, provisioningModel, bootDisk, homeSizeGiB, projectStorageGb) => {
    expect(BUILDER_TIERS[tier]).toMatchObject({ instance: sizing, monthlyPrice: price });
    expect(BUILDER_TIERS[tier].fallbackStorageGb).toBe(projectStorageGb);
    await expect(resolveBuilderComputerPolicy(store, sizing)).resolves.toEqual({ runtime, desktop, machineType, provisioningModel, bootDisk, homeSizeGiB });
  });

  it("refuses a sizing tier claimed by profiles with different computers", async () => {
    const conflicting = storeWith({ hobby: FIXTURE_SIZING_PROFILES.hobby, pro: { ...FIXTURE_SIZING_PROFILES.pro, sizingTier: "s" } });
    await expect(resolveBuilderComputerPolicy(conflicting, "s")).rejects.toThrow("Conflicting Builder computer policies for sizing tier s: hobby, pro");
  });

  it("accepts profiles that share a sizing tier and computer", async () => {
    const shared = storeWith({ hobby: FIXTURE_SIZING_PROFILES.hobby, starter: FIXTURE_SIZING_PROFILES.hobby });
    await expect(resolveBuilderComputerPolicy(shared, "s")).resolves.toMatchObject({ desktop: "x11" });
  });

  it("uses Hobby sizing for an unspecified Builder and rejects a shared-only floor", async () => {
    await expect(resolveBuilderComputerPolicy(store, undefined)).resolves.toMatchObject({ desktop: "x11" });
    await expect(resolveBuilderComputerPolicy(store, "xs")).rejects.toThrow(/Builder computer/);
  });
});
