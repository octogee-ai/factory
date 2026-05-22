import { describe, it, expect } from "vitest";
import { validateRequiredEnv, REQUIRED_ENV } from "../required-env.js";

// gateway-edge needs these to function: INTERNAL_SERVICE_KEY (internal
// auth), GCP_PROJECT_ID (gateway-token resolution for the openclaw +
// activity bridges), GITEA_TOKEN + GITEA_ORG (workspace/git locality
// routes). When any is silently unset the process LIMPS — the activity
// bridge logs "no token source", git ops 401, and nothing fails at boot.
// This guard converts that silent limp into a loud, all-at-once crash.
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

  it("is a no-op in non-prod (dev/test/local legitimately lack them)", () => {
    expect(validateRequiredEnv({}, { isProd: false }).missing).toEqual([]);
  });
});
