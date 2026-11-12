import { describe, expect, it, vi } from "vitest";
import type { PlatformStateStore } from "../store.js";
import { lazyPlatformStateStore } from "../lazy-store.js";

function fakeStore(): PlatformStateStore {
  const store = {
    users: { records: { get: vi.fn(async () => null) } },
    async close() {
      await store.users.records.get("closed");
    },
  };
  return store as unknown as PlatformStateStore;
}

describe("lazyPlatformStateStore", () => {
  it("builds nothing until the store is first used", () => {
    const create = vi.fn(fakeStore);
    lazyPlatformStateStore(create);
    expect(create).not.toHaveBeenCalled();
  });

  it("builds the store once and serves every later use from it", async () => {
    const built = fakeStore();
    const create = vi.fn(() => built);
    const store = lazyPlatformStateStore(create);
    await store.users.records.get("u1");
    await store.close();
    expect(create).toHaveBeenCalledOnce();
    expect(built.users.records.get).toHaveBeenCalledWith("u1");
    expect(built.users.records.get).toHaveBeenCalledWith("closed");
  });

  it("raises the construction error at the first use", () => {
    const store = lazyPlatformStateStore(() => {
      throw new Error("PLATFORM_DB_HOST is required");
    });
    expect(() => store.users).toThrow("PLATFORM_DB_HOST is required");
  });
});

describe("lazyPlatformStateStore spying", () => {
  it("lets a spy on a top-level method replace the built store's method", async () => {
    const built = fakeStore();
    const store = lazyPlatformStateStore(() => built);
    const close = vi.spyOn(store, "close").mockResolvedValueOnce(undefined);
    await store.close();
    expect(close).toHaveBeenCalledOnce();
    expect(built.users.records.get).not.toHaveBeenCalled();
  });
});
