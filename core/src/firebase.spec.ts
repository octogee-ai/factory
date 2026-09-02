import { afterEach, describe, expect, it, vi } from "vitest";

function installFirebaseAdminMocks(apps: unknown[]) {
  const initializeApp = vi.fn();
  const getApps = vi.fn(() => apps);
  const getFirestore = vi.fn(() => ({ kind: "firestore" }));
  const getStorage = vi.fn(() => ({ kind: "storage" }));

  vi.doMock("firebase-admin/app", () => ({
    initializeApp,
    getApps,
  }));
  vi.doMock("firebase-admin/firestore", () => ({
    getFirestore,
  }));
  vi.doMock("firebase-admin/storage", () => ({
    getStorage,
  }));

  return { initializeApp, getApps, getFirestore, getStorage };
}

async function loadFirebase(apps: unknown[] = []) {
  vi.resetModules();
  const mocks = installFirebaseAdminMocks(apps);
  const module = await import("./firebase");
  return { module, mocks };
}

describe("core firebase bootstrap", () => {
  afterEach(() => {
    vi.doUnmock("firebase-admin/app");
    vi.doUnmock("firebase-admin/firestore");
    vi.doUnmock("firebase-admin/storage");
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("initializes admin credentials for a cold octogee-test process", async () => {
    vi.stubEnv("FIREBASE_PROJECT_ID", "octogee-test");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const { module, mocks } = await loadFirebase([]);

    expect(module.FIREBASE_PROJECT_ID).toBe("octogee-test");
    expect(module.OCTOGEE_ENV).toBe("test");
    expect(mocks.initializeApp).toHaveBeenCalledWith({
      projectId: "octogee-test",
      storageBucket: "octogee-test.firebasestorage.app",
    });
    expect(mocks.getFirestore).toHaveBeenCalledTimes(1);
    expect(module.db).toEqual({ kind: "firestore" });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("[provisioner] Firebase:"));
  });

  it("reuses an existing admin app and resolves prod from GCLOUD_PROJECT", async () => {
    vi.stubEnv("FIREBASE_PROJECT_ID", "");
    vi.stubEnv("GCLOUD_PROJECT", "octogee");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const { module, mocks } = await loadFirebase([{ name: "existing" }]);

    expect(module.FIREBASE_PROJECT_ID).toBe("octogee");
    expect(module.OCTOGEE_ENV).toBe("prod");
    expect(mocks.initializeApp).not.toHaveBeenCalled();
    expect(mocks.getFirestore).toHaveBeenCalledTimes(1);
  });

  it("omits projectId so firebase-admin auto-resolves when no project env is set", async () => {
    vi.stubEnv("FIREBASE_PROJECT_ID", "");
    vi.stubEnv("GCLOUD_PROJECT", "");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const { module, mocks } = await loadFirebase([]);

    expect(module.FIREBASE_PROJECT_ID).toBe("unknown");
    expect(mocks.initializeApp).toHaveBeenCalledWith({
      storageBucket: "unknown.firebasestorage.app",
    });
    expect(mocks.initializeApp.mock.calls[0][0]).not.toHaveProperty("projectId");
  });

  it("surfaces unknown environment for unrecognized project ids", async () => {
    vi.stubEnv("FIREBASE_PROJECT_ID", "local-dev");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const { module } = await loadFirebase([{ name: "existing" }]);

    expect(module.OCTOGEE_ENV).toBe("unknown");
  });
});
