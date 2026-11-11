import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const signing = generateKeyPairSync("ed25519", {
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const priceIds = JSON.stringify(Object.fromEntries([
  "personal_monthly", "personal_pro_monthly", "personal_pro_max_monthly",
  "builder_hobby_monthly", "builder_pro_monthly", "builder_team_monthly",
  "credit_10", "credit_25", "credit_50", "credit_100",
].map((name, index) => [name, `price_${index}`])));
const MATTERMOST_GATEWAY_KEYS = [
  "admin_token", "admin_token_id", "admin_token_fingerprint",
  "team_id", "admin_user", "admin_pass", "admin_user_id",
];

interface Namespace {
  readonly missing?: readonly string[];
  readonly overrides?: Record<string, Record<string, string>>;
}

const bootstrapNamespace: Namespace = {
  overrides: { "mattermost-gateway": Object.fromEntries(MATTERMOST_GATEWAY_KEYS.map((key) => [key, ""])) },
};

function verifySecrets(namespace: Namespace, ...args: string[]) {
  const dir = mkdtempSync(path.join(tmpdir(), "octogee-verify-secrets-phase-"));
  try {
    const fixture = path.join(dir, "namespace.json");
    writeFileSync(fixture, JSON.stringify({
      missing: namespace.missing ?? [],
      values: {
        "agent-control-router": { secret: signing.privateKey, "public-key": signing.publicKey },
        "byot-sync-internal": { secret: signing.privateKey, "public-key": signing.publicKey },
        "stripe-secrets": { secret_key: "sk_test_fixture", webhook_secret: "whsec_fixture", price_ids: priceIds },
        "mattermost-cloud-sql": { password: "fixture-db-password" },
        ...namespace.overrides,
      },
    }), { mode: 0o600 });
    writeFileSync(path.join(dir, "kubectl"), `#!/usr/bin/env node
const { readFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args[0] !== "get" || args[1] !== "secret") process.exit(2);
const fixture = JSON.parse(readFileSync(process.env.OCTOGEE_NAMESPACE_FIXTURE, "utf8"));
if (fixture.missing.includes(args[2])) process.exit(1);
const query = args.find((arg) => arg.startsWith("jsonpath="));
if (!query) process.exit(0);
const key = /^jsonpath=\\{\\.data\\.(.+)\\}$/.exec(query)?.[1];
if (!key) process.exit(2);
const value = fixture.values[args[2]]?.[key] ?? "fixture-configured-value";
process.stdout.write(Buffer.from(value).toString("base64"));
`, { mode: 0o700 });
    writeFileSync(path.join(dir, "gcloud"), `#!/usr/bin/env bash
[[ "$1 $2 $3" == "secrets versions access" ]] || exit 2
printf 'fixture-db-password'
`, { mode: 0o700 });
    const result = spawnSync("bash", ["scripts/verify-secrets.sh", "--env=test", "--deployment-target=test-central", ...args], {
      cwd: repoRoot,
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, OCTOGEE_NAMESPACE_FIXTURE: fixture },
      encoding: "utf8",
      timeout: 30_000,
    });
    return { status: result.status, output: stripVTControlCharacters(result.stdout + result.stderr) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("verify-secrets phases", () => {
  it("accepts a fresh namespace before Helm while setup-mattermost has yet to fill mattermost-gateway", () => {
    const { status, output } = verifySecrets(bootstrapNamespace, "--phase=bootstrap");

    expect(status, output).toBe(0);
    for (const key of MATTERMOST_GATEWAY_KEYS) {
      expect(output).toContain(`mattermost-gateway/${key} — skipped (set by setup-mattermost.sh after Helm)`);
    }
  });

  it("still requires the mattermost-gateway shell to exist before Helm", () => {
    const { status, output } = verifySecrets({ missing: ["mattermost-gateway"] }, "--phase=bootstrap");

    expect(status).toBe(1);
    expect(output).toContain("mattermost-gateway — MISSING");
  });

  it("still fails before Helm on a blank value setup-secrets owns", () => {
    const { status, output } = verifySecrets({
      overrides: { ...bootstrapNamespace.overrides, "octogee-openrouter": { api_key: "" } },
    }, "--phase=bootstrap");

    expect(status).toBe(1);
    expect(output).toContain("octogee-openrouter/api_key — EMPTY");
  });

  it.each([
    { phase: "the default phase", args: [] },
    { phase: "--phase=launch", args: ["--phase=launch"] },
  ])("demands every mattermost-gateway value under $phase", ({ args }) => {
    const { status, output } = verifySecrets(bootstrapNamespace, ...args);

    expect(status).toBe(1);
    for (const key of MATTERMOST_GATEWAY_KEYS) {
      expect(output).toContain(`mattermost-gateway/${key} — EMPTY`);
    }
    expect(output).toContain(`${MATTERMOST_GATEWAY_KEYS.length} issue(s) found`);
  });

  it("requires the Stripe secret registered by the product secret extension", () => {
    const { status, output } = verifySecrets({ missing: ["stripe-secrets"] });

    expect(status).toBe(1);
    expect(output).toContain("stripe-secrets — MISSING");
  });

  it("rejects Stripe values the product secret extension validates", () => {
    const { status, output } = verifySecrets({
      overrides: {
        "stripe-secrets": { secret_key: "sk_live_fixture", webhook_secret: "not-a-webhook-secret", price_ids: priceIds },
      },
    });

    expect(status).toBe(1);
    expect(output).toContain("stripe-secrets/secret_key — INVALID MODE");
    expect(output).toContain("stripe-secrets/webhook_secret — INVALID");
    expect(output).toContain("stripe-secrets/price_ids");
    expect(output).not.toContain("stripe-secrets/price_ids — INVALID");
  });

  it("requires PostHog Cloud keys on TEST through the product secret extension", () => {
    const { status, output } = verifySecrets({
      overrides: { "posthog-cloud": { project_token: "", personal_api_key: "phx_fixture" } },
    });

    expect(status).toBe(1);
    expect(output).toContain("posthog-cloud/project_token — EMPTY");
  });

  it("rejects an unknown phase", () => {
    const { status, output } = verifySecrets(bootstrapNamespace, "--phase=preflight");

    expect(status).toBe(1);
    expect(output).toContain("--phase must be bootstrap or launch");
  });
});
