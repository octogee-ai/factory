import { describe, expect, it } from "vitest";
import { createRootKeyEncryptor } from "./encryptor.js";

const key = Buffer.alloc(32, 1).toString("base64");
const otherKey = Buffer.alloc(32, 2).toString("base64");

describe("root key encryption", () => {
  it("round trips UTF-8 data and generates independent ciphertexts", async () => {
    const encryptor = createRootKeyEncryptor(key);
    const plaintext = "long-lived credential 🔑";
    const first = await encryptor.encrypt(plaintext);
    const second = await encryptor.encrypt(plaintext);

    expect(first).not.toBe(second);
    expect(first).not.toContain(plaintext);
    await expect(createRootKeyEncryptor(key).decrypt(first)).resolves.toBe(plaintext);
    await expect(encryptor.decrypt(second)).resolves.toBe(plaintext);
  });

  it("rejects ciphertext modified after encryption and ciphertext from another key", async () => {
    const encryptor = createRootKeyEncryptor(key);
    const original = await encryptor.encrypt("secret");
    const separator = original.lastIndexOf(":");
    const payload = Buffer.from(original.slice(separator + 1), "base64");
    payload[payload.length - 1] ^= 1;
    const tampered = original.slice(0, separator + 1) + payload.toString("base64");

    await expect(encryptor.decrypt(tampered)).rejects.toThrow();
    await expect(createRootKeyEncryptor(otherKey).decrypt(original)).rejects.toThrow();
  });

  it.each([undefined, "", "invalid", Buffer.alloc(31).toString("base64")])(
    "requires a base64-encoded 32-byte root key",
    (input) => expect(() => createRootKeyEncryptor(input)).toThrow("ENCRYPTION_ROOT_KEY"),
  );

  it("rejects malformed or unsupported ciphertext", async () => {
    const encryptor = createRootKeyEncryptor(key);
    await expect(encryptor.encrypt("")).rejects.toThrow(/non-empty/);
    await expect(encryptor.decrypt("aes256gcm:v1:AA==")).rejects.toThrow(/invalid/);
    await expect(encryptor.decrypt("aes256gcm:v2:AA==")).rejects.toThrow(/unsupported/);
  });
});
