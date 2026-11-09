import type { Firestore } from "firebase-admin/firestore";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertFirestorePlatformBackend, operatorPlatformStateStore } from "../lib/platform-state-store.js";

describe("operatorPlatformStateStore", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("opens the Firestore store by default", async () => {
    vi.stubEnv("PLATFORM_STATE_BACKEND", "");
    await expect(operatorPlatformStateStore({} as Firestore, "test-central")).resolves.toHaveProperty("builders");
  });

  it("requires database settings once PostgreSQL is chosen", async () => {
    vi.stubEnv("PLATFORM_STATE_BACKEND", "postgres");
    vi.stubEnv("PLATFORM_DB_SSLMODE", "");
    await expect(operatorPlatformStateStore({} as Firestore, "test-central")).rejects.toThrow(/PLATFORM_DB_\w+ is required/);
  });
});

describe("assertFirestorePlatformBackend", () => {
  it("refuses a Firestore-only command when PostgreSQL is selected", () => {
    expect(() => assertFirestorePlatformBackend("cutover-simple-roll", { PLATFORM_STATE_BACKEND: "postgres" }))
      .toThrow(/cutover-simple-roll only handles Firestore platform state/);
  });

  it.each([undefined, "firestore"])("allows the command when the backend is %s", (backend) => {
    expect(() => assertFirestorePlatformBackend("cutover-simple-roll", { PLATFORM_STATE_BACKEND: backend })).not.toThrow();
  });
});
