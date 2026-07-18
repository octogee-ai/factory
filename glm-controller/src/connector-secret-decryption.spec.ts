import { afterEach, describe, expect, it, vi } from "vitest";

import { createConnectorSecretDecryptor } from "./connector-secret-decryption.js";

describe("createConnectorSecretDecryptor", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("decrypts with the configured integration KMS key", async () => {
    vi.stubEnv(
      "OCTOGEE_KMS_KEY_NAME",
      "projects/test/locations/us/keyRings/creds/cryptoKeys/integrations",
    );
    const decrypt = vi.fn(async () => [{ plaintext: Buffer.from("refresh-token") }]);
    const decryptSecret = createConnectorSecretDecryptor({ decrypt });

    await expect(decryptSecret(Buffer.from("ciphertext").toString("base64"))).resolves.toBe(
      "refresh-token",
    );
    expect(decrypt).toHaveBeenCalledWith({
      name: "projects/test/locations/us/keyRings/creds/cryptoKeys/integrations",
      ciphertext: Buffer.from("ciphertext"),
    });
  });

  it("fails loudly when the KMS key is not configured", async () => {
    vi.stubEnv("OCTOGEE_KMS_KEY_NAME", "");
    const decryptSecret = createConnectorSecretDecryptor({ decrypt: vi.fn() });

    await expect(decryptSecret("YQ==")).rejects.toThrow(/OCTOGEE_KMS_KEY_NAME/);
  });
});
