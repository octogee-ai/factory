import { describe, expect, it } from "vitest";
import {
  parseConfiguredUserReport,
  parseOpenClawProcessReport,
  ADD_USER_DEADLINE_MS,
  MIGRATION_IMPORT_FINISH_TIMEOUT_MS,
  MIGRATION_IMPORT_DOCTOR_PHASE_TIMEOUT_MS,
  MIGRATION_IMPORT_DESCRIPTOR_TIMEOUT_MS,
  VERIFY_ACCOUNT_TIMEOUT_MS,
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

  it("budgets Shared final import copies, two Native Doctor phases, and activation", () => {
    expect(MIGRATION_IMPORT_FINISH_TIMEOUT_MS).toBeGreaterThanOrEqual(
      3 * MIGRATION_TRANSFER_TIMEOUT_MS + 2 * MIGRATION_IMPORT_DOCTOR_PHASE_TIMEOUT_MS + MIGRATION_IMPORT_DESCRIPTOR_TIMEOUT_MS + ADD_USER_DEADLINE_MS +
      IMPORT_ACTIVATION_PATCH_DEADLINE_MS + CONFIG_RELOAD_DEADLINE_MS + VERIFY_ACCOUNT_TIMEOUT_MS + 30_000,
    );
  });

  it("keeps the migrating-in pin alive through transfer, activation, and verification", () => {
    expect(MIGRATING_IN_PIN_TTL_MS).toBeGreaterThanOrEqual(
      MIGRATION_TRANSFER_TIMEOUT_MS + IMPORT_ACTIVATION_PATCH_DEADLINE_MS + MIGRATION_VERIFY_TIMEOUT_MS + 60_000,
    );
  });
});

describe("configured user report", () => {
  it("parses the claimed state and nothing else", () => {
    expect(parseConfiguredUserReport({ state: "claimed", generation: 3 })).toEqual({ state: "claimed", generation: 3 });
    expect(parseConfiguredUserReport({ state: "claimed", generation: null })).toEqual({ state: "claimed", generation: null });
    for (const value of [null, "claimed", { state: "booting" }, { state: "applying", generation: 4 },
      { state: "failed", generation: 4, error: "clone failed" }, { state: "claimed", generation: 0 },
      { state: "claimed" }, { state: "claimed", generation: 3, slug: "alice" }]) {
      expect(parseConfiguredUserReport(value)).toBeNull();
    }
  });
});

describe("OpenClaw process report", () => {
  it("parses each process state with the move that holds it, if any", () => {
    for (const state of ["held", "hydrated", "starting", "serving", "unavailable"] as const) {
      expect(parseOpenClawProcessReport({ state, migrationId: null })).toEqual({ state, migrationId: null });
    }
    expect(parseOpenClawProcessReport({ state: "held", migrationId: "mig-1" })).toEqual({ state: "held", migrationId: "mig-1" });
  });

  it("accepts the ids a move, an activation and a surge handoff hold the process under", () => {
    for (const migrationId of [
      "mig-0b8f6f0e-6f0a-4a57-9a43-1f6f3a1c2d10",
      "mig-builder-activate-jefe-run-g67",
      "mig-recover-disposable-reset-Xk3pQ9vR2mT7wL8nY4cB6dF1gH5j-jefe-run-12",
      "surge-jefe-run-4520118391837465",
      "surge-jefe-run-0b8f6f0e-6f0a-4a57-9a43-1f6f3a1c2d10",
    ]) {
      expect(parseOpenClawProcessReport({ state: "hydrated", migrationId })).toEqual({ state: "hydrated", migrationId });
    }
  });

  it("rejects a migration id that is not one, since the gateway's own user can write it", () => {
    for (const migrationId of ["mig-", "mig-1 <b>held</b>", "mig-1\nstatus: ok", "operator-says-hi", "mig-1/../2",
      `mig-${"a".repeat(201)}`]) {
      expect(parseOpenClawProcessReport({ state: "held", migrationId })).toBeNull();
    }
  });

  it("rejects anything else", () => {
    for (const value of [null, "held", { state: "held" }, { state: "none", migrationId: null },
      { state: "held", migrationId: "" }, { state: "held", migrationId: 3 },
      { state: "held", migrationId: null, slug: "alice" }]) {
      expect(parseOpenClawProcessReport(value)).toBeNull();
    }
  });
});
