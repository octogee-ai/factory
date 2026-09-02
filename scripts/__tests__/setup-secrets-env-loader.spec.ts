import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../..");
const helperPath = path.join(repoRoot, "scripts/lib/shell-env.sh");
const setupSecretsPath = path.join(repoRoot, "scripts/setup-secrets.sh");
const verifySecretsPath = path.join(repoRoot, "scripts/verify-secrets.sh");
const envExamplePath = path.join(repoRoot, ".env.example");
const completeStripePriceMap = JSON.stringify(Object.fromEntries([
  "personal_monthly",
  "personal_annual",
  "personal_pro_monthly",
  "personal_pro_annual",
  "personal_pro_max_monthly",
  "personal_pro_max_annual",
  "builder_hobby_monthly",
  "builder_hobby_annual",
  "builder_pro_monthly",
  "builder_pro_annual",
  "builder_team_monthly",
  "builder_team_annual",
  "credit_10",
  "credit_25",
  "credit_50",
  "credit_100",
].map((key) => [key, `price_${key.replaceAll("_", "")}`])));
const canonicalStripePriceMap = JSON.stringify(Object.fromEntries(
  Object.entries(JSON.parse(completeStripePriceMap)).sort(([left], [right]) => left.localeCompare(right)),
));

function runLoader(envFile: string, env: Record<string, string> = {}): string {
  const script = [
    `source ${JSON.stringify(helperPath)}`,
    `load_env_file ${JSON.stringify(envFile)}`,
    `printf '%s\\n' "$RESEND_FROM_EMAIL" "$RESEND_FROM_NAME" "$UNQUOTED_VALUE"`,
  ].join("\n");
  const res = spawnSync("bash", ["-euo", "pipefail", "-c", script], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: "utf-8",
  });
  if (res.status !== 0) {
    throw new Error(`loader failed:\nstdout=${res.stdout}\nstderr=${res.stderr}`);
  }
  return res.stdout;
}

function runShell(script: string, env: Record<string, string> = {}): string {
  const res = spawnSync("bash", ["-euo", "pipefail", "-c", script], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: "utf-8",
  });
  if (res.status !== 0) {
    throw new Error(`shell failed:\nstdout=${res.stdout}\nstderr=${res.stderr}`);
  }
  return res.stdout;
}

function secretManagerState(mode: "present" | "absent" | "error"): string {
  const dir = mkdtempSync(path.join(tmpdir(), "octogee-secret-manager-state-"));
  const gcloud = path.join(dir, "gcloud");
  writeFileSync(gcloud, [
    "#!/usr/bin/env bash",
    "[[ \"$*\" == *\"secrets list\"* ]] || exit 1",
    "case \"$FAKE_GCLOUD_MODE\" in",
    "  present) printf 'GOOGLE_CLIENT_ID\\n' ;;",
    "  absent) exit 0 ;;",
    "  error) exit 1 ;;",
    "esac",
  ].join("\n"));
  chmodSync(gcloud, 0o755);

  return runShell([
    `source ${JSON.stringify(helperPath)}`,
    "secret_manager_secret_state GOOGLE_CLIENT_ID octogee-test",
  ].join("\n"), {
    FAKE_GCLOUD_MODE: mode,
    PATH: `${dir}:${process.env.PATH}`,
  });
}

function runShellStatus(script: string, env: Record<string, string> = {}): number | null {
  return spawnSync("bash", ["-euo", "pipefail", "-c", script], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: "utf-8",
  }).status;
}

function saveEnvValue(envFile: string, key: string, value: string): string {
  return runShell([
    `source ${JSON.stringify(helperPath)}`,
    `save_env_file_value ${JSON.stringify(envFile)} ${JSON.stringify(key)} ${JSON.stringify(value)}`,
    `cat ${JSON.stringify(envFile)}`,
  ].join("\n"));
}

function readEnvValue(envFile: string, key: string): string {
  return runShell([
    `source ${JSON.stringify(helperPath)}`,
    `read_env_file_value ${JSON.stringify(envFile)} ${JSON.stringify(key)}`,
  ].join("\n"));
}

function stripePriceMapValidity(value: string): string {
  return runShell([
    `source ${JSON.stringify(helperPath)}`,
    `if validate_stripe_price_ids_json ${JSON.stringify(value)}; then printf valid; else printf invalid; fi`,
  ].join("\n"));
}

function materializedStripePriceMap(value: string): string {
  return runShell([
    `source ${JSON.stringify(helperPath)}`,
    `materialize_stripe_price_ids_json ${JSON.stringify(value)}`,
  ].join("\n"));
}

function configuredStripePriceMap(value: string): string {
  return runShell([
    `source ${JSON.stringify(helperPath)}`,
    `configured_stripe_price_ids_value ${JSON.stringify(value)}`,
  ].join("\n"));
}

function canonicalizedStripePriceMap(value: string): string {
  return runShell([
    `source ${JSON.stringify(helperPath)}`,
    'canonicalize_stripe_price_ids_json "$STRIPE_PRICE_MAP"',
  ].join("\n"), { STRIPE_PRICE_MAP: value });
}

function stripeKeyModeValidity(env: string, value: string): string {
  return runShell([
    `source ${JSON.stringify(helperPath)}`,
    `if validate_stripe_secret_key_mode ${JSON.stringify(env)} ${JSON.stringify(value)}; then printf valid; else printf invalid; fi`,
  ].join("\n"));
}

function posthogCloudRequired(env: string): boolean {
  return runShellStatus([
    `source ${JSON.stringify(helperPath)}`,
    `posthog_cloud_required_for_env ${JSON.stringify(env)}`,
  ].join("\n")) === 0;
}

function stripeWebhookValidity(value: string): string {
  return runShell([
    `source ${JSON.stringify(helperPath)}`,
    `if validate_stripe_webhook_secret ${JSON.stringify(value)}; then printf valid; else printf invalid; fi`,
  ].join("\n"));
}

function selectedSecretValue(
  env: string,
  secretManager: string,
  envFile: string,
  kubernetes: string,
): string {
  return runShell([
    `source ${JSON.stringify(helperPath)}`,
    `select_environment_secret_value ${JSON.stringify(env)} ${JSON.stringify(secretManager)} ${JSON.stringify(envFile)} ${JSON.stringify(kubernetes)}`,
  ].join("\n"));
}

describe("setup-secrets env loader", () => {
  it("requires PostHog Cloud credentials exactly where Helm enables PostHog", () => {
    expect(posthogCloudRequired("test")).toBe(true);
    expect(posthogCloudRequired("prod")).toBe(true);
    expect(posthogCloudRequired("custom")).toBe(false);
  });

  it("reads one named env value without exporting unrelated secrets", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "octogee-env-reader-"));
    const envFile = path.join(dir, ".env.test-west");
    writeFileSync(envFile, [
      "UNRELATED_SECRET=do-not-export",
      'MM_TEAM_ID="team-id"',
      "",
    ].join("\n"));

    expect(readEnvValue(envFile, "MM_TEAM_ID")).toBe("team-id");
  });

  it("rejects duplicate named env values", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "octogee-env-reader-"));
    const envFile = path.join(dir, ".env.test-west");
    writeFileSync(envFile, "MM_TEAM_ID=first\nMM_TEAM_ID=second\n");

    expect(runShellStatus([
      `source ${JSON.stringify(helperPath)}`,
      `read_env_file_value ${JSON.stringify(envFile)} MM_TEAM_ID`,
    ].join("\n"))).not.toBe(0);
  });

  it("removes surrounding .env quotes before values are materialized into Kubernetes secrets", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "octogee-env-loader-"));
    const envFile = path.join(dir, ".env.test");
    writeFileSync(
      envFile,
      [
        `RESEND_FROM_EMAIL="notifications@octogee.com"`,
        `RESEND_FROM_NAME="Octogee"`,
        `UNQUOTED_VALUE=plain`,
      ].join("\n"),
    );

    expect(runLoader(envFile)).toBe("notifications@octogee.com\nOctogee\nplain\n");
  });

  it("preserves already-exported values when the .env file contains a blank assignment", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "octogee-env-loader-"));
    const envFile = path.join(dir, ".env.test");
    writeFileSync(
      envFile,
      [
        `RESEND_FROM_EMAIL=`,
        `RESEND_FROM_NAME=""`,
        `UNQUOTED_VALUE=plain`,
      ].join("\n"),
    );

    expect(
      runLoader(envFile, {
        RESEND_FROM_EMAIL: "existing@example.com",
        RESEND_FROM_NAME: "Existing Sender",
      }),
    ).toBe("existing@example.com\nExisting Sender\nplain\n");
  });

  it("atomically replaces duplicate keys while preserving unrelated env values", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "octogee-env-save-"));
    const envFile = path.join(dir, ".env.test");
    writeFileSync(envFile, "UNCHANGED=keep\nGOOGLE_CLIENT_ID=old\nGOOGLE_CLIENT_ID=stale\n");

    expect(saveEnvValue(envFile, "GOOGLE_CLIENT_ID", "new-client-id")).toBe(
      "UNCHANGED=keep\nGOOGLE_CLIENT_ID=new-client-id\n",
    );
  });

  it("does not replace an env file when its existing contents cannot be read", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "octogee-env-save-failure-"));
    const envFile = path.join(dir, ".env.test");
    const binDir = path.join(dir, "bin");
    const failingAwk = path.join(binDir, "awk");
    mkdirSync(binDir);
    writeFileSync(failingAwk, "#!/usr/bin/env bash\nexit 2\n");
    chmodSync(failingAwk, 0o755);
    writeFileSync(envFile, "UNCHANGED=keep\n");

    const status = runShellStatus([
      `source ${JSON.stringify(helperPath)}`,
      `save_env_file_value ${JSON.stringify(envFile)} GOOGLE_CLIENT_ID new-client-id`,
    ].join("\n"), { PATH: `${binDir}:${process.env.PATH}` });

    expect(status).not.toBe(0);
    expect(readFileSync(envFile, "utf-8")).toBe("UNCHANGED=keep\n");
  });

  it("validates Stripe price maps without accepting unknown, empty, or malformed values", () => {
    expect(stripePriceMapValidity(completeStripePriceMap)).toBe("valid");
    expect(stripePriceMapValidity('{"personal_monthly":"price_test"}')).toBe("invalid");
    expect(stripePriceMapValidity('{"unknown":"price_test"}')).toBe("invalid");
    expect(stripePriceMapValidity('{"personal_monthly":""}')).toBe("invalid");
    expect(stripePriceMapValidity("not-json")).toBe("invalid");
  });

  it("materializes a configured Stripe map byte-for-byte and defaults only an empty map", () => {
    const configured = completeStripePriceMap;
    const pretty = JSON.stringify(JSON.parse(completeStripePriceMap), null, 2);
    const reversed = JSON.stringify(Object.fromEntries(
      Object.entries(JSON.parse(completeStripePriceMap)).reverse(),
    ));

    expect(materializedStripePriceMap(configured)).toBe(configured);
    expect(materializedStripePriceMap("")).toBe("{}");
    expect(configuredStripePriceMap("{}")).toBe("");
    expect(configuredStripePriceMap(configured)).toBe(configured);
    expect(canonicalizedStripePriceMap(pretty)).toBe(canonicalStripePriceMap);
    expect(canonicalizedStripePriceMap(reversed)).toBe(canonicalStripePriceMap);
  });

  it("rejects Stripe secret keys from the wrong environment mode", () => {
    expect(stripeKeyModeValidity("test", "sk_test_example")).toBe("valid");
    expect(stripeKeyModeValidity("custom", "sk_test_example")).toBe("valid");
    expect(stripeKeyModeValidity("prod", "sk_live_example")).toBe("valid");
    expect(stripeKeyModeValidity("test", "sk_live_example")).toBe("invalid");
    expect(stripeKeyModeValidity("prod", "sk_test_example")).toBe("invalid");
    expect(stripeKeyModeValidity("test", "sk_test_")).toBe("invalid");
    expect(stripeWebhookValidity("whsec_example")).toBe("valid");
    expect(stripeWebhookValidity("whsec_")).toBe("invalid");
    expect(stripeWebhookValidity("placeholder")).toBe("invalid");
    expect(stripeWebhookValidity("PLACEHOLDER-WEBHOOK")).toBe("invalid");
  });

  it("keeps Secret Manager authoritative while custom namespaces prefer their local K8s state", () => {
    expect(selectedSecretValue("test", "from-sm", "from-env", "from-k8s")).toBe("from-sm");
    expect(selectedSecretValue("prod", "from-sm", "from-env", "from-k8s")).toBe("from-sm");
    expect(selectedSecretValue("test", "", "from-env", "from-k8s")).toBe("from-env");
    expect(selectedSecretValue("custom", "from-sm", "from-env", "from-k8s")).toBe("from-k8s");
    expect(selectedSecretValue("custom", "from-sm", "from-env", "")).toBe("from-sm");
  });

  it("distinguishes confirmed Secret Manager absence from access failures", () => {
    expect(secretManagerState("present")).toBe("present");
    expect(secretManagerState("absent")).toBe("absent");
    expect(secretManagerState("error")).toBe("error");
  });

  it("persists resolved Google credentials to the selected env and mirrors TEST to local only", () => {
    const setup = readFileSync(setupSecretsPath, "utf-8");

    expect(setup).toContain('persist_google_env "$ENV_FILE"');
    expect(setup).toContain('[[ "$ENV" == "test" ]] && persist_google_env "$REPO_DIR/.env.local"');
    expect(setup).not.toContain('[[ "$ENV" == "prod" ]] && persist_google_env "$REPO_DIR/.env.local"');
    expect(setup).toContain('resolve_environment_secret_value "${GOOGLE_CLIENT_ID:-}" GOOGLE_CLIENT_ID google-oauth client_id configured_secret_value');
    expect(setup).toContain('resolve_environment_secret_value "${GOOGLE_PICKER_CLIENT_ID:-}" GOOGLE_PICKER_CLIENT_ID google-oauth picker_client_id configured_secret_value');
    expect(setup).toContain('sync_secret_manager_value GOOGLE_CLIENT_ID "$G_ID" "$FIREBASE_PROJECT"');
    expect(setup).toContain('sync_secret_manager_value GOOGLE_PICKER_CLIENT_ID "$G_PICKER_ID" "$FIREBASE_PROJECT"');
    expect(setup).toContain("select_environment_secret_value");
    expect(setup).toContain('"$ENV" "$secret_manager_value" "$env_value" "$kubernetes_value"');
    expect(setup).toContain('export GOOGLE_CLIENT_ID="$G_ID"');
  });

  it("materializes dedicated WEST login provider credentials into the target data project", () => {
    const setup = readFileSync(setupSecretsPath, "utf-8");
    const example = readFileSync(envExamplePath, "utf-8");

    for (const key of [
      "FIREBASE_AUTH_GOOGLE_CLIENT_ID",
      "FIREBASE_AUTH_GOOGLE_CLIENT_SECRET",
      "FIREBASE_AUTH_GITHUB_CLIENT_ID",
      "FIREBASE_AUTH_GITHUB_CLIENT_SECRET",
    ]) {
      expect(setup).toContain(
        `resolve_environment_secret_value "\${${key}:-}" ${key} identity-platform-login ${key} configured_secret_value`,
      );
      expect(setup).toContain(`sync_secret_manager_value ${key} "$${key}" "$FIREBASE_PROJECT"`);
      expect(example).toContain(`${key}=\n`);
    }
    expect(setup).toContain('case "$TARGET_ID" in');
    expect(setup).toContain("test-west|prod-west)");
  });

  it("captures the Stripe price map durably and verifies all runtime keys", () => {
    const setup = readFileSync(setupSecretsPath, "utf-8");
    const verify = readFileSync(verifySecretsPath, "utf-8");
    const managedSecretSync = setup.slice(
      setup.indexOf("sync_secret_manager_value()"),
      setup.indexOf("read_authoritative_secret_manager_value()"),
    );

    expect(setup).toContain('resolve_environment_secret_value "${STRIPE_PRICE_IDS:-}" STRIPE_PRICE_IDS stripe-secrets price_ids configured_stripe_price_ids_value');
    expect(setup).toContain('sync_secret_manager_value STRIPE_PRICE_IDS "$STRIPE_PRICE_IDS" "$FIREBASE_PROJECT"');
    expect(setup).toContain('--from-literal=price_ids="$STRIPE_PRICE_IDS_MATERIALIZED"');
    expect(setup).toContain('[[ "$ENV" != "custom" ]]');
    expect(setup).toContain("Secret Manager is authoritative for $name; rotate it there before running setup-secrets.sh");
    expect(managedSecretSync).not.toContain('gcloud secrets versions add "$name"');
    expect(verify).toContain('validate_stripe_secret_key_mode "$ENV" "$VALUE"');
    expect(verify).toContain('validate_stripe_webhook_secret "$VALUE"');
    for (const entry of [
      "stripe-secrets:secret_key:",
      "stripe-secrets:webhook_secret:",
      "stripe-secrets:price_ids:",
      "google-oauth:client_id:",
      "google-oauth:client_secret:",
      "google-oauth:picker_client_id:",
      "google-oauth:picker_api_key:",
      "google-oauth:picker_app_id:",
      "connect-state-secret:secret:",
    ]) {
      expect(verify).toContain(entry);
    }
  });

  it("captures the Ops Agent bearer in the selected environment file", () => {
    const setup = readFileSync(setupSecretsPath, "utf-8");

    expect(setup).toContain('configured_secret_value "${OPS_AGENT_BEARER_TOKEN:-}"');
    expect(setup).toContain('save_env_file_value "$ENV_FILE" OPS_AGENT_BEARER_TOKEN "$OPS_AGENT_BEARER_TOKEN"');
  });

  it("materializes the complete shared gateway auth-secret set", () => {
    const setup = readFileSync(setupSecretsPath, "utf-8");

    expect(setup).toContain('GATEWAY_IDS=("shared-a" "shared-b" "shared-c" "shared-d")');
  });

  it("syncs only Cloud Functions secrets that remain consumed", () => {
    const setup = readFileSync(setupSecretsPath, "utf-8");

    expect(setup).toContain("function_secret_value()");
    expect(setup).toContain('SOCIAL_NOTIFICATION_BEARER_TOKEN) configured_secret_value "${SOCIAL_NOTIFICATION_BEARER:-}"');
    expect(setup).toContain("DISCORD_OPS_WEBHOOK_URL");
    expect(setup).toContain('sync_function_secret "$sm_secret" "$function_value"');
    expect(setup).toContain('secret_manager_persist_value "$secret" "$configured" "$SM_PROJECT_CF"');
    for (const staleSecret of [
      "GITEA_TOKEN",
      "STRIPE_SECRET_KEY",
      "STRIPE_WEBHOOK_SECRET",
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
      "MICROSOFT_CLIENT_ID",
      "MICROSOFT_CLIENT_SECRET",
      "DISCORD_MAC_TOKEN",
      "DISCORD_COACH_TOKEN",
      "DISCORD_BOT_APP_ID",
      "DISCORD_CLIENT_SECRET",
      "ANTHROPIC_API_KEY",
      "OCTOGEE_GUILD_ID",
      "RESEND_API_KEY",
      "RESEND_FROM_EMAIL",
    ]) {
      expect(setup).not.toContain(`  ${staleSecret} \\\\`);
    }
  });

  it("documents all server-only Google OAuth values as blank placeholders", () => {
    const example = readFileSync(envExamplePath, "utf-8");

    for (const key of [
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
      "GOOGLE_PICKER_CLIENT_ID",
      "GOOGLE_PICKER_API_KEY",
      "GOOGLE_PICKER_APP_ID",
    ]) {
      expect(example).toContain(`${key}=\n`);
    }
  });
});
