import { describe, it, expect, vi } from "vitest";
import { runStuckOpReaperTick } from "../stuck-op-reaper.js";

interface FakeOpDoc {
  id: string;
  data: {
    status?: string;
    kind?: string;
    startedAt?: number;
    createdAt?: number;
  };
  updated?: Record<string, unknown>;
}

function makeFakeDb(ops: FakeOpDoc[]) {
  return {
    collection: (name: string) => {
      if (name !== "glmOperations") {
        throw new Error(`unexpected collection: ${name}`);
      }
      return {
        where: (field: string, op: string, value: unknown) => ({
          get: async () => ({
            docs: ops
              .filter((o) => {
                if (field !== "status" || op !== "==") return true;
                return o.data.status === value;
              })
              .map((o) => ({
                id: o.id,
                data: () => o.data,
                ref: {
                  update: async (patch: Record<string, unknown>) => {
                    o.updated = patch;
                  },
                },
              })),
          }),
        }),
      };
    },
  };
}

const NOW = 1_700_000_000_000;

describe("runStuckOpReaperTick", () => {
  it("flips status=failed on a `running` op older than stalenessMs", async () => {
    const ops: FakeOpDoc[] = [
      {
        id: "op-stuck",
        data: {
          status: "running",
          kind: "migrate-customer",
          startedAt: NOW - 20 * 60_000,
        },
      },
    ];
    const log = vi.fn();
    const result = await runStuckOpReaperTick({
      db: makeFakeDb(ops) as unknown as Parameters<typeof runStuckOpReaperTick>[0]["db"],
      log,
      now: () => NOW,
      stalenessMs: 15 * 60_000,
    });
    expect(result).toEqual({ scanned: 1, reaped: 1 });
    expect(ops[0].updated).toMatchObject({
      status: "failed",
      completedAt: NOW,
      error: expect.stringContaining("reaped"),
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("op-stuck"));
  });

  it("leaves a recent `running` op alone", async () => {
    const ops: FakeOpDoc[] = [
      {
        id: "op-fresh",
        data: { status: "running", kind: "rollout", startedAt: NOW - 30_000 },
      },
    ];
    const result = await runStuckOpReaperTick({
      db: makeFakeDb(ops) as unknown as Parameters<typeof runStuckOpReaperTick>[0]["db"],
      log: vi.fn(),
      now: () => NOW,
      stalenessMs: 15 * 60_000,
    });
    expect(result).toEqual({ scanned: 1, reaped: 0 });
    expect(ops[0].updated).toBeUndefined();
  });

  it("falls back to createdAt when startedAt is missing", async () => {
    const ops: FakeOpDoc[] = [
      {
        id: "op-no-started",
        data: {
          status: "running",
          kind: "migrate-customer",
          createdAt: NOW - 30 * 60_000,
        },
      },
    ];
    const result = await runStuckOpReaperTick({
      db: makeFakeDb(ops) as unknown as Parameters<typeof runStuckOpReaperTick>[0]["db"],
      log: vi.fn(),
      now: () => NOW,
      stalenessMs: 15 * 60_000,
    });
    expect(result).toEqual({ scanned: 1, reaped: 1 });
    expect(ops[0].updated).toBeDefined();
  });

it("skips ops with no anchor timestamp (defensively — log noise only)", async () => {
    const ops: FakeOpDoc[] = [
      { id: "op-no-anchor", data: { status: "running", kind: "rollout" } },
    ];
    const result = await runStuckOpReaperTick({
      db: makeFakeDb(ops) as unknown as Parameters<typeof runStuckOpReaperTick>[0]["db"],
      log: vi.fn(),
      now: () => NOW,
      stalenessMs: 15 * 60_000,
    });
    expect(result).toEqual({ scanned: 1, reaped: 0 });
    expect(ops[0].updated).toBeUndefined();
  });

  it("reaps multiple stuck ops in a single tick", async () => {
    const ops: FakeOpDoc[] = [
      { id: "op-a", data: { status: "running", kind: "migrate-customer", startedAt: NOW - 30 * 60_000 } },
      { id: "op-b", data: { status: "running", kind: "rollout", startedAt: NOW - 20 * 60_000 } },
      { id: "op-c", data: { status: "running", kind: "add-gateway", startedAt: NOW - 60_000 } },
    ];
    const result = await runStuckOpReaperTick({
      db: makeFakeDb(ops) as unknown as Parameters<typeof runStuckOpReaperTick>[0]["db"],
      log: vi.fn(),
      now: () => NOW,
      stalenessMs: 15 * 60_000,
    });
    expect(result).toEqual({ scanned: 3, reaped: 2 });
    expect(ops[0].updated).toBeDefined();
    expect(ops[1].updated).toBeDefined();
    expect(ops[2].updated).toBeUndefined();
  });
});
