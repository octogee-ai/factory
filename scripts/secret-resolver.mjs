#!/usr/bin/env node
/**
 * OpenClaw exec SecretRef resolver → octogee-api byok broker → GCP Secret Manager.
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
 *           "passEnv": ["FLEET_BROKER_URL", "OCTOGEE_API_URL", "OCTOGEE_API_SA_TOKEN_PATH", "INTERNAL_SERVICE_KEY", "OPENCLAW_AGENTS_DIR", "HOME"],
 *           "jsonOnly": true
 *         }
 *       }
 *     }
 *   }
 *
 * Auth: brokers to octogee-api with the gateway's projected KSA token
 * (x-k8s-sa-token header, /var/run/secrets/octogee-api/token). octogee-api holds
 * the Secret Manager access and roster-scopes the slug — cattle gateways hold no
 * GCP creds. The provider id stays "gcp-secret-manager" (the SecretRef contract);
 * only the resolution path moved to the broker.
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
import { pathToFileURL } from "url";

// Cattle gateways are egress-blocked from the GCP metadata server, so this
// resolver materializes byok-* keys through the octogee-api broker
// (POST /internal/byok/api-key) instead of reaching Secret Manager directly.
// KSA-authed via the gateway's projected token — same contract as
// scripts/lib/internal-fetch.ts.
//
// The DEFAULTS must work without the broker env: openclaw forwards only the
// resolver's `passEnv` allowlist, and existing gateways preserve a pre-broker
// openclaw.json (entrypoint.sh keeps the PVC config) whose passEnv predates these
// vars. So default to the same-namespace SHORT service name — k8s DNS search
// domains resolve `octogee-api` to THIS pod's namespace, correct on every
// namespace with no K8S_NAMESPACE needed — and the gateway pod's mounted
// broker-token path. FLEET_BROKER_URL / OCTOGEE_API_URL / OCTOGEE_API_SA_TOKEN_PATH
// still override when a (new) gateway passes them through.
// http is by design (in-cluster ClusterIP, no TLS); host via an env-overridable
// var, both as a single source of truth and matching the rest of the repo's
// in-cluster URL idiom.
const BROKER_HOST = process.env.OCTOGEE_API_HOST || "octogee-api";
export const BROKER_BASE_URL =
  process.env.FLEET_BROKER_URL || process.env.OCTOGEE_API_URL || `http://${BROKER_HOST}:3001`;
export const KSA_TOKEN_PATH =
  process.env.OCTOGEE_API_SA_TOKEN_PATH || "/var/run/secrets/octogee-gateway-broker/token";

const AGENTS_DIR =
  process.env.OPENCLAW_AGENTS_DIR ||
  path.join(process.env.HOME || "/home/node", ".openclaw", "agents");

export const BYOK_API_KEY_PROVIDER_IDS = [
  "openai",
  "anthropic",
  "openrouter",
  "grok",
  "minimax",
  "openai-compatible",
];
const BYOK_ID_RE = /^byok-(?<body>[a-z0-9][a-z0-9-]{0,128})(?:\/(?<version>[a-zA-Z0-9-]{1,32}))?$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const BYOK_API_KEY_PROVIDER_SUFFIXES = BYOK_API_KEY_PROVIDER_IDS
  .map((provider) => ({ provider, suffix: `-${provider}` }))
  .sort((a, b) => b.suffix.length - a.suffix.length);

function parseByokApiKeyId(id) {
  const m = id.match(BYOK_ID_RE);
  const body = m?.groups?.body;
  if (!body) return null;
  const match = BYOK_API_KEY_PROVIDER_SUFFIXES.find(({ suffix }) => body.endsWith(suffix));
  if (!match) return null;
  const slug = body.slice(0, -match.suffix.length);
  if (!SLUG_RE.test(slug)) return null;
  return { slug, provider: match.provider, version: m.groups?.version };
}

// Per-customer broker-token ref for shared (multi-tenant) gateways. Each
// customer-agent's anthropic auth-profile resolves through this id; the broker
// mints an owner-scoped, meter-only token for it. The agentId is embedded — the
// exec protocol passes no requesting-agent context (see the header note), so the
// id IS the per-agent scope — and the slug is allowlisted exactly like byok.
const AGENT_MODEL_TOKEN_ID_RE =
  /^agent-model-token-(?<agentId>octogee-(?<slug>[a-z0-9][a-z0-9-]{0,62})-coach)$/;

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
  const byok = parseByokApiKeyId(id);
  const agentToken = id.match(AGENT_MODEL_TOKEN_ID_RE);
  if (!byok && !agentToken?.groups) {
    return `id does not match byok-{slug}-{provider}[/version] or agent-model-token-octogee-{slug}-coach`;
  }
  const slug = byok?.slug ?? agentToken?.groups?.slug;
  if (!KNOWN_SLUGS.has(slug)) {
    return `slug "${slug}" has no provisioned agent dir`;
  }
  return null;
}

/** Parse the exec request from stdin (it arrives as one JSON line). */
async function readRequest() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) throw new Error("empty stdin");
  return JSON.parse(raw);
}

/**
 * Materialize one byok-* ref via the octogee-api broker. The broker re-validates
 * the id grammar, roster-scopes the slug to THIS gateway, and reads Secret
 * Manager on our behalf — the resolver holds no GCP creds. The full id
 * (byok-{slug}-{provider}[/version]) goes to the broker, which parses it. `deps`
 * (token, fetchImpl) are injectable for tests; production reads the projected KSA
 * token from disk and uses the global fetch.
 */
export async function resolveOne(id, deps = {}) {
  const token = deps.token ?? fs.readFileSync(KSA_TOKEN_PATH, "utf8").trim();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const headers = { "content-type": "application/json", "x-k8s-sa-token": token };
  if (process.env.INTERNAL_SERVICE_KEY) {
    headers["x-internal-service-key"] = process.env.INTERNAL_SERVICE_KEY;
  }
  // agent-model-token-{agentId} → the per-customer broker-token route; every
  // other id is a byok-* key. Both routes return { value } and roster-scope
  // server-side (the resolver holds no GCP creds and no agent identity).
  const agentToken = id.match(AGENT_MODEL_TOKEN_ID_RE);
  const { route, payload } = agentToken
    ? { route: "/internal/byok/agent-model-token", payload: { agentId: agentToken.groups.agentId } }
    : { route: "/internal/byok/api-key", payload: { id } };
  const res = await fetchImpl(`${BROKER_BASE_URL}${route}`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`byok broker returned ${res.status}`);
  }
  const body = await res.json();
  if (typeof body?.value !== "string") {
    throw new Error("byok broker: malformed response (no value)");
  }
  return body.value;
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

// Run main() only when invoked directly (node secret-resolver.mjs), not when a
// test imports resolveOne for unit coverage.
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
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
}
