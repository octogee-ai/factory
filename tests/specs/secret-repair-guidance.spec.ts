import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../..");

describe("secret repair guidance", () => {
  it("directs standard environments to the idempotent setup-secrets repair", () => {
    const script = readFileSync(path.join(repoRoot, "scripts/verify-secrets.sh"), "utf8");

    expect(script).toContain('Quick fix: ./scripts/setup-secrets.sh --env=${ENV}');
    expect(script).not.toContain('Quick fix: ./scripts/bootstrap-env.sh');
  });

  it("requires the approval-signing secret consumed by the activity bridge", () => {
    const script = readFileSync(path.join(repoRoot, "scripts/verify-secrets.sh"), "utf8");

    expect(script).toContain('"approval-signing"');
    expect(script).toContain('"approval-signing:secret:./scripts/setup-secrets.sh ${FIX_SUFFIX}"');
  });

  it("preserves materialized Mattermost credentials when local bootstrap inputs are absent", () => {
    const script = readFileSync(path.join(repoRoot, "scripts/setup-secrets.sh"), "utf8");

    for (const [variable, key] of [
      ["MM_ADMIN_PASS", "admin_pass"],
      ["MM_ADMIN_TOKEN", "admin_token"],
      ["MM_TEAM_ID", "team_id"],
      ["MM_ADMIN_USER_ID", "admin_user_id"],
    ]) {
      expect(script).toContain(`${variable}="\${${variable}:-$(ksecret_key mattermost-gateway ${key})}"`);
    }
  });

  it("materializes approval-signing once and reuses the existing value", () => {
    const script = readFileSync(path.join(repoRoot, "scripts/setup-secrets.sh"), "utf8");

    expect(script).toContain('APPROVAL_SIGNING_SECRET=$(ksecret_key approval-signing secret)');
    expect(script).toContain('ksecret approval-signing --from-literal=secret="$APPROVAL_SIGNING_SECRET"');
  });
});
