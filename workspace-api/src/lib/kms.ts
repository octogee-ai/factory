// Credential-at-rest encryption via GCP KMS.
//
// users/{uid}/secrets/{provider} docs are Admin-SDK-only by Firestore
// rule (site/firestore.rules:62 — `allow read, write: if false`). But
// "client-blocked" is not the security boundary that matters for OAuth
// refresh tokens / IMAP passwords / Twilio auth tokens — a DB leak, a
// backup-access vector, or a workspace-api SA compromise would expose
// every Builder's third-party credentials in the clear.
//
// This wrapper KMS-encrypts those values before they touch Firestore.
// Single symmetric key per environment (octogee-test, octogee-prod);
// workload-identity-bound IAM grants the workspace-api SA `cryptoKey
// EncrypterDecrypter` on the key. Fail-loud on missing env so no
// silent plaintext fallback can ever ship.
//
// Storage shape: base64-encoded ciphertext as a UTF-8 string in
// Firestore (compatible with Firestore's standard String field type,
// no Blob handling needed at consumers).

import { KeyManagementServiceClient } from "@google-cloud/kms";

// Minimal client surface the lib uses. Lets tests inject a fake
// without pulling in the full SDK type graph.
export interface KmsClient {
  encrypt(req: {
    name: string;
    plaintext: Buffer;
  }): Promise<[{ ciphertext?: Buffer | string | Uint8Array | null }, ...unknown[]]>;
  decrypt(req: {
    name: string;
    ciphertext: Buffer;
  }): Promise<[{ plaintext?: Buffer | string | Uint8Array | null }, ...unknown[]]>;
}

// KMS response bytes come typed as `Buffer | string | Uint8Array`: the
// protobuf-over-gRPC serializer can deliver either raw bytes (Uint8Array
// in Node) or — under some JSON-codec paths — a base64-encoded string.
// Force-casting string→Uint8Array and passing to `Buffer.from(_)` would
// UTF-8-encode the string and produce garbage ciphertext/plaintext. This
// helper normalizes all three to a Buffer of the real bytes. Copilot
// review on #1064 — the lying-cast risk symmetric to the field-name lie
// we just shut down.
function bytesToBuffer(v: string | Buffer | Uint8Array): Buffer {
  if (typeof v === "string") {
    // protobuf bytes-as-string serialization is base64
    return Buffer.from(v, "base64");
  }
  if (Buffer.isBuffer(v)) return v;
  return Buffer.from(v);
}

let _kmsClient: KmsClient | null = null;

/**
 * Test-only injection point. Reset to `null` between tests to restore
 * lazy production initialization. Never call from production code.
 */
export function _setKmsClientForTesting(client: KmsClient | null): void {
  _kmsClient = client;
}

function getKmsClient(): KmsClient {
  if (_kmsClient === null) {
    _kmsClient = new KeyManagementServiceClient() as unknown as KmsClient;
  }
  return _kmsClient;
}

function getKeyName(): string {
  const name = process.env.OCTOGEE_KMS_KEY_NAME;
  if (!name) {
    throw new Error(
      "OCTOGEE_KMS_KEY_NAME env var is required for credential-at-rest encryption " +
        "(expected full resource path: projects/{p}/locations/{l}/keyRings/{r}/cryptoKeys/{k})",
    );
  }
  return name;
}

/**
 * Encrypt a plaintext secret via KMS. Returns base64-encoded ciphertext
 * for direct storage as a Firestore string field. Throws on:
 *   - empty/non-string plaintext (defensive — we never intentionally
 *     persist empty creds, and an empty input most likely means upstream
 *     validation failed)
 *   - missing OCTOGEE_KMS_KEY_NAME (fail-loud, never silent plaintext)
 *   - KMS API error (transient or permanent — caller surfaces to user)
 */
export async function encryptSecret(plaintext: string): Promise<string> {
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new Error("encryptSecret requires non-empty plaintext string");
  }
  const [response] = await getKmsClient().encrypt({
    name: getKeyName(),
    plaintext: Buffer.from(plaintext, "utf-8"),
  });
  const ciphertext = response.ciphertext;
  if (ciphertext === undefined || ciphertext === null) {
    throw new Error("KMS encrypt returned no ciphertext");
  }
  return bytesToBuffer(ciphertext).toString("base64");
}

/**
 * Decrypt a previously-encrypted base64 ciphertext back to its
 * original utf-8 plaintext. Same fail-loud contract as encryptSecret.
 * Throws on:
 *   - empty/non-string ciphertext
 *   - missing OCTOGEE_KMS_KEY_NAME
 *   - KMS API error (key rotated past version, IAM denial, etc.)
 */
export async function decryptSecret(ciphertextBase64: string): Promise<string> {
  if (typeof ciphertextBase64 !== "string" || ciphertextBase64.length === 0) {
    throw new Error("decryptSecret requires non-empty ciphertext string");
  }
  const [response] = await getKmsClient().decrypt({
    name: getKeyName(),
    ciphertext: Buffer.from(ciphertextBase64, "base64"),
  });
  const plaintext = response.plaintext;
  if (plaintext === undefined || plaintext === null) {
    throw new Error("KMS decrypt returned no plaintext");
  }
  return bytesToBuffer(plaintext).toString("utf-8");
}
