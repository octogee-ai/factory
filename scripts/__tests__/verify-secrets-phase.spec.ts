import { describe, expect, it } from "vitest";
import { scriptsTreeWith } from "./fixtures/scripts-tree.js";
import { bootstrapNamespace, MATTERMOST_GATEWAY_KEYS, verifySecrets, type Namespace } from "./fixtures/verify-secrets.js";

const platformTree = scriptsTreeWith();
const verifyPlatformSecrets = (namespace: Namespace, ...args: string[]) => verifySecrets(platformTree, namespace, ...args);

describe("verify-secrets phases", () => {
  it("accepts a fresh namespace before Helm while setup-mattermost has yet to fill mattermost-gateway", () => {
    const { status, output } = verifyPlatformSecrets(bootstrapNamespace, "--phase=bootstrap");

    expect(status, output).toBe(0);
    for (const key of MATTERMOST_GATEWAY_KEYS) {
      expect(output).toContain(`mattermost-gateway/${key} — skipped (set by setup-mattermost.sh after Helm)`);
    }
  });

  it("still requires the mattermost-gateway shell to exist before Helm", () => {
    const { status, output } = verifyPlatformSecrets({ missing: ["mattermost-gateway"] }, "--phase=bootstrap");

    expect(status).toBe(1);
    expect(output).toContain("mattermost-gateway — MISSING");
  });

  it("still fails before Helm on a blank value setup-secrets owns", () => {
    const { status, output } = verifyPlatformSecrets({
      overrides: { ...bootstrapNamespace.overrides, "octogee-openrouter": { api_key: "" } },
    }, "--phase=bootstrap");

    expect(status).toBe(1);
    expect(output).toContain("octogee-openrouter/api_key — EMPTY");
  });

  it.each([
    { phase: "the default phase", args: [] },
    { phase: "--phase=launch", args: ["--phase=launch"] },
  ])("demands every mattermost-gateway value under $phase", ({ args }) => {
    const { status, output } = verifyPlatformSecrets(bootstrapNamespace, ...args);

    expect(status).toBe(1);
    for (const key of MATTERMOST_GATEWAY_KEYS) {
      expect(output).toContain(`mattermost-gateway/${key} — EMPTY`);
    }
    expect(output).toContain(`${MATTERMOST_GATEWAY_KEYS.length} issue(s) found`);
  });

  it("says when it loaded no secret extensions", () => {
    const { output } = verifyPlatformSecrets(bootstrapNamespace, "--phase=bootstrap");

    expect(output).toContain("No secret extensions loaded");
  });

  it("rejects an unknown phase", () => {
    const { status, output } = verifyPlatformSecrets(bootstrapNamespace, "--phase=preflight");

    expect(status).toBe(1);
    expect(output).toContain("--phase must be bootstrap or launch");
  });
});
