import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../..");
const read = (relativePath: string) => readFileSync(path.join(repoRoot, relativePath), "utf8");

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

    expect(setup).toContain('mmctl --local user get "$MM_ADMIN_USER"');
    expect(setup).toContain('Admin exists but API login failed');
    expect(setup).toContain('Fresh Mattermost admin is not present; creating it through mmctl --local');
  });

  it("requires the cached PAT to resolve to the exact system administrator", () => {
    const setup = read("scripts/setup-mattermost.sh");

    expect(setup).toContain('mm_pat_is_valid "$CACHED_ADMIN_PAT" "$MM_ADMIN_USER" "$MM_ADMIN_USER_ID"');
    expect(setup).toContain('roles.split()');
    expect(setup).toContain('"system_admin" in roles.split()');
    expect(setup).toContain('PAT does not resolve to the active system administrator');
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
  });

  it("grants CI read-only access to the Mattermost password without Cloud SQL mutation rights", () => {
    const setup = read("scripts/setup-mattermost.sh");
    const westPlatform = read("terraform/environments/west-platform/main.tf");

    expect(setup).toContain("--skip-cloud-sql-password-sync");
    expect(westPlatform).toContain('github_actions_mattermost');
    expect(westPlatform).toContain('google_secret_manager_secret.cloud_sql["mattermost"].secret_id');
    expect(westPlatform).not.toContain('roles/cloudsql.admin');
  });

  it("documents the foundation IAM apply required before the release can read the password", () => {
    expect(read("docs/handbook/21-deploy-and-cicd.md")).toContain(
      "apply the WEST foundation Terraform before tagging",
    );
  });

  it("makes the environment verifier prove the authenticated administrator contract", () => {
    const verify = read("scripts/verify-env.sh");

    expect(verify).toContain("Mattermost authenticated admin contract");
    expect(verify).toContain("/api/v4/users/me");
    expect(verify).toContain("mattermost-cloud-sql/password does not match Secret Manager");
  });
});
