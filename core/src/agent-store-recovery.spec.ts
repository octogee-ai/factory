import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ query: vi.fn<(query: string) => Promise<{ rows: Record<string, unknown>[]; rowCount: number }>>(), release: vi.fn(), commands: [] as string[] }));
vi.mock("pg", async importOriginal => {
  const actual = await importOriginal<typeof import("pg")>();
  return { ...actual, default: { ...actual.default, Pool: class {
    on() {}
    async connect() { return { query: state.query, release: state.release }; }
  } } };
});
import { createAgentStoreOwnershipTransferer } from "./agent-store-credentials.js";

beforeEach(() => {
  state.commands = [];
  state.release.mockClear();
  state.query.mockReset().mockImplementation(async (query: string) => {
    state.commands.push(query);
    if (query === "SELECT current_user") return { rows: [{ current_user: "fixture-admin" }], rowCount: 1 };
    if (query.startsWith("SELECT 1 FROM pg_roles")) return { rows: [{}], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
});

describe("agent-store ownership transaction recovery authority", () => {
  it("rechecks a claim lost while queued behind the PostgreSQL advisory owner before role changes", async () => {
    let releaseLock!: () => void, observeWait!: () => void;
    const blocked = new Promise<void>(resolve => { releaseLock = resolve; });
    const waiting = new Promise<void>(resolve => { observeWait = resolve; });
    const original = state.query.getMockImplementation()!;
    state.query.mockImplementation(async (query: string) => {
      const result = await original(query);
      if (query.startsWith("SELECT pg_advisory_xact_lock")) { observeWait(); await blocked; }
      return result;
    });
    let current = true;
    const assertCurrent = vi.fn(async () => { if (!current) throw new Error("recovery claim replaced"); });
    const transfer = createAgentStoreOwnershipTransferer("postgresql://fixture:synthetic@localhost/fixture");
    const moving = transfer({ uid: "uid-alice", slug: "alice" }, "shared", assertCurrent);
    void moving.catch(() => {});
    await waiting;
    expect(assertCurrent).not.toHaveBeenCalled();
    current = false; releaseLock();
    await expect(moving).rejects.toThrow("recovery claim replaced");
    expect(state.commands.at(-1)).toBe("ROLLBACK");
    expect(state.commands.some(query => query.startsWith("GRANT"))).toBe(false);
    expect(state.commands).not.toContain("COMMIT");
    expect(assertCurrent).toHaveBeenCalledOnce();
    expect(state.release).toHaveBeenCalledOnce();
  });

  it.each(["commit", "cancel-before-commit"] as const)("checks authority again after ownership work and before transaction settlement: %s", async scenario => {
    let checks = 0;
    const assertCurrent = vi.fn(async () => {
      checks++;
      if (checks === 2) {
        expect(state.commands.some(query => query.startsWith("GRANT"))).toBe(true);
        expect(state.commands).not.toContain("COMMIT");
        if (scenario === "cancel-before-commit") throw new Error("recovery claim replaced before commit");
      }
    });
    const transfer = createAgentStoreOwnershipTransferer("postgresql://fixture:synthetic@localhost/fixture");
    const moving = transfer({ uid: "uid-alice", slug: "alice" }, "shared", assertCurrent);
    if (scenario === "commit") { await moving; expect(state.commands.at(-1)).toBe("COMMIT"); }
    else { await expect(moving).rejects.toThrow("recovery claim replaced before commit"); expect(state.commands.at(-1)).toBe("ROLLBACK"); }
    expect(assertCurrent).toHaveBeenCalledTimes(2);
    expect(state.release).toHaveBeenCalledOnce();
  });
});
