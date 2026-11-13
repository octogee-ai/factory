import { describe, expect, it, vi } from "vitest";
import { reserveWorkspace } from "./workspace-reservation.js";

function storeHolding(existing: { ownerUid: string } | null) {
  const records = { get: vi.fn(async () => existing), put: vi.fn(async () => undefined) };
  const store = { transaction: vi.fn(async (_options: unknown, run: (tx: unknown) => Promise<unknown>) => run({ workspaces: { records } })) };
  return { records, store: store as unknown as Parameters<typeof reserveWorkspace>[0] };
}

describe("reserveWorkspace", () => {
  it("records a free name for its owner", async () => {
    const { records, store } = storeHolding(null);
    await expect(reserveWorkspace(store, "lin", "user-1")).resolves.toBe("created");
    expect(records.put).toHaveBeenCalledWith(expect.objectContaining({ slug: "lin", id: "lin", ownerUid: "user-1", giteaOrgName: "lin" }));
  });

  it("leaves a name its owner already holds", async () => {
    const { records, store } = storeHolding({ ownerUid: "user-1" });
    await expect(reserveWorkspace(store, "lin", "user-1")).resolves.toBe("existing");
    expect(records.put).not.toHaveBeenCalled();
  });

  it("refuses a name held by someone else", async () => {
    const { records, store } = storeHolding({ ownerUid: "someone-else" });
    await expect(reserveWorkspace(store, "lin", "user-1")).resolves.toBe("taken");
    expect(records.put).not.toHaveBeenCalled();
  });
});
