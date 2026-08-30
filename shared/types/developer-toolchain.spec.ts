import { describe, expect, it } from "vitest";
import {
  DEVELOPER_TOOLCHAIN_STATUS_FILE_RELATIVE_PATH,
  DEVELOPER_TOOLCHAIN_STATUS_SCHEMA_VERSION,
  isDeveloperToolchainStatus,
  parseDeveloperToolchainStatusArtifact,
} from "./developer-toolchain.js";

describe("developer toolchain status artifact", () => {
  it("accepts each published lifecycle state", () => {
    for (const status of ["pending", "downloading", "verifying", "ready", "failed"]) {
      expect(isDeveloperToolchainStatus(status)).toBe(true);
    }
  });

  it("parses a durable status artifact without accepting arbitrary status text", () => {
    expect(parseDeveloperToolchainStatusArtifact({
      schemaVersion: DEVELOPER_TOOLCHAIN_STATUS_SCHEMA_VERSION,
      status: "verifying",
      updatedAt: "2026-08-30T12:00:00.000Z",
    })).toEqual({
      schemaVersion: 1,
      status: "verifying",
      updatedAt: "2026-08-30T12:00:00.000Z",
    });
    expect(parseDeveloperToolchainStatusArtifact({
      schemaVersion: 1,
      status: "almost-ready",
      updatedAt: "2026-08-30T12:00:00.000Z",
    })).toBeNull();
  });

  it("keeps the runtime artifact in the per-home Octogee directory", () => {
    expect(DEVELOPER_TOOLCHAIN_STATUS_FILE_RELATIVE_PATH).toBe(".octogee/toolchains/status.json");
  });
});
