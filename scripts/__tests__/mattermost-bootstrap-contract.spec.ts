import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { buildPlanReceipt } from "../ops/terraform-plan-receipt.mjs";

const repoRoot = path.resolve(__dirname, "../..");
const read = (relativePath: string) => readFileSync(path.join(repoRoot, relativePath), "utf8");

function rebuildChangeAddresses(script: string): Set<string> {
  const match = script.match(/REBUILD_CHANGE_ADDRESSES=\(\n(?<addresses>(?:\s+'[^']+'\n)+)\)/u);
  if (!match?.groups?.addresses) throw new Error("REBUILD_CHANGE_ADDRESSES is missing");
  return new Set([...match.groups.addresses.matchAll(/'([^']+)'/gu)].map(([, address]) => address));
}

describe("Mattermost fresh-database bootstrap contract", () => {
  it("reuses the materialized admin password and restarts Mattermost before bootstrap", () => {
    const setup = read("scripts/setup-mattermost.sh");

    expect(setup).toContain('MM_ADMIN_PASS="${MM_ADMIN_PASS:-$(ksecret_key mattermost-gateway admin_pass)}"');
    expect(setup).toContain("kubectl rollout restart deployment/mattermost");
    expect(setup).toContain("Secret Manager password is required before Mattermost bootstrap");
    expect(setup.indexOf("kubectl rollout restart deployment/mattermost")).toBeLessThan(
      setup.indexOf("kubectl rollout status deployment/mattermost"),
    );
    expect(setup).not.toContain("kubectl wait --for=condition=available deployment/mattermost");
  });

  it("fails instead of treating an existing admin with a failed login as a fresh database", () => {
    const setup = read("scripts/setup-mattermost.sh");

    expect(setup).toContain('mmctl --local user search "$MM_ADMIN_USER"');
    expect(setup).toContain('Admin exists but API login failed');
    expect(setup).toContain('Fresh Mattermost admin is not present; creating it through mmctl --local');
  });

  it("probes admin existence with an mmctl subcommand that actually exists", () => {
    const setup = read("scripts/setup-mattermost.sh");

    // `mmctl user get` is not a subcommand: mmctl prints the `user` help and exits 0,
    // so the probe reported "admin exists" unconditionally and the fresh-bootstrap
    // branch below it was unreachable. `user search` exits 1 and prints "not found".
    expect(setup).not.toMatch(/mmctl --local user get\b/u);
  });

  it("requires the cached token to prove active platform PAT provenance", () => {
    const setup = read("scripts/setup-mattermost.sh");
    const secrets = read("scripts/setup-secrets.sh");
    const helper = read("scripts/lib/mattermost-admin-pat.sh");

    expect(setup).toContain('mm_admin_pat_is_valid "$CACHED_ADMIN_PAT" "$MM_ADMIN_USER" "$MM_ADMIN_USER_ID" "$CACHED_ADMIN_PAT_ID" "$CACHED_ADMIN_PAT_FINGERPRINT"');
    expect(setup).toContain('--from-literal=admin_token_id="${MM_ADMIN_PAT_ID:-}"');
    expect(setup).toContain('--from-literal=admin_token_fingerprint="${MM_ADMIN_PAT_FINGERPRINT:-}"');
    expect(helper).toContain('access_token.get("description") == sys.argv[3]');
    expect(helper).toContain('access_token.get("is_active") is True');
    expect(secrets).toContain('mattermost-gateway retained; setup-mattermost.sh owns the platform PAT');
    expect(secrets).not.toContain('MM_ADMIN_PAT="${MM_ADMIN_PAT:-$(ksecret_key mattermost-gateway admin_token)}"');
  });

  it("blocks a release on Cloud SQL secret drift and bootstraps Mattermost after Helm", () => {
    const workflow = read(".github/workflows/build-and-deploy.yml");
    const verify = read("scripts/verify-secrets.sh");
    const helmTest = read("helm/octogee/templates/tests/test-mm-admin-token.yaml");

    expect(verify).toContain('mattermost-cloud-sql/password differs from Secret Manager');
    expect(verify).toContain('TARGET_CLOUD_SQL_MATTERMOST_PASSWORD_SECRET');
    expect(workflow).toContain("Reconcile Mattermost bootstrap state");
    expect(workflow).toContain("./scripts/setup-mattermost.sh");
    expect(workflow).toContain("--skip-cloud-sql-password-sync");
    expect(workflow.indexOf("Reconcile Mattermost bootstrap state")).toBeGreaterThan(
      workflow.indexOf("Umbrella helm upgrade (platform release)"),
    );
    expect(workflow.indexOf("Verify required K8s secrets")).toBeGreaterThan(
      workflow.indexOf("Reconcile Mattermost bootstrap state"),
    );
    expect(helmTest).toContain("MM_ADMIN_USER_ID");
    expect(helmTest).toContain("system_admin");
    expect(helmTest).toContain("MM_ADMIN_TOKEN_FINGERPRINT");
    expect(helmTest).toContain("octogee platform admin PAT");
  });

  it("grants CI read-only access to the Mattermost password without Cloud SQL mutation rights", () => {
    const setup = read("scripts/setup-mattermost.sh");
    const westPlatform = read("terraform/environments/west-platform/main.tf");

    expect(setup).toContain("--skip-cloud-sql-password-sync");
    expect(westPlatform).toContain('github_actions_mattermost');
    expect(westPlatform).toContain('google_secret_manager_secret.cloud_sql["mattermost"].secret_id');
    expect(westPlatform).not.toContain('roles/cloudsql.admin');
  });

  it("accepts the declared Mattermost secret accessor but rejects arbitrary WEST rebuild changes", () => {
    const bootstrap = read("scripts/bootstrap-west-platform.sh");
    const westPlatform = read("terraform/environments/west-platform/main.tf");
    const expectedAddress = "google_secret_manager_secret_iam_member.github_actions_mattermost";
    const options = {
      target: "west-platform",
      phase: "pre-apply",
      generatedAt: "2026-07-23T19:00:00.000Z",
      gitCommit: "abc123",
      allowedDestructiveAddresses: new Set<string>(),
      allowedChangeAddresses: rebuildChangeAddresses(bootstrap),
    };

    expect(westPlatform).toContain(
      'resource "google_secret_manager_secret_iam_member" "github_actions_mattermost"',
    );
    expect(options.allowedChangeAddresses).toContain(expectedAddress);
    expect(
      buildPlanReceipt({
        format_version: "1.2",
        terraform_version: "1.16.4",
        resource_changes: [{ address: expectedAddress, change: { actions: ["create"] } }],
      }, options).summary,
    ).toEqual({ create: 1, update: 0, delete: 0, replace: 0 });
    expect(() =>
      buildPlanReceipt({
        format_version: "1.2",
        terraform_version: "1.16.4",
        resource_changes: [{
          address: "google_secret_manager_secret_iam_member.unexpected",
          change: { actions: ["create"] },
        }],
      }, options),
    ).toThrow("Plan contains an unauthorized change: google_secret_manager_secret_iam_member.unexpected");
  });

  it("makes the environment verifier prove the authenticated administrator contract", () => {
    const verify = read("scripts/verify-env.sh");

    expect(verify).toContain("Mattermost authenticated admin contract");
    expect(verify).toContain("/api/v4/users/me");
    expect(verify).toContain("/api/v4/users/tokens/$MM_ADMIN_TOKEN_ID");
    expect(verify).toContain("mattermost-cloud-sql/password does not match Secret Manager");
  });
});
