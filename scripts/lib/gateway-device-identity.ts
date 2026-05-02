/**
 * Device-identity helpers for the provisioner's gateway RPC client.
 *
 * OpenClaw's gateway auth is explicit: a shared-token client connected
 * without a signed device payload is intentionally granted ZERO operator
 * scopes (see `src/gateway/server.auth.default-token.suite.ts:194` in
 * OpenClaw — "operator + valid shared token => connected with cleared
 * scopes"). The CLI path and Control UI both get around this by pairing
 * each caller with an Ed25519 device identity that signs the connect
 * challenge nonce; the server then verifies the signature and grants the
 * scopes the payload asked for.
 *
 * This module ports the minimal surface area from OpenClaw
 * (`src/infra/device-identity.ts` + `src/gateway/device-auth.ts` +
 * `src/gateway/device-metadata-normalization.ts`) so the provisioner can
 * participate in the same handshake.
 *
 * Gateway-agnostic by design. The identity is OUR (the provisioner's)
 * device, not the gateway's — any Ed25519 keypair works against any
 * OpenClaw gateway in shared-token mode, and no pre-pairing step is
 * required. The default storage path lives under an octogee-branded
 * directory so we don't collide with OpenClaw's own state dir and so
 * future deployments where the provisioner talks to a remote (non-pod-
 * local) gateway still work unmodified.
 *
 * Scope of the port: generate/load an Ed25519 keypair, derive a deviceId,
 * encode the public key, sign the v3 auth payload. Nothing else.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ── Types ───────────────────────────────────────────────────────────────────

export interface DeviceIdentity {
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
}

interface StoredIdentity {
  version: 1;
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
  createdAtMs: number;
}

// ── Constants ───────────────────────────────────────────────────────────────

// OpenClaw's SPKI prefix for an Ed25519 raw public key. The PEM-encoded key
// starts with this byte sequence followed by 32 raw key bytes — stripping it
// gives the format the server expects over the wire.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/**
 * Default identity path — octogee-scoped so we don't share state with
 * OpenClaw's own identity directory (which would couple the provisioner's
 * lifecycle to a specific gateway pod's filesystem).
 *
 *   env OCTOGEE_PROVISIONER_IDENTITY_PATH  — full path override
 *   default                                 — $HOME/.octogee/provisioner/device.json
 *
 * When the gateway and provisioner happen to share a PVC (today's octogee
 * deployment), the default lands alongside the workspace dirs and persists
 * across pod restarts like everything else in $HOME/.octogee.
 */
function resolveDefaultIdentityPath(): string {
  const override = process.env.OCTOGEE_PROVISIONER_IDENTITY_PATH;
  if (override && override.trim()) return override;
  return path.join(os.homedir(), ".octogee", "provisioner", "device.json");
}

// ── Encoding ────────────────────────────────────────────────────────────────

function base64UrlEncode(buf: Buffer): string {
  // The `=+$` regex is bounded — base64 padding is at most 2 trailing `=`,
  // so the `+` quantifier matches at most 2 chars. The flagged super-linear
  // backtracking risk requires an unbounded backtracking surface, which
  // doesn't exist here. eslint-disable with this rationale rather than
  // rewriting to a slightly-more-awkward form.
  // eslint-disable-next-line sonarjs/slow-regex -- bounded match (≤2 trailing `=`); not ReDoS-able
  return buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

/**
 * Extract the raw 32-byte Ed25519 public key from a PEM-encoded SPKI key.
 * OpenClaw's handshake compares raw bytes, not PEM, so this conversion is
 * part of the wire-compatibility contract.
 */
function derivePublicKeyRaw(publicKeyPem: string): Buffer {
  const key = crypto.createPublicKey(publicKeyPem);
  const spki = key.export({ type: "spki", format: "der" }) as Buffer;
  if (
    spki.length === ED25519_SPKI_PREFIX.length + 32 &&
    spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    return spki.subarray(ED25519_SPKI_PREFIX.length);
  }
  // Shouldn't happen for a well-formed Ed25519 key, but if it does we hand
  // back the full DER and let the server decide (same fallback OpenClaw uses).
  return spki;
}

function fingerprintPublicKey(publicKeyPem: string): string {
  return crypto.createHash("sha256").update(derivePublicKeyRaw(publicKeyPem)).digest("hex");
}

export function publicKeyRawBase64UrlFromPem(publicKeyPem: string): string {
  return base64UrlEncode(derivePublicKeyRaw(publicKeyPem));
}

// ── Identity load/create ────────────────────────────────────────────────────

function generateIdentity(): DeviceIdentity {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }) as string;
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  return {
    deviceId: fingerprintPublicKey(publicKeyPem),
    publicKeyPem,
    privateKeyPem,
  };
}

/**
 * Load the Ed25519 identity at `filePath`, or create one if it's missing or
 * malformed. On create, writes the file with mode 0600 so the private key
 * isn't world-readable.
 *
 * The provisioner owns exactly one identity per deployment (one file, many
 * gateway connections reuse it). Since OpenClaw's shared-token auth grants
 * scopes based on the signed payload, not on prior pairing, a single
 * provisioner identity authenticates against any number of OpenClaw
 * gateways given the right token per call.
 */
export function loadOrCreateDeviceIdentity(
  filePath: string = resolveDefaultIdentityPath(),
): DeviceIdentity {
  try {
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as StoredIdentity;
      if (
        parsed?.version === 1 &&
        typeof parsed.deviceId === "string" &&
        typeof parsed.publicKeyPem === "string" &&
        typeof parsed.privateKeyPem === "string"
      ) {
        return {
          deviceId: parsed.deviceId,
          publicKeyPem: parsed.publicKeyPem,
          privateKeyPem: parsed.privateKeyPem,
        };
      }
    }
  } catch {
    // Fall through to regenerate — unreadable file is treated as missing.
  }

  const identity = generateIdentity();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const stored: StoredIdentity = {
    version: 1,
    deviceId: identity.deviceId,
    publicKeyPem: identity.publicKeyPem,
    privateKeyPem: identity.privateKeyPem,
    createdAtMs: Date.now(),
  };
  fs.writeFileSync(filePath, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best-effort
  }
  return identity;
}

// ── Signing ─────────────────────────────────────────────────────────────────

export function signDevicePayload(privateKeyPem: string, payload: string): string {
  const key = crypto.createPrivateKey(privateKeyPem);
  const sig = crypto.sign(null, Buffer.from(payload, "utf8"), key);
  return base64UrlEncode(sig);
}

// ── Auth payload (v3) ───────────────────────────────────────────────────────

export interface DeviceAuthPayloadV3Params {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token?: string | null;
  nonce: string;
  platform?: string | null;
  deviceFamily?: string | null;
}

/**
 * Normalize metadata fields exactly the way OpenClaw does (trim + lowercase
 * ASCII only). Keeping the normalization byte-identical to the server is
 * the whole point — signature verification re-derives the same payload
 * string on the server side.
 */
function normalizeDeviceMetadataForAuth(value: string | null | undefined): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

export function buildDeviceAuthPayloadV3(params: DeviceAuthPayloadV3Params): string {
  return [
    "v3",
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    params.scopes.join(","),
    String(params.signedAtMs),
    params.token ?? "",
    params.nonce,
    normalizeDeviceMetadataForAuth(params.platform),
    normalizeDeviceMetadataForAuth(params.deviceFamily),
  ].join("|");
}

// ── High-level helper ───────────────────────────────────────────────────────

export interface SignedDevicePayload {
  id: string;
  publicKey: string;
  signature: string;
  signedAt: number;
  nonce: string;
}

export interface SignConnectDeviceParams {
  identity: DeviceIdentity;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  nonce: string;
  token?: string | null;
  platform?: string | null;
  deviceFamily?: string | null;
  signedAtMs?: number;
}

/**
 * Build the signed `device` block the gateway expects in the connect frame.
 * Caller is responsible for obtaining the nonce (from the `connect.challenge`
 * event) and for wiring this result into `connect` params.
 */
export function signConnectDevice(params: SignConnectDeviceParams): SignedDevicePayload {
  const signedAtMs = params.signedAtMs ?? Date.now();
  const payload = buildDeviceAuthPayloadV3({
    deviceId: params.identity.deviceId,
    clientId: params.clientId,
    clientMode: params.clientMode,
    role: params.role,
    scopes: params.scopes,
    signedAtMs,
    token: params.token ?? null,
    nonce: params.nonce,
    platform: params.platform ?? null,
    deviceFamily: params.deviceFamily ?? null,
  });
  return {
    id: params.identity.deviceId,
    publicKey: publicKeyRawBase64UrlFromPem(params.identity.publicKeyPem),
    signature: signDevicePayload(params.identity.privateKeyPem, payload),
    signedAt: signedAtMs,
    nonce: params.nonce,
  };
}
