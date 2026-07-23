import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const testDir = dirname(fileURLToPath(import.meta.url));
const library = resolve(testDir, "../lib/iap-endpoint-health.sh");
const verifier = readFileSync(resolve(testDir, "../verify-env.sh"), "utf8");

function requiresIap(host: string) {
  return spawnSync("bash", ["-c", 'source "$1"; is_iap_protected_admin_host "$2"', "--", library, host]).status === 0;
}

function isExpectedIapRedirect(code: string, redirectUrl: string) {
  return spawnSync("bash", ["-c", 'source "$1"; is_expected_iap_redirect "$2" "$3"', "--", library, code, redirectUrl]).status === 0;
}

describe("IAP endpoint health classification", () => {
  it("recognizes the consolidated TEST admin hosts without treating public hosts as IAP-only", () => {
    expect(existsSync(library)).toBe(true);
    expect(requiresIap("git-test.octogee.com")).toBe(true);
    expect(requiresIap("mattermost-test.octogee.com")).toBe(true);
    expect(requiresIap("git.octogee.com")).toBe(true);
    expect(requiresIap("mattermost.octogee.com")).toBe(true);
    expect(requiresIap("api-test.octogee.com")).toBe(false);
    expect(requiresIap("preview-test.octogee.com")).toBe(false);
  });

  it("uses the host classification when evaluating endpoint health", () => {
    expect(verifier).toContain('source "$SCRIPT_DIR/lib/iap-endpoint-health.sh"');
    expect(verifier).toContain('is_iap_protected_admin_host "$HOST"');
    expect(verifier).toContain('is_expected_iap_redirect "$HTTP_CODE" "$REDIRECT_URL"');
    expect(verifier).toContain('"$HTTP_CODE" == "200"');
  });

  it("accepts only the Google sign-in redirect for IAP-protected hosts", () => {
    expect(isExpectedIapRedirect("302", "https://accounts.google.com/o/oauth2/v2/auth")).toBe(true);
    expect(isExpectedIapRedirect("302", "https://example.test/login")).toBe(false);
    expect(isExpectedIapRedirect("200", "")).toBe(false);
  });
});
