

import { KeyManagementServiceClient } from "@google-cloud/kms";

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

function bytesToBuffer(v: string | Buffer | Uint8Array): Buffer {
  if (typeof v === "string") {
    
    return Buffer.from(v, "base64");
  }
  if (Buffer.isBuffer(v)) return v;
  return Buffer.from(v);
}

let _kmsClient: KmsClient | null = null;

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
