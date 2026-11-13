import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function loadEmulatorHelpers() {
  vi.resetModules();
  return import("./firestore-emulator");
}

describe("firestore-emulator helpers", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("throws a Firestore-specific error when the Firestore emulator is missing", async () => {
    vi.stubEnv("FIRESTORE_EMULATOR_HOST", "");
    vi.stubEnv("FIREBASE_AUTH_EMULATOR_HOST", "127.0.0.1:9099");
    const { requireEmulator } = await loadEmulatorHelpers();

    expect(() => requireEmulator()).toThrow(/FIRESTORE_EMULATOR_HOST is not set/);
  });

  it("throws an auth-specific error when only the auth emulator is missing", async () => {
    vi.stubEnv("FIRESTORE_EMULATOR_HOST", "127.0.0.1:8080");
    vi.stubEnv("FIREBASE_AUTH_EMULATOR_HOST", "");
    const { requireEmulator } = await loadEmulatorHelpers();

    expect(() => requireEmulator()).toThrow(/FIREBASE_AUTH_EMULATOR_HOST is not set/);
  });

  it("allows emulator-backed specs when both emulator hosts are configured", async () => {
    vi.stubEnv("FIRESTORE_EMULATOR_HOST", "127.0.0.1:8080");
    vi.stubEnv("FIREBASE_AUTH_EMULATOR_HOST", "127.0.0.1:9099");
    const { requireEmulator } = await loadEmulatorHelpers();

    expect(() => requireEmulator()).not.toThrow();
  });

  it("clears Firestore and auth emulator state for the active project", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchImpl);
    vi.stubEnv("FIRESTORE_EMULATOR_HOST", "127.0.0.1:8080");
    vi.stubEnv("FIREBASE_AUTH_EMULATOR_HOST", "127.0.0.1:9099");
    vi.stubEnv("GCLOUD_PROJECT", "octogee-test");
    const { resetEmulator } = await loadEmulatorHelpers();

    await resetEmulator();

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:8080/emulator/v1/projects/octogee-test/databases/(default)/documents",
      { method: "DELETE" },
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:9099/emulator/v1/projects/octogee-test/accounts",
      { method: "DELETE" },
    );
  });

  it("ignores reset failures so cleanup does not hide the original test failure", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("down"));
    vi.stubGlobal("fetch", fetchImpl);
    vi.stubEnv("FIRESTORE_EMULATOR_HOST", "127.0.0.1:8080");
    vi.stubEnv("FIREBASE_AUTH_EMULATOR_HOST", "127.0.0.1:9099");
    vi.stubEnv("FIREBASE_PROJECT", "octogee-test");
    const { resetEmulator } = await loadEmulatorHelpers();

    await expect(resetEmulator()).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
