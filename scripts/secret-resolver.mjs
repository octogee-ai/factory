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
 *
 * ── Defense-in-depth ──────────────────────────────────────────────────────
 *
 * The OpenClaw exec protocol does NOT pass requesting-agent context to the
 * resolver (verified against fork src/secrets/resolve.ts:682-705 — only
 * `passEnv` allowlist + the `ids` array reach us). True per-call agent
 * identity enforcement requires a fork patch and is tracked as a separate
 * security follow-up.
 *
 * What we CAN do in-resolver, applied below:
 *   1. Strict id grammar — reject anything that isn't `byok-{slug}-{provider}`
 *      with a known provider and a sane slug.
 *   2. Known-slug allowlist — only resolve for slugs that have a
 *      corresponding agent dir on disk. Stops "let me try slug=admin".
 *   3. Audit log — every accepted/rejected id goes to stderr with id +
 *      outcome so we have a forensic trail. Cloud Logging captures stderr.
 */
import * as fs from "fs";
import * as path from "path";
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

const AGENTS_DIR =
  process.env.OPENCLAW_AGENTS_DIR ||
  path.join(process.env.HOME || "/home/node", ".openclaw", "agents");

/** byok-{slug}-{provider}[/version]. Slug is lowercase alnum + hyphens, 1-63
 *  chars. Provider is a closed enum. Version is "latest" or a 1-32 char
 *  alnum/hyphen string (Secret Manager versions are integers but `latest`
 *  + future labels are also valid). */
// Provider enum must stay in sync with the api_key providers in
// scripts/lib byot-multi-provider-config PROVIDERS and gateway-edge
// provider-key-format SUPPORTED — asserted by the registry-parity spec.
const BYOK_ID_RE =
  /^byok-(?<slug>[a-z0-9][a-z0-9-]{0,62})-(?<provider>anthropic|openai|openai-compatible|grok|openrouter|minimax)(?:\/(?<version>[a-zA-Z0-9-]{1,32}))?$/;

/** Scan AGENTS_DIR once at startup for the set of provisioned slugs. The
 *  gateway pod spawns a fresh resolver per resolve call (per OpenClaw's
 *  exec-provider contract — see fork src/secrets/resolve.ts:452), so any
 *  new customer becomes visible on the next spawn. No TOCTOU concern
 *  within a single resolver invocation. Same env var as the provisioner's
 *  AGENTS_DIR (scripts/lib/config.ts:18-19). */
function loadKnownSlugs() {
  try {
    const entries = fs.readdirSync(AGENTS_DIR, { withFileTypes: true });
    const slugs = new Set();
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      // Agent dir naming: octogee-{slug}-coach (provisioner contract).
      const m = e.name.match(/^octogee-(.+)-coach$/);
      if (m && m[1]) slugs.add(m[1]);
    }
    return slugs;
  } catch (err) {
    process.stderr.write(
      `[secret-resolver] could not enumerate AGENTS_DIR (${AGENTS_DIR}): ${err?.message || err}\n`,
    );
    // FAIL CLOSED. Return an empty set so every id with a slug-allowlist
    // dependency is rejected. A misconfigured deploy must not silently
    // collapse the defense to grammar-only — that turns "two-layer DiD"
    // into "one layer plus a stderr line nobody alerts on." The trade-off
    // is BYOT keys won't resolve until the deploy is fixed; that's a loud,
    // visible failure (every BYOT call returns "Refused by resolver") which
    // is exactly the signal we want.
    return new Set();
  }
}

const KNOWN_SLUGS = loadKnownSlugs();

function audit(line) {
  process.stderr.write(`[secret-resolver/audit] ${line}\n`);
}

/** Validate a single id against grammar + known-slug allowlist. Returns
 *  null on success, or an error message string to surface in `errors[id]`.
 *  KNOWN_SLUGS is always a Set — `loadKnownSlugs` returns an empty Set on
 *  read failure (fail-closed), never null, so the slug check always runs. */
function validateId(id) {
  if (typeof id !== "string" || id.length === 0 || id.length > 256) {
    return `id is not a non-empty string ≤256 chars`;
  }
  const m = id.match(BYOK_ID_RE);
  if (!m || !m.groups) {
    return `id does not match byok-{slug}-{anthropic|openai|openai-compatible|grok|openrouter|minimax}[/version]`;
  }
  const slug = m.groups.slug;
  if (!KNOWN_SLUGS.has(slug)) {
    return `slug "${slug}" has no provisioned agent dir`;
  }
  return null;
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

/** Cap on per-call audit-log lines for rejects. A flood of rejects
 *  (probing for slugs, malformed ids) shouldn't be able to run up the
 *  Cloud Logging bill or hide a single legitimate access in a haystack
 *  of decoys. The errors[] response still surfaces every rejected id to
 *  the caller — this only caps the stderr forensic trail. */
const MAX_AUDIT_REJECTS_PER_CALL = 10;

async function main() {
  const req = await readRequest();
  const ids = Array.isArray(req.ids) ? req.ids : [];
  const values = {};
  const errors = {};

  // Validate up front — reject malformed ids and unknown slugs BEFORE any
  // GCP SM round-trip. Each rejected id surfaces as `errors[id]` and never
  // touches the network. Audit every decision (accept + reject) to stderr,
  // with a per-call cap on rejects to prevent log floods.
  const accepted = [];
  let rejectAuditCount = 0;
  let rejectTotal = 0;
  for (const id of ids) {
    const reason = validateId(id);
    if (reason) {
      rejectTotal++;
      if (rejectAuditCount < MAX_AUDIT_REJECTS_PER_CALL) {
        audit(`reject id=${JSON.stringify(id)} reason=${JSON.stringify(reason)}`);
        rejectAuditCount++;
      }
      errors[id] = { message: `Refused by resolver: ${reason}` };
      continue;
    }
    audit(`accept id=${JSON.stringify(id)}`);
    accepted.push(id);
  }
  if (rejectTotal > MAX_AUDIT_REJECTS_PER_CALL) {
    audit(`reject-summary suppressed=${rejectTotal - MAX_AUDIT_REJECTS_PER_CALL} (cap=${MAX_AUDIT_REJECTS_PER_CALL})`);
  }

  // Resolve concurrently — each ref is an independent API call.
  await Promise.all(
    accepted.map(async (id) => {
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
