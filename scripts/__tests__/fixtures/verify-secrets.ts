import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";

const signing = generateKeyPairSync("ed25519", {
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

export const MATTERMOST_GATEWAY_KEYS = [
  "admin_token", "admin_token_id", "admin_token_fingerprint",
  "team_id", "admin_user", "admin_pass", "admin_user_id",
];

export interface Namespace {
  readonly missing?: readonly string[];
  readonly overrides?: Record<string, Record<string, string>>;
}

export const bootstrapNamespace: Namespace = {
  overrides: { "mattermost-gateway": Object.fromEntries(MATTERMOST_GATEWAY_KEYS.map((key) => [key, ""])) },
};

export function verifySecrets(root: string, namespace: Namespace, ...args: string[]) {
  const dir = mkdtempSync(path.join(tmpdir(), "octogee-verify-secrets-phase-"));
  try {
    const fixture = path.join(dir, "namespace.json");
    writeFileSync(fixture, JSON.stringify({
      missing: namespace.missing ?? [],
      values: {
        "agent-control-router": { secret: signing.privateKey, "public-key": signing.publicKey },
        "byot-sync-internal": { secret: signing.privateKey, "public-key": signing.publicKey },
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
      cwd: root,
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, OCTOGEE_NAMESPACE_FIXTURE: fixture },
      encoding: "utf8",
      timeout: 30_000,
    });
    return { status: result.status, output: stripVTControlCharacters(result.stdout + result.stderr) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
