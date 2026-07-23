import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../..");
const script = path.join(repoRoot, "scripts/ops/reconcile-west-identity-platform-login-providers.sh");

type RunOptions = {
  apply?: boolean;
  target?: "test-west" | "prod-west";
  emailPassword?: boolean;
  githubClientId?: string;
  microsoft?: boolean;
  missingSecret?: string;
  providerResourceProject?: string;
};

function executable(file: string, source: string): void {
  writeFileSync(file, source);
  chmodSync(file, 0o755);
}

function runReconciler(options: RunOptions = {}) {
  const temp = mkdtempSync(path.join(tmpdir(), "octogee-login-providers-"));
  const log = path.join(temp, "calls.log");
  const microsoftState = path.join(temp, "microsoft-present");
  writeFileSync(log, "");
  writeFileSync(microsoftState, options.microsoft ? "true\n" : "false\n");

  executable(path.join(temp, "gcloud"), `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1 $2" == "auth print-access-token" ]]; then
  printf 'access-token\\n'
  exit 0
fi
if [[ "$1 $2 $3" == "secrets versions access" ]]; then
  secret=""
  for arg in "$@"; do
    case "$arg" in --secret=*) secret="\${arg#--secret=}" ;; esac
  done
  [[ "$secret" != "$FAKE_MISSING_SECRET" ]] || exit 1
  case "$secret" in
    FIREBASE_AUTH_GOOGLE_CLIENT_ID) printf 'login-google-client\\n' ;;
    FIREBASE_AUTH_GOOGLE_CLIENT_SECRET) printf 'login-google-secret\\n' ;;
    FIREBASE_AUTH_GITHUB_CLIENT_ID) printf 'login-github-client\\n' ;;
    FIREBASE_AUTH_GITHUB_CLIENT_SECRET) printf 'login-github-secret\\n' ;;
    *) printf 'unexpected secret: %s\\n' "$secret" >&2; exit 2 ;;
  esac
  exit 0
fi
printf 'unexpected gcloud call: %s\\n' "$*" >&2
exit 2
`);

  executable(path.join(temp, "curl"), `#!/usr/bin/env bash
set -euo pipefail
method=GET
output=""
body=""
while (($#)); do
  case "$1" in
    --request) method="$2"; shift 2 ;;
    --output) output="$2"; shift 2 ;;
    --data-binary) body="$2"; shift 2 ;;
    *) url="$1"; shift ;;
  esac
done
printf '%s %s\\n' "$method" "$url" >> "$FAKE_CALL_LOG"
case "$url" in
  */config)
    if [[ "$FAKE_EMAIL_PASSWORD" == "true" ]]; then
      printf '%s\\n' '{"signIn":{"email":{"enabled":true,"passwordRequired":true}}}' > "$output"
    else
      printf '%s\\n' '{"signIn":{"email":{"enabled":false,"passwordRequired":false}}}' > "$output"
    fi
    ;;
  */defaultSupportedIdpConfigs)
    project="\${url#*projects/}"
    project="\${project%%/*}"
    resource_project="$FAKE_PROVIDER_RESOURCE_PROJECT"
    [[ -n "$resource_project" ]] || resource_project="$project"
    github="$FAKE_GITHUB_CLIENT_ID"
    microsoft=''
    if [[ "$(cat "$FAKE_MICROSOFT_STATE")" == "true" ]]; then
      microsoft=',{"name":"projects/'"$resource_project"'/defaultSupportedIdpConfigs/microsoft.com","enabled":true,"clientId":"microsoft-client"}'
    fi
    printf '{"defaultSupportedIdpConfigs":[{"name":"projects/%s/defaultSupportedIdpConfigs/google.com","enabled":true,"clientId":"login-google-client"},{"name":"projects/%s/defaultSupportedIdpConfigs/github.com","enabled":true,"clientId":"%s"}%s]}\\n' "$resource_project" "$resource_project" "$github" "$microsoft" > "$output"
    ;;
  */defaultSupportedIdpConfigs/microsoft.com)
    printf '%s\\n' false > "$FAKE_MICROSOFT_STATE"
    printf '%s\\n' '{}' > "$output"
    ;;
  *) printf '%s\\n' '{}' > "$output" ;;
esac
`);

  const args = [script, `--target=${options.target ?? "test-west"}`];
  if (options.apply) args.push("--apply", `--confirm=octogee/identity-platform-login-providers/${options.target ?? "test-west"}`);
  const result = spawnSync("bash", args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${temp}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      FAKE_CALL_LOG: log,
      FAKE_EMAIL_PASSWORD: options.emailPassword === false ? "false" : "true",
      FAKE_GITHUB_CLIENT_ID: options.githubClientId ?? "login-github-client",
      FAKE_MICROSOFT: options.microsoft ? "true" : "false",
      FAKE_MICROSOFT_STATE: microsoftState,
      FAKE_MISSING_SECRET: options.missingSecret ?? "",
      FAKE_PROVIDER_RESOURCE_PROJECT: options.providerResourceProject ?? "",
    },
    encoding: "utf8",
  });
  const output = { ...result, calls: readFileSync(log, "utf8").trim().split("\n").filter(Boolean) };
  rmSync(temp, { recursive: true, force: true });
  return output;
}

describe("WEST Identity Platform login provider reconciliation", () => {
  it("is directly executable by the documented operator command", () => {
    expect(statSync(script).mode & 0o111).not.toBe(0);
  });

  it("verifies exactly email/password, Google, and GitHub without printing provider credentials", () => {
    const result = runReconciler();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('"target":"test-west"');
    expect(result.stdout).not.toContain("login-google-client");
    expect(result.stdout).not.toContain("login-github-client");
    expect(result.stdout).not.toContain("login-google-secret");
    expect(result.stdout).not.toContain("login-github-secret");
    expect(result.calls).toEqual([
      expect.stringContaining("GET https://identitytoolkit.googleapis.com/admin/v2/projects/octogee-data-test/config"),
      expect.stringContaining("GET https://identitytoolkit.googleapis.com/admin/v2/projects/octogee-data-test/defaultSupportedIdpConfigs"),
    ]);
  });

  it("fails closed on an email/password drift before considering provider state", () => {
    const result = runReconciler({ emailPassword: false });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("email/password configuration is invalid");
    expect(result.calls).toHaveLength(1);
  });

  it("resolves PROD-WEST to its distinct Firebase data project", () => {
    const result = runReconciler({ target: "prod-west" });

    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toEqual([
      expect.stringContaining("projects/octogee-data-prod/config"),
      expect.stringContaining("projects/octogee-data-prod/defaultSupportedIdpConfigs"),
    ]);
  });

  it("accepts provider resource names canonicalized to the numeric project identifier", () => {
    const result = runReconciler({ providerResourceProject: "842509142281" });

    expect(result.status, result.stderr).toBe(0);
  });

  it("fails loudly when a required login credential is unavailable", () => {
    const result = runReconciler({ missingSecret: "FIREBASE_AUTH_GITHUB_CLIENT_SECRET" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Required Secret Manager value is unavailable");
    expect(result.stderr).not.toContain("login-github-secret");
    expect(result.calls).toEqual([]);
  });

  it("fails verification when the configured GitHub client differs from the dedicated login client", () => {
    const result = runReconciler({ githubClientId: "repository-connection-client" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("GitHub client ID differs from the dedicated login credential");
  });

  it("removes unsupported Microsoft only under explicit confirmed apply, then re-verifies", () => {
    const result = runReconciler({ apply: true, microsoft: true });

    expect(result.status, result.stderr).toBe(0);
    expect(result.calls.filter((call) => call.startsWith("DELETE "))).toEqual([
      expect.stringContaining("defaultSupportedIdpConfigs/microsoft.com"),
    ]);
    expect(result.calls.filter((call) => call.startsWith("GET "))).toHaveLength(4);
    expect(result.stdout).not.toContain("login-github-secret");
  });
});
