/**
 * Ed25519 device identity for chat-proxy's upstream OpenClaw handshake.
 *
 * OpenClaw's gateway auth grants zero scopes to a shared-token client that
 * connects without a signed device payload (see `server.auth.default-token.
 * suite.ts` in the OpenClaw source). This module gives chat-proxy the
 * minimum surface area to participate in the handshake: generate/load a
 * keypair, derive a deviceId, sign the v3 auth payload.
 *
 * Scope: pod-local, in-memory by default. chat-proxy runs stateless on
 * Cloud Run — each pod generates its own identity at startup; the server
 * accepts any valid signature that goes with a valid token + scopes
 * payload, so ephemeral identity is fine. Same logic lives in
 * `scripts/lib/gateway-device-identity.ts` for the provisioner (which
 * persists the keypair in its PVC); consolidate into a shared package
 * when a third consumer appears.
 */
import * as crypto from "node:crypto";

export interface DeviceIdentity {
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
}

// OpenClaw's SPKI prefix for an Ed25519 raw public key. Stripping it from
// the PEM-exported DER gives the raw 32 bytes the server compares against.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function base64UrlEncode(buf: Buffer): string {
  // Strip trailing `=` padding without using a super-linear regex. A simple
  // while loop is O(n) and immune to the backtracking pathology sonarjs
  // flags on `/=+$/`.
  let s = buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_");
  while (s.endsWith("=")) s = s.slice(0, -1);
  return s;
}

function derivePublicKeyRaw(publicKeyPem: string): Buffer {
  const key = crypto.createPublicKey(publicKeyPem);
  const spki = key.export({ type: "spki", format: "der" }) as Buffer;
  if (
    spki.length === ED25519_SPKI_PREFIX.length + 32 &&
    spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    return spki.subarray(ED25519_SPKI_PREFIX.length);
  }
  return spki;
}

function fingerprintPublicKey(publicKeyPem: string): string {
  return crypto
    .createHash("sha256")
    .update(derivePublicKeyRaw(publicKeyPem))
    .digest("hex");
}

export function publicKeyRawBase64UrlFromPem(publicKeyPem: string): string {
  return base64UrlEncode(derivePublicKeyRaw(publicKeyPem));
}

export function generateIdentity(): DeviceIdentity {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }) as string;
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  return {
    deviceId: fingerprintPublicKey(publicKeyPem),
    publicKeyPem,
    privateKeyPem,
  };
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
 * Normalize metadata fields exactly the way OpenClaw does — trim +
 * ASCII-lowercase. Must stay byte-identical so the server's re-derivation
 * matches; otherwise every signature fails verification.
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

function signDevicePayload(privateKeyPem: string, payload: string): string {
  const key = crypto.createPrivateKey(privateKeyPem);
  const sig = crypto.sign(null, Buffer.from(payload, "utf8"), key);
  return base64UrlEncode(sig);
}

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
 * Build the signed `device` block for the OpenClaw `connect` frame. Caller
 * supplies the nonce (from the server's `connect.challenge` event) and
 * wires the result into the outbound connect params.
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
