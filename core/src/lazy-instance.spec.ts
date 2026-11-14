import { describe, expect, it, vi } from "vitest";
import { lazyInstance } from "./lazy-instance.js";

interface Store {
  users: { records: { get: (uid: string) => Promise<null> } };
  close(): Promise<void>;
}

function fakeStore(): Store {
  const store: Store = {
    users: { records: { get: vi.fn(async () => null) } },
    async close() {
      await store.users.records.get("closed");
    },
  };
  return store;
}

class Client {
  private readonly prefix = "users/";
  private calls = 0;

  doc(id: string): string {
    this.calls += 1;
    return `${this.prefix}${id}`;
  }

  get callCount(): number {
    return this.calls;
  }
}

describe("lazyInstance", () => {
  it("builds nothing until the instance is first used", () => {
    const create = vi.fn(fakeStore);
    lazyInstance(create);
    expect(create).not.toHaveBeenCalled();
  });

  it("builds the instance once and serves every later use from it", async () => {
    const built = fakeStore();
    const create = vi.fn(() => built);
    const store = lazyInstance(create);
    await store.users.records.get("u1");
    await store.close();
    expect(create).toHaveBeenCalledOnce();
    expect(built.users.records.get).toHaveBeenCalledWith("u1");
    expect(built.users.records.get).toHaveBeenCalledWith("closed");
  });

  it("raises the construction error at the first use", () => {
    const store = lazyInstance<Store>(() => {
      throw new Error("PLATFORM_DB_HOST is required");
    });
    expect(() => store.users).toThrow("PLATFORM_DB_HOST is required");
  });

  it("runs class methods and getters against the built instance's own state", () => {
    const client = lazyInstance(() => new Client());
    expect(client.doc("ada")).toBe("users/ada");
    expect(client.doc("bob")).toBe("users/bob");
    expect(client.callCount).toBe(2);
  });

  it("answers instanceof for the built instance's class", () => {
    expect(lazyInstance(() => new Client())).toBeInstanceOf(Client);
  });

  it("lets a spy on a top-level method replace the built instance's method", async () => {
    const built = fakeStore();
    const store = lazyInstance(() => built);
    const close = vi.spyOn(store, "close").mockResolvedValueOnce(undefined);
    await store.close();
    expect(close).toHaveBeenCalledOnce();
    expect(built.users.records.get).not.toHaveBeenCalled();
  });
});
