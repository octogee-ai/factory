import { afterEach, describe, expect, it, vi } from "vitest";

function installFirebaseAdminMocks(apps: unknown[]) {
  const defaultApp = { name: "[DEFAULT]" };
  const initializeApp = vi.fn(() => {
    apps.push(defaultApp);
    return defaultApp;
  });
  const getApps = vi.fn(() => apps);
  const getApp = vi.fn(() => apps[0]);
  const getFirestore = vi.fn(() => ({ kind: "firestore" }));
  const getStorage = vi.fn(() => ({ kind: "storage" }));

  vi.doMock("firebase-admin/app", () => ({
    initializeApp,
    getApps,
    getApp,
  }));
  vi.doMock("firebase-admin/firestore", () => ({
    getFirestore,
  }));
  vi.doMock("firebase-admin/storage", () => ({
    getStorage,
  }));

  return { initializeApp, getApps, getFirestore, getStorage, defaultApp };
}

async function loadFirebase(apps: unknown[] = []) {
  vi.resetModules();
  const mocks = installFirebaseAdminMocks(apps);
  const module = await import("./firebase");
  return { module, mocks };
}

function firestoreKind(db: unknown): unknown {
  return (db as { kind: unknown }).kind;
}

describe("core firebase bootstrap", () => {
  afterEach(() => {
    vi.doUnmock("firebase-admin/app");
    vi.doUnmock("firebase-admin/firestore");
    vi.doUnmock("firebase-admin/storage");
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("creates no Firebase app or client at import", async () => {
    vi.stubEnv("FIREBASE_PROJECT_ID", "octogee-test");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const { module, mocks } = await loadFirebase([]);

    expect(module.FIREBASE_PROJECT_ID).toBe("octogee-test");
    expect(module.OCTOGEE_ENV).toBe("test");
    expect(mocks.initializeApp).not.toHaveBeenCalled();
    expect(mocks.getFirestore).not.toHaveBeenCalled();
    expect(mocks.getStorage).not.toHaveBeenCalled();
  });

  it("initializes admin credentials at the first database use in a cold octogee-test process", async () => {
    vi.stubEnv("FIREBASE_PROJECT_ID", "octogee-test");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const { module, mocks } = await loadFirebase([]);

    expect(firestoreKind(module.db)).toBe("firestore");
    expect(firestoreKind(module.db)).toBe("firestore");
    expect(mocks.initializeApp).toHaveBeenCalledOnce();
    expect(mocks.initializeApp).toHaveBeenCalledWith({
      projectId: "octogee-test",
      storageBucket: "octogee-test.firebasestorage.app",
    });
    expect(mocks.getFirestore).toHaveBeenCalledOnce();
    expect(mocks.getFirestore).toHaveBeenCalledWith(mocks.defaultApp);
    expect(log.mock.calls.map(([line]) => JSON.parse(String(line)))).toContainEqual(expect.objectContaining({
      service: "provisioner", severity: "INFO", message: expect.stringContaining("Firebase:"),
    }));
  });

  it("reuses an existing admin app and resolves prod from GCLOUD_PROJECT", async () => {
    vi.stubEnv("FIREBASE_PROJECT_ID", "");
    vi.stubEnv("GCLOUD_PROJECT", "octogee");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const existing = { name: "[DEFAULT]", existing: true };

    const { module, mocks } = await loadFirebase([existing]);

    expect(module.FIREBASE_PROJECT_ID).toBe("octogee");
    expect(module.OCTOGEE_ENV).toBe("prod");
    expect(firestoreKind(module.db)).toBe("firestore");
    expect(mocks.initializeApp).not.toHaveBeenCalled();
    expect(mocks.getFirestore).toHaveBeenCalledWith(existing);
  });

  it("omits projectId so firebase-admin auto-resolves when no project env is set", async () => {
    vi.stubEnv("FIREBASE_PROJECT_ID", "");
    vi.stubEnv("GCLOUD_PROJECT", "");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const { module, mocks } = await loadFirebase([]);
    firestoreKind(module.db);

    expect(module.FIREBASE_PROJECT_ID).toBe("unknown");
    expect(mocks.initializeApp).toHaveBeenCalledWith({
      storageBucket: "unknown.firebasestorage.app",
    });
    expect((mocks.initializeApp.mock.calls[0] as unknown[])[0]).not.toHaveProperty("projectId");
  });

  it("initializes the admin app for storage used before the database", async () => {
    vi.stubEnv("FIREBASE_PROJECT_ID", "octogee-test");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const { module, mocks } = await loadFirebase([]);

    expect(module.getStorage()).toEqual({ kind: "storage" });
    expect(mocks.initializeApp).toHaveBeenCalledOnce();
    expect(mocks.getStorage).toHaveBeenCalledWith(mocks.defaultApp);
  });

  it("surfaces unknown environment for unrecognized project ids", async () => {
    vi.stubEnv("FIREBASE_PROJECT_ID", "local-dev");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const { module } = await loadFirebase([{ name: "existing" }]);

    expect(module.OCTOGEE_ENV).toBe("unknown");
  });
});
