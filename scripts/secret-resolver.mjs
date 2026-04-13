#!/usr/bin/env node
/**
 * OpenClaw exec SecretRef resolver → GCP Secret Manager.
 *
 * Protocol (docs/gateway/secrets.md):
 *   stdin  → { protocolVersion: 1, provider, ids: ["byok-{slug}-anthropic/latest", ...] }
 *   stdout → { protocolVersion: 1, values: {...}, errors?: {...} }
 *
 * Invocation (from openclaw.json):
 *   {
 *     "secrets": {
 *       "providers": {
 *         "gcp-secret-manager": {
 *           "source": "exec",
 *           "command": "/usr/local/bin/node",
 *           "args": ["/octogee/scripts/secret-resolver.mjs"],
 *           "passEnv": ["GOOGLE_APPLICATION_CREDENTIALS", "GCP_PROJECT_ID"],
 *           "jsonOnly": true
 *         }
 *       }
 *     }
 *   }
 *
 * Auth: uses ADC via Workload Identity on GKE. The gateway pod's
 * ServiceAccount must have roles/secretmanager.secretAccessor on the
 * byok-* secrets (or project-level for simplicity).
 *
 * Logging: stderr only, never stdout. OpenClaw expects `jsonOnly` on
 * stdout; any non-JSON write corrupts the resolution protocol.
 */
import { SecretManagerServiceClient } from "@google-cloud/secret-manager";

const PROJECT_ID = process.env.GCP_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT;
if (!PROJECT_ID) {
  process.stderr.write("[secret-resolver] GCP_PROJECT_ID / GOOGLE_CLOUD_PROJECT not set\n");
  process.stdout.write(
    JSON.stringify({
      protocolVersion: 1,
      values: {},
      errors: { _all: { message: "GCP_PROJECT_ID not set in gateway env" } },
    }) + "\n",
  );
  process.exit(0); // stay within OpenClaw's protocol; errors surface via `errors`
}

const client = new SecretManagerServiceClient();

/** Parse the exec request from stdin (it arrives as one JSON line). */
async function readRequest() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) throw new Error("empty stdin");
  return JSON.parse(raw);
}

/**
 * The id grammar for our BYOT refs is `byok-{slug}-{provider}/{version}`.
 * Strip the `/version` suffix to get the Secret Manager secret name, and
 * treat the suffix as a version reference. "latest" is the default.
 */
function parseId(id) {
  const lastSlash = id.lastIndexOf("/");
  if (lastSlash === -1) return { name: id, version: "latest" };
  return { name: id.slice(0, lastSlash), version: id.slice(lastSlash + 1) };
}

async function resolveOne(id) {
  const { name, version } = parseId(id);
  const fq = `projects/${PROJECT_ID}/secrets/${name}/versions/${version}`;
  const [response] = await client.accessSecretVersion({ name: fq });
  const payload = response.payload?.data;
  if (!payload) throw new Error(`empty payload for ${fq}`);
  return Buffer.isBuffer(payload) ? payload.toString("utf8") : String(payload);
}

async function main() {
  const req = await readRequest();
  const ids = Array.isArray(req.ids) ? req.ids : [];
  const values = {};
  const errors = {};

  // Resolve concurrently — each ref is an independent API call.
  await Promise.all(
    ids.map(async (id) => {
      try {
        values[id] = await resolveOne(id);
      } catch (err) {
        errors[id] = { message: err?.message || String(err) };
      }
    }),
  );

  const response = { protocolVersion: 1, values };
  if (Object.keys(errors).length > 0) response.errors = errors;
  process.stdout.write(JSON.stringify(response) + "\n");
}

main().catch((err) => {
  // Protocol-level failure — write an `errors._all` sentinel so OpenClaw
  // can surface the problem without crashing the resolver loop.
  process.stderr.write(`[secret-resolver] fatal: ${err?.stack || err}\n`);
  process.stdout.write(
    JSON.stringify({
      protocolVersion: 1,
      values: {},
      errors: { _all: { message: err?.message || String(err) } },
    }) + "\n",
  );
  process.exit(0);
});
