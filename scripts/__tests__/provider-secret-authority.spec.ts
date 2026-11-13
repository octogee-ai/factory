import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TEST_TARGET } from "./fixtures/deployment.js";
import {
  describeProviderSecretAuthority,
  SECTION_END,
  setupSecretsFunction,
  setupSecretsSource,
} from "./fixtures/provider-secret-authority.js";

const root = path.resolve(__dirname, "../..");

describeProviderSecretAuthority([
  { name: "Anthropic", section: "octogee-anthropic", variable: "ANTHROPIC_API_KEY", field: "api_key", central: false, source: setupSecretsSource, end: SECTION_END },
  { name: "OpenRouter", section: "octogee-openrouter", variable: "OPENROUTER_API_KEY", field: "api_key", central: false, source: setupSecretsSource, end: SECTION_END },
  { name: "Brave", section: "octogee-brave", variable: "BRAVE_API_KEY", field: "key", central: true, source: setupSecretsSource, end: SECTION_END },
]);

function materializeOAuth(input: { state: "present" | "absent"; envValue?: string; k8sValue?: string }) {
  const script = [
    'source "$SHELL_ENV_HELPER"',
    'source "$COMPLETENESS_HELPER"',
    setupSecretsFunction("read_authoritative_secret_manager_value"),
    setupSecretsFunction("resolve_environment_secret_value"),
    setupSecretsFunction("oauth_secret"),
    'info() { :; }; warn() { :; }; fail() { printf "%s\\n" "$*" >&2; exit 1; }',
    'secret_manager_secret_state() { [[ "$2" == "$FAKE_EXPECTED_PROJECT" ]] || { printf absent; return 0; }; printf "%s" "$FAKE_SM_STATE"; }',
    'gcloud() { [[ " $* " == *" --project=$FAKE_EXPECTED_PROJECT "* ]] || return 1; printf "%s-%s" "$FAKE_SM_VALUE" "${*: -2:1}"; }',
    'sm_get() { [[ "${2:-$SM_PROJECT}" == "$FAKE_EXPECTED_PROJECT" ]] || return 1; printf "%s" "$FAKE_SM_VALUE"; }',
    'ksecret_key() { printf "%s" "$FAKE_K8S_VALUE"; }',
    'ksecret() { printf "KSECRET %s\\n" "$*"; }',
    "oauth_secret github github-oauth GITHUB_CLIENT_ID GITHUB_CLIENT_SECRET",
  ].join("\n");
  return spawnSync("bash", ["-euo", "pipefail", "-c", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      ENV: "test",
      ENV_FILE: "/unused-oauth-test.env",
      TARGET_ID: "test-central",
      FIREBASE_PROJECT: TEST_TARGET.firebaseProjectId,
      SM_PROJECT: "octogee",
      SHELL_ENV_HELPER: path.join(root, "scripts/lib/shell-env.sh"),
      COMPLETENESS_HELPER: path.join(root, "scripts/lib/secret-completeness.sh"),
      FAKE_SM_STATE: input.state,
      FAKE_EXPECTED_PROJECT: TEST_TARGET.firebaseProjectId,
      FAKE_SM_VALUE: input.state === "absent" ? "" : "managed",
      FAKE_K8S_VALUE: input.k8sValue ?? "",
      GITHUB_CLIENT_ID: input.envValue ?? "",
      GITHUB_CLIENT_SECRET: input.envValue ?? "",
    },
  });
}

describe("GitHub OAuth setup credential authority", () => {
  it("reads the pair from the environment's own Secret Manager project, not the Cloud SQL project", () => {
    const result = materializeOAuth({ state: "present" });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("KSECRET github-oauth");
    expect(result.stdout).not.toContain("--from-literal=client_id= ");
    expect(result.stdout).toMatch(/--from-literal=client_id=managed\S*/);
  });

  it("keeps the namespace's existing pair when neither Secret Manager nor the env file has one", () => {
    const result = materializeOAuth({ state: "absent", k8sValue: "namespace-value" });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("--from-literal=client_id=namespace-value");
    expect(result.stdout).toContain("--from-literal=client_secret=namespace-value");
  });

  it("fails instead of writing an empty secret when no source has the pair", () => {
    const result = materializeOAuth({ state: "absent" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are required for test-central");
    expect(result.stdout).not.toContain("KSECRET");
  });
});
