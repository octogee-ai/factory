import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../..");
const read = (relativePath: string) => readFileSync(path.join(repoRoot, relativePath), "utf8");

describe("Mattermost fresh-database bootstrap contract", () => {
  it.each(["test", "prod"])("prints an immutable-release Helm recipe for missing Mattermost in %s", (environment) => {
    const setup = read("scripts/setup-mattermost.sh");
    const start = setup.indexOf('  echo ""', setup.indexOf('  echo "  Next step: deploy Helm'));
    const end = setup.indexOf('  ok "K8s secrets ready.', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const printed = spawnSync("bash", ["-c", setup.slice(start, end)], {
      encoding: "utf8",
      env: { ...process.env, ENV: environment, TARGET_ID: environment, K8S_NAMESPACE: `octogee-${environment}`, K8S_CONTEXT: "test-context" },
    });
    expect(printed.status, printed.stderr).toBe(0);
    expect(printed.stdout).toContain('scripts/ops/render-release-helm-values.ts "$PLATFORM_SOURCE_SHA" > "$RELEASE_VALUES_FILE" || exit 1');
    expect(printed.stdout).toContain('-f "$RELEASE_VALUES_FILE"');
    expect(printed.stdout.indexOf("render-release-helm-values.ts")).toBeLessThan(printed.stdout.indexOf("helm upgrade"));
    expect(printed.stdout.indexOf('-f "$RELEASE_VALUES_FILE"')).toBeGreaterThan(printed.stdout.indexOf("render-deployment-target-helm-values.js"));
    const syntax = spawnSync("bash", ["-n"], { input: printed.stdout, encoding: "utf8" });
    expect(syntax.status, syntax.stderr).toBe(0);
  });

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

  it("makes the environment verifier prove the authenticated administrator contract", () => {
    const verify = read("scripts/verify-env.sh");

    expect(verify).toContain("Mattermost authenticated admin contract");
    expect(verify).toContain("/api/v4/users/me");
    expect(verify).toContain("/api/v4/users/tokens/$MM_ADMIN_TOKEN_ID");
    expect(verify).toContain("mattermost-cloud-sql/password does not match Secret Manager");
  });
});
