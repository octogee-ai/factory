import { describe, it, expect } from "vitest";
import { validateRequiredEnv, REQUIRED_ENV } from "../required-env.js";

const full = {
  INTERNAL_SERVICE_KEY: "k",
  GCP_PROJECT_ID: "octogee",
  GITEA_TOKEN: "t",
};

describe("validateRequiredEnv", () => {
  it("returns no missing when all required env present (prod)", () => {
    expect(validateRequiredEnv(full, { isProd: true }).missing).toEqual([]);
  });

  it("flags each individually-missing required var (prod)", () => {
    for (const key of REQUIRED_ENV) {
      const { [key]: _omit, ...rest } = full;
      expect(validateRequiredEnv(rest, { isProd: true }).missing).toContain(key);
    }
  });

  it("treats empty string as missing — the exact silent-drop shape (#1131 fallout)", () => {
    expect(
      validateRequiredEnv({ ...full, GCP_PROJECT_ID: "" }, { isProd: true }).missing,
    ).toContain("GCP_PROJECT_ID");
  });

  it("treats whitespace-only as missing (a blank cred/ID fails the same at runtime)", () => {
    expect(
      validateRequiredEnv({ ...full, GITEA_TOKEN: "   " }, { isProd: true }).missing,
    ).toContain("GITEA_TOKEN");
  });

  it("does NOT require GITEA_ORG — gateway-edge never reads it from env", () => {
    expect(validateRequiredEnv(full, { isProd: true }).missing).toEqual([]);
    expect([...REQUIRED_ENV]).not.toContain("GITEA_ORG");
  });

  it("lists ALL missing at once so one crash names every gap", () => {
    expect(validateRequiredEnv({}, { isProd: true }).missing.sort()).toEqual(
      [...REQUIRED_ENV].sort(),
    );
  });

  it("does not require platform gateway-edge secrets for operator profile", () => {
    expect(validateRequiredEnv({}, { isProd: true, profile: "operator" }).missing).toEqual([]);
  });

  it("still requires platform gateway-edge secrets when profile is standard", () => {
    expect(validateRequiredEnv({}, { isProd: true, profile: "standard" }).missing.sort()).toEqual(
      [...REQUIRED_ENV].sort(),
    );
  });

  it("is a no-op in non-prod (dev/test/local legitimately lack them)", () => {
    expect(validateRequiredEnv({}, { isProd: false }).missing).toEqual([]);
  });
});
