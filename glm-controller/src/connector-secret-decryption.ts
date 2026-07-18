import { KeyManagementServiceClient } from "@google-cloud/kms";

export interface ConnectorKmsClient {
  decrypt(request: {
    name: string;
    ciphertext: Buffer;
  }): Promise<[{ plaintext?: Buffer | string | Uint8Array | null }, ...unknown[]]>;
}

function plaintextBuffer(value: Buffer | string | Uint8Array): Buffer {
  if (typeof value === "string") return Buffer.from(value, "base64");
  return Buffer.from(value);
}

export function createConnectorSecretDecryptor(
  client: ConnectorKmsClient = new KeyManagementServiceClient() as unknown as ConnectorKmsClient,
): (ciphertext: string) => Promise<string> {
  return async (ciphertext: string) => {
    const name = process.env.OCTOGEE_KMS_KEY_NAME;
    if (!name) throw new Error("OCTOGEE_KMS_KEY_NAME is required for connector revocation");
    const [response] = await client.decrypt({
      name,
      ciphertext: Buffer.from(ciphertext, "base64"),
    });
    if (response.plaintext === undefined || response.plaintext === null) {
      throw new Error("KMS decrypt returned no plaintext");
    }
    return plaintextBuffer(response.plaintext).toString("utf8");
  };
}
