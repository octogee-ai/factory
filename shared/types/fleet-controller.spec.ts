import { describe, expect, it } from "vitest";
import {
  parseConfiguredBuilderReport,
  CONFIG_PATCH_DEADLINE_MS,
  CONFIG_RELOAD_DEADLINE_MS,
  IMPORT_ACTIVATION_PATCH_DEADLINE_MS,
  MIGRATING_IN_PIN_TTL_MS,
  MIGRATION_TRANSFER_TIMEOUT_MS,
  MIGRATION_VERIFY_TIMEOUT_MS,
} from "./fleet-controller.js";

describe("fleet-controller migration budgets", () => {
  it("lets an import activation wait out one gateway restart plus a reload", () => {
    expect(IMPORT_ACTIVATION_PATCH_DEADLINE_MS).toBe(
      CONFIG_PATCH_DEADLINE_MS + 2 * CONFIG_RELOAD_DEADLINE_MS,
    );
  });

  it("keeps the migrating-in pin alive through transfer, activation, and verification", () => {
    expect(MIGRATING_IN_PIN_TTL_MS).toBeGreaterThanOrEqual(
      MIGRATION_TRANSFER_TIMEOUT_MS + IMPORT_ACTIVATION_PATCH_DEADLINE_MS + MIGRATION_VERIFY_TIMEOUT_MS + 60_000,
    );
  });
});

describe("configured Builder report", () => {
  it("parses the standby, claiming, claimed and claim-failed states and nothing else", () => {
    expect(parseConfiguredBuilderReport({ state: "standby" })).toEqual({ state: "standby" });
    expect(parseConfiguredBuilderReport({ state: "claimed", generation: 3 })).toEqual({ state: "claimed", generation: 3 });
    expect(parseConfiguredBuilderReport({ state: "claimed", generation: null })).toEqual({ state: "claimed", generation: null });
    expect(parseConfiguredBuilderReport({ state: "claiming", generation: 4 })).toEqual({ state: "claiming", generation: 4 });
    expect(parseConfiguredBuilderReport({ state: "claim-failed", generation: 4, error: "clone failed" }))
      .toEqual({ state: "claim-failed", generation: 4, error: "clone failed" });
    for (const value of [null, "standby", { state: "standby", slug: "alice" }, { state: "claimed", generation: 0 },
      { state: "claimed" }, { state: "claiming", generation: null }, { state: "claiming" },
      { state: "claim-failed", generation: 4 }, { state: "claim-failed", generation: 4, error: "" },
      { state: "claim-failed", generation: null, error: "x" }]) {
      expect(parseConfiguredBuilderReport(value)).toBeNull();
    }
  });
});
