import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlatformStateStore } from "../../store.js";
import { platformStateStoreForDeploymentTarget, platformStateStoreFromEnvironment } from "../store-from-environment.js";

const DATABASE_SETTINGS = {
  PLATFORM_DB_HOST: "127.0.0.1",
  PLATFORM_DB_NAME: "platform",
  PLATFORM_DB_USER: "platform",
  PLATFORM_DB_PASSWORD: "localonly",
  PLATFORM_DB_SSLMODE: "disable",
};

function selectStore(environment: Record<string, string | undefined>) {
  const firestoreStore = { close: vi.fn() } as unknown as PlatformStateStore;
  const createFirestoreStore = vi.fn(() => firestoreStore);
  const store = () =>
    platformStateStoreFromEnvironment({
      applicationName: "store-selection-test",
      createFirestoreStore,
      logger: { warn: vi.fn(), error: vi.fn() },
      environment,
    });
  return { store, firestoreStore, createFirestoreStore };
}

describe("platformStateStoreFromEnvironment", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses Firestore when no backend is chosen", () => {
    const { store, firestoreStore } = selectStore({});
    expect(store()).toBe(firestoreStore);
  });

  it("stays on Firestore when database settings exist but no backend is chosen", () => {
    const { store, firestoreStore } = selectStore(DATABASE_SETTINGS);
    expect(store()).toBe(firestoreStore);
  });

  it("uses Firestore when it is chosen by name", () => {
    const { store, firestoreStore } = selectStore({ PLATFORM_STATE_BACKEND: "firestore" });
    expect(store()).toBe(firestoreStore);
  });

  it("rejects an unknown backend and builds nothing", () => {
    const { store, createFirestoreStore } = selectStore({ PLATFORM_STATE_BACKEND: "sqlite", ...DATABASE_SETTINGS });
    expect(store).toThrow(/PLATFORM_STATE_BACKEND must be one of firestore, postgres/);
    expect(createFirestoreStore).not.toHaveBeenCalled();
  });

  it("builds a PostgreSQL store from the database settings without touching Firestore", () => {
    const { store, createFirestoreStore } = selectStore({ PLATFORM_STATE_BACKEND: "postgres", ...DATABASE_SETTINGS });
    expect(store().users).toBeDefined();
    expect(createFirestoreStore).not.toHaveBeenCalled();
  });

  it("names the missing setting rather than falling back to Firestore", () => {
    const { store, createFirestoreStore } = selectStore({ PLATFORM_STATE_BACKEND: "postgres" });
    expect(store).toThrow(/PLATFORM_DB_\w+ is required/);
    expect(createFirestoreStore).not.toHaveBeenCalled();
  });

  it("ends the pool it created when the store closes", async () => {
    const end = vi.spyOn(pg.Pool.prototype, "end").mockResolvedValue(undefined);
    const { store } = selectStore({ PLATFORM_STATE_BACKEND: "postgres", ...DATABASE_SETTINGS });
    await store().close();
    expect(end).toHaveBeenCalledOnce();
  });
});

describe("platformStateStoreForDeploymentTarget", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function selectForTarget(environment: Record<string, string | undefined>) {
    const firestoreStore = { close: vi.fn() } as unknown as PlatformStateStore;
    const createFirestoreStore = vi.fn(() => firestoreStore);
    const store = () =>
      platformStateStoreForDeploymentTarget({
        applicationName: "store-selection-test",
        createFirestoreStore,
        logger: { warn: vi.fn(), error: vi.fn() },
        environment,
        deploymentTargetId: "test-central",
      });
    return { store, firestoreStore, createFirestoreStore };
  }

  it("uses Firestore without opening a database when no backend is chosen", async () => {
    const query = vi.spyOn(pg.Pool.prototype, "query");
    const { store, firestoreStore } = selectForTarget(DATABASE_SETTINGS);
    await expect(store()).resolves.toBe(firestoreStore);
    expect(query).not.toHaveBeenCalled();
  });

  it("closes its pool when the database belongs to another target", async () => {
    vi.spyOn(pg.Pool.prototype, "query").mockImplementation(async () => ({ rows: [{ target_id: "prod-central" }] }) as never);
    const end = vi.spyOn(pg.Pool.prototype, "end").mockResolvedValue(undefined);
    const { store } = selectForTarget({ PLATFORM_STATE_BACKEND: "postgres", ...DATABASE_SETTINGS });
    await expect(store()).rejects.toThrow('platform database belongs to deployment target "prod-central", not "test-central"');
    expect(end).toHaveBeenCalledOnce();
  });

  it("reports why the database could not be read even when closing the pool also fails", async () => {
    vi.spyOn(pg.Pool.prototype, "query").mockImplementation(async () => {
      throw new Error("connection refused");
    });
    vi.spyOn(pg.Pool.prototype, "end").mockRejectedValue(new Error("already closing"));
    const { store } = selectForTarget({ PLATFORM_STATE_BACKEND: "postgres", ...DATABASE_SETTINGS });
    await expect(store()).rejects.toThrow("connection refused");
  });
});
