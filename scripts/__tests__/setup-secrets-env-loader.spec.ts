import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../..");
const helperPath = path.join(repoRoot, "scripts/lib/shell-env.sh");
const setupSecretsPath = path.join(repoRoot, "scripts/setup-secrets.sh");
const verifySecretsPath = path.join(repoRoot, "scripts/verify-secrets.sh");
const envExamplePath = path.join(repoRoot, ".env.example");

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

function runShell(script: string): string {
  const res = spawnSync("bash", ["-euo", "pipefail", "-c", script], {
    cwd: repoRoot,
    env: process.env,
    encoding: "utf-8",
  });
  if (res.status !== 0) {
    throw new Error(`shell failed:\nstdout=${res.stdout}\nstderr=${res.stderr}`);
  }
  return res.stdout;
}

function saveEnvValue(envFile: string, key: string, value: string): string {
  return runShell([
    `source ${JSON.stringify(helperPath)}`,
    `save_env_file_value ${JSON.stringify(envFile)} ${JSON.stringify(key)} ${JSON.stringify(value)}`,
    `cat ${JSON.stringify(envFile)}`,
  ].join("\n"));
}

function stripePriceMapValidity(value: string): string {
  return runShell([
    `source ${JSON.stringify(helperPath)}`,
    `if validate_stripe_price_ids_json ${JSON.stringify(value)}; then printf valid; else printf invalid; fi`,
  ].join("\n"));
}

describe("setup-secrets env loader", () => {
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

  it("validates Stripe price maps without accepting unknown, empty, or malformed values", () => {
    expect(stripePriceMapValidity('{"personal_monthly":"price_test"}')).toBe("valid");
    expect(stripePriceMapValidity('{"unknown":"price_test"}')).toBe("invalid");
    expect(stripePriceMapValidity('{"personal_monthly":""}')).toBe("invalid");
    expect(stripePriceMapValidity("not-json")).toBe("invalid");
  });

  it("persists resolved Google credentials to the selected env and mirrors TEST to local only", () => {
    const setup = readFileSync(setupSecretsPath, "utf-8");

    expect(setup).toContain('persist_google_env "$ENV_FILE"');
    expect(setup).toContain('[[ "$ENV" == "test" ]] && persist_google_env "$REPO_DIR/.env.local"');
    expect(setup).not.toContain('[[ "$ENV" == "prod" ]] && persist_google_env "$REPO_DIR/.env.local"');
    expect(setup).toContain('configured_secret_value "${GOOGLE_CLIENT_ID:-}"');
    expect(setup).toContain('sync_secret_manager_value GOOGLE_CLIENT_ID "$G_ID" "$FIREBASE_PROJECT"');
    expect(setup).toContain('export GOOGLE_CLIENT_ID="$G_ID"');
  });

  it("captures the Stripe price map durably and verifies all runtime keys", () => {
    const setup = readFileSync(setupSecretsPath, "utf-8");
    const verify = readFileSync(verifySecretsPath, "utf-8");

    expect(setup).toContain('sm_get STRIPE_PRICE_IDS "$FIREBASE_PROJECT"');
    expect(setup).toContain('ksecret_key stripe-secrets price_ids');
    expect(setup).toContain('sync_secret_manager_value STRIPE_PRICE_IDS "$STRIPE_PRICE_IDS" "$FIREBASE_PROJECT"');
    expect(setup).toContain('--from-literal=price_ids="${STRIPE_PRICE_IDS:-{}}"');
    for (const entry of [
      "stripe-secrets:secret_key:",
      "stripe-secrets:webhook_secret:",
      "stripe-secrets:price_ids:",
      "google-oauth:client_id:",
      "google-oauth:client_secret:",
      "google-oauth:picker_api_key:",
      "google-oauth:picker_app_id:",
      "connect-state-secret:secret:",
    ]) {
      expect(verify).toContain(entry);
    }
  });

  it("documents all server-only Google OAuth values as blank placeholders", () => {
    const example = readFileSync(envExamplePath, "utf-8");

    for (const key of [
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
      "GOOGLE_PICKER_API_KEY",
      "GOOGLE_PICKER_APP_ID",
    ]) {
      expect(example).toContain(`${key}=\n`);
    }
  });
});
