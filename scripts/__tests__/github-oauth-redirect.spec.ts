import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../..");
const helperPath = path.join(repoRoot, "scripts/lib/github-oauth-redirect.sh");
const shellEnvPath = path.join(repoRoot, "scripts/lib/shell-env.sh");
const setupSecretsPath = path.join(repoRoot, "scripts/setup-secrets.sh");

function run(source: string): ReturnType<typeof spawnSync> {
  return spawnSync("bash", ["-euo", "pipefail", "-c", source, "--", helperPath, shellEnvPath, repoRoot], {
    cwd: repoRoot,
    encoding: "utf-8",
  });
}

describe("GitHub OAuth redirect preflight", () => {
  it("reports authorization reachability without claiming the callback is registered", () => {
    const result = run([
      'source "$1"',
      "fake_curl() { printf 'HTTP/2 302\\r\\nlocation: https://github.com/login?client_id=test\\r\\n'; }",
      "github_oauth_verify_redirect test-client https://api.example.test/api/connect/github/callback fake_curl",
    ].join("\n"));

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("GitHub OAuth authorization endpoint reachable");
    expect(result.stdout).toContain("Browser consent is required to prove callback registration");
    expect(result.stdout).not.toContain("callback accepted");
  });

  it("uses the final response when a proxy adds an initial response header", () => {
    const result = run([
      'source "$1"',
      "fake_curl() { printf 'HTTP/1.1 200 Connection established\\r\\n\\r\\nHTTP/2 302\\r\\nlocation: https://github.com/login?client_id=test\\r\\n'; }",
      "github_oauth_verify_redirect test-client https://api.example.test/api/connect/github/callback fake_curl",
    ].join("\n"));

    expect(result.status).toBe(0);
  });

  it("fails loudly when GitHub rejects the configured callback", () => {
    const result = run([
      'source "$1"',
      "fake_curl() { printf 'HTTP/2 302\\r\\nlocation: https://api.example.test/api/connect/github/callback?error=redirect_uri_mismatch\\r\\n'; }",
      "github_oauth_verify_redirect test-client https://api.example.test/api/connect/github/callback fake_curl",
    ].join("\n"));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("GitHub rejected the configured OAuth callback");
  });

  it("requires TEST and PROD to use distinct OAuth app client IDs", () => {
    const result = run([
      'source "$1"',
      "github_oauth_require_distinct_client_ids shared-client shared-client test-west prod-west",
    ].join("\n"));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("must use distinct GitHub OAuth client IDs");
  });

  it("preserves an intentionally disabled GitHub connector", () => {
    const result = run([
      'source "$2"',
      'source "$1"',
      `test -z "$(github_oauth_configured_client_id "$3/.env.example")"`,
    ].join("\n"));

    expect(result.status).toBe(0);
  });

  it("maps central deployment targets to their primary environment files", () => {
    const result = run([
      'source "$1"',
      `test "$(github_oauth_env_file_for_target "$3" test-central)" = "$3/.env.test"`,
      `test "$(github_oauth_env_file_for_target "$3" prod-central)" = "$3/.env"`,
    ].join("\n"));

    expect(result.status).toBe(0);
  });

  it("wires the isolation check into secret materialization for Central and WEST", () => {
    expect(readFileSync(setupSecretsPath, "utf8")).toContain("github_oauth_require_distinct_client_ids");
    expect(readFileSync(setupSecretsPath, "utf8")).toContain("test-central");
  });
});
