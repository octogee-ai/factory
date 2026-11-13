import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../..");

describe("secret repair guidance", () => {
  it("directs standard environments to the idempotent setup-secrets repair", () => {
    const script = readFileSync(path.join(repoRoot, "platform/scripts/verify-secrets.sh"), "utf8");

    expect(script).toContain('Quick fix: ./scripts/setup-secrets.sh --env=${ENV}');
    expect(script).not.toContain('Quick fix: ./scripts/bootstrap-env.sh');
  });

  it("does not retain the unused legacy Activity approval secret", () => {
    const script = readFileSync(path.join(repoRoot, "platform/scripts/verify-secrets.sh"), "utf8");

    expect(script).not.toContain('"approval-signing"');
    expect(script).not.toContain('"approval-signing:secret:./scripts/setup-secrets.sh ${FIX_SUFFIX}"');
  });

  it("retains the tracked Mattermost PAT during launch", () => {
    const script = readFileSync(path.join(repoRoot, "platform/scripts/setup-secrets.sh"), "utf8");

    expect(script).toContain('if [[ "$SECRET_SETUP_PHASE" == "launch" ]]; then');
    for (const [variable, key] of [
      ["MM_ADMIN_PAT", "admin_token"],
      ["MM_ADMIN_PAT_ID", "admin_token_id"],
      ["MM_ADMIN_PAT_FINGERPRINT", "admin_token_fingerprint"],
    ]) {
      expect(script).toContain(`${variable}="$(ksecret_key mattermost-gateway ${key})"`);
    }

    expect(script).toContain('if [[ "$SECRET_SETUP_PHASE" == "bootstrap" ]]; then');
    expect(script).toContain('ok "mattermost-gateway retained; setup-mattermost.sh owns the platform PAT"');
    expect(script).toContain('--from-literal=admin_token="$MM_ADMIN_PAT"');
    expect(script).toContain('--from-literal=admin_token_id="$MM_ADMIN_PAT_ID"');
    expect(script).toContain('--from-literal=admin_token_fingerprint="$MM_ADMIN_PAT_FINGERPRINT"');
  });

  it("does not materialize the unused legacy Activity approval secret", () => {
    const script = readFileSync(path.join(repoRoot, "platform/scripts/setup-secrets.sh"), "utf8");

    expect(script).not.toContain('APPROVAL_SIGNING_SECRET');
    expect(script).not.toContain('ksecret approval-signing');
  });

  it("requires an explicit WEST platform-migration ceremony before rotating restored Mattermost credentials", () => {
    const script = readFileSync(path.join(repoRoot, "platform/scripts/setup-mattermost.sh"), "utf8");

    expect(script).toContain("--rotate-platform-credentials");
    expect(script).toContain("--confirm-platform-migration=*");
    expect(script).toMatch(/test-west\|prod-west/);
    expect(script).toContain('[[ "$CONFIRM_PLATFORM_MIGRATION" == "$TARGET_ID" ]]');
    expect(script).toContain("openssl rand -base64 48");
    expect(script).toContain("mmctl --local user change-password");
    expect(script).toContain('CACHED_ADMIN_PAT=""');
    expect(script).toContain('save_env "MM_ADMIN_PASS" "$MM_ADMIN_PASS"');
  });

  it("uses the rotated credential to bootstrap a fresh Mattermost admin", () => {
    const script = readFileSync(path.join(repoRoot, "platform/scripts/setup-mattermost.sh"), "utf8");

    expect(script).toContain('/mattermost/bin/mmctl --local user search "$MM_ADMIN_USER"');
    expect(script).toContain("Fresh Mattermost admin is not present");
    expect(script.indexOf('mmctl --local user search "$MM_ADMIN_USER"')).toBeLessThan(
      script.indexOf('mmctl --local user change-password "$MM_ADMIN_USER"'),
    );
  });
});
