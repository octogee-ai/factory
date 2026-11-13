import { describe, expect, it } from "vitest";
import * as secretManager from "./secret-manager.js";
import { createRuntimeSecretStore } from "./secret-store.js";

describe("runtime secret store selection", () => {
  it("selects the existing Secret Manager adapter when configured", () => {
    const store = createRuntimeSecretStore({ SECRET_STORE_BACKEND: "secret-manager" });
    expect(store.readSecret).toBe(secretManager.readSecret);
    expect(store.provisionGatewayAuthSecret).toBe(secretManager.provisionGatewayAuthSecret);
  });

  it("requires a root key for the default PostgreSQL store", () => {
    expect(() => createRuntimeSecretStore({})).toThrow("ENCRYPTION_ROOT_KEY");
  });

  it("rejects an unrecognized provider", () => {
    expect(() => createRuntimeSecretStore({ SECRET_STORE_BACKEND: "typo" })).toThrow("invalid SECRET_STORE_BACKEND");
  });
});
