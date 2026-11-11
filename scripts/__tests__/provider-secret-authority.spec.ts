import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TEST_TARGET } from "./fixtures/deployment.js";

const root = path.resolve(__dirname, "../..");
const setup = readFileSync(path.join(root, "scripts/setup-secrets.sh"), "utf8");
const providers = [
  { name: "Anthropic", section: "octogee-anthropic", variable: "ANTHROPIC_API_KEY", field: "api_key", central: false },
  { name: "OpenRouter", section: "octogee-openrouter", variable: "OPENROUTER_API_KEY", field: "api_key", central: false },
  { name: "Brave", section: "octogee-brave", variable: "BRAVE_API_KEY", field: "key", central: true },
  { name: "Resend", section: "resend-secrets", variable: "RESEND_API_KEY", field: "api_key", central: false },
];

function shellFunction(name: string): string {
  const start = setup.indexOf(`\n${name}() {\n`);
  if (start < 0) throw new Error(`Missing shell function ${name}`);
  return setup.slice(start + 1, setup.indexOf("\n}\n", start) + 3);
}

function materialize(provider: typeof providers[number], environment: string, state = "present") {
  const start = setup.indexOf(`info "${provider.section}"`);
  if (start < 0) throw new Error(`Missing provider section ${provider.section}`);
  const block = setup.slice(start, setup.indexOf("\n# ──", start));
  const script = [
    'source "$SHELL_ENV_HELPER"',
    shellFunction("read_authoritative_secret_manager_value"),
    shellFunction("resolve_environment_secret_value"),
    'info() { :; }; warn() { :; }; fail() { printf "%s\\n" "$*" >&2; exit 1; }',
    'secret_manager_secret_state() { printf "%s" "$FAKE_SM_STATE"; }',
    'gcloud() { [[ " $* " == *" --project=$FAKE_EXPECTED_PROJECT "* ]] || return 1; printf "%s" "$FAKE_SM_VALUE"; }',
    'sm_get() { printf "%s" "$FAKE_SM_VALUE"; }',
    'ksecret_key() { printf "%s" "$FAKE_K8S_VALUE"; }',
    'ksecret() { printf "%s\\n" "$@"; }',
    'sync_secret_manager_value() { printf "PERSIST:%s:%s:%s\\n" "$1" "$2" "$3"; }',
    'save_env_file_value() { printf "CACHE:%s:%s\\n" "$2" "$3"; }',
    block,
  ].join("\n");
  return spawnSync("bash", ["-euo", "pipefail", "-c", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      ENV: environment,
      ENV_FILE: "/unused-provider-test.env",
      RESEND_FROM_EMAIL: "demo@example.test",
      RESEND_FROM_NAME: "Demo",
      RESEND_WEBHOOK_SECRET: "fixture-webhook",
      EMAIL_UNSUBSCRIBE_SECRET: "fixture-unsubscribe",
      FIREBASE_PROJECT: environment === "prod" ? "octogee" : TEST_TARGET.firebaseProjectId,
      SHELL_ENV_HELPER: path.join(root, "scripts/lib/shell-env.sh"),
      FAKE_SM_STATE: state,
      FAKE_EXPECTED_PROJECT: provider.central || environment === "prod" ? "octogee" : TEST_TARGET.firebaseProjectId,
      FAKE_SM_VALUE: state === "absent" ? "" : "rotated-provider-value",
      FAKE_K8S_VALUE: "namespace-provider-value",
      [provider.variable]: "retired-local-value",
    },
  });
}

describe.each(providers)("$name setup credential authority", (provider) => {
  it.each(["test", "prod"])("uses the rotated managed value over a stale %s env file", (environment) => {
    const result = materialize(provider, environment);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`--from-literal=${provider.field}=rotated-provider-value`);
    expect(result.stdout).not.toContain("retired-local-value");
    const project = provider.central || environment === "prod" ? "octogee" : TEST_TARGET.firebaseProjectId;
    expect(result.stdout).toContain(`PERSIST:${provider.variable}:rotated-provider-value:${project}`);
    expect(result.stdout).toContain(`CACHE:${provider.variable}:rotated-provider-value`);
  });

  it("retains a disposable namespace credential without overwriting shared secrets", () => {
    const result = materialize(provider, "custom");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`--from-literal=${provider.field}=namespace-provider-value`);
    expect(result.stdout).not.toContain("PERSIST:");
  });

  it("fails before materialization when managed-secret access cannot be established", () => {
    const result = materialize(provider, "test", "error");
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain(`--from-literal=${provider.field}=`);
  });

  it("persists the bootstrap credential only after confirmed managed-secret absence", () => {
    const result = materialize(provider, "test", "absent");
    expect(result.status, result.stderr).toBe(0);
    const project = provider.central ? "octogee" : TEST_TARGET.firebaseProjectId;
    expect(result.stdout).toContain(`--from-literal=${provider.field}=retired-local-value`);
    expect(result.stdout).toContain(`PERSIST:${provider.variable}:retired-local-value:${project}`);
  });
});

function materializeOAuth(input: { state: "present" | "absent"; envValue?: string; k8sValue?: string }) {
  const script = [
    'source "$SHELL_ENV_HELPER"',
    'source "$COMPLETENESS_HELPER"',
    shellFunction("read_authoritative_secret_manager_value"),
    shellFunction("resolve_environment_secret_value"),
    shellFunction("oauth_secret"),
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
