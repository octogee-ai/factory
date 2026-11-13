import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface Encryptor {
  encrypt(plaintext: string): Promise<string>;
  decrypt(ciphertext: string): Promise<string>;
}

const ALGORITHM = "aes-256-gcm";
const ENVELOPE = "aes256gcm:v1:";
const IV_BYTES = 12;
const TAG_BYTES = 16;

export function createRootKeyEncryptor(encodedKey: string | undefined): Encryptor {
  const key = Buffer.from(encodedKey ?? "", "base64");
  if (key.length !== 32 || key.toString("base64") !== encodedKey) {
    throw new Error("ENCRYPTION_ROOT_KEY must be a base64-encoded 32-byte key");
  }

  return {
    async encrypt(plaintext) {
      if (typeof plaintext !== "string" || plaintext.length === 0) {
        throw new Error("encryptSecret requires non-empty plaintext string");
      }
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
      cipher.setAAD(Buffer.from(ENVELOPE));
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const payload = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
      return ENVELOPE + payload;
    },
    async decrypt(ciphertext) {
      if (typeof ciphertext !== "string" || !ciphertext.startsWith(ENVELOPE)) {
        throw new Error("unsupported encrypted credential format");
      }
      const encoded = ciphertext.slice(ENVELOPE.length);
      const payload = Buffer.from(encoded, "base64");
      const dataOffset = IV_BYTES + TAG_BYTES;
      if (payload.length <= dataOffset || payload.toString("base64") !== encoded) {
        throw new Error("invalid encrypted credential");
      }
      const decipher = createDecipheriv(ALGORITHM, key, payload.subarray(0, IV_BYTES), {
        authTagLength: TAG_BYTES,
      });
      decipher.setAAD(Buffer.from(ENVELOPE));
      decipher.setAuthTag(payload.subarray(IV_BYTES, dataOffset));
      return Buffer.concat([decipher.update(payload.subarray(dataOffset)), decipher.final()]).toString("utf8");
    },
  };
}
