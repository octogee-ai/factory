import { describe, it, expect, vi } from "vitest";
import { resumeOrphanedRunningOps } from "../resume-orphaned-ops.js";
import type { Operation } from "@octogee/shared/types/glm";

interface FakeOpDoc {
  id: string;
  data: Partial<Operation> & { status?: string; kind?: string };
}

function makeFakeDb(ops: FakeOpDoc[]) {
  return {
    collection: (name: string) => {
      if (name !== "glmOperations") throw new Error(`unexpected collection: ${name}`);
      return {
        where: (field: string, op: string, value: unknown) => ({
          get: async () => ({
            docs: ops
              .filter((o) => (field === "status" && op === "==" ? o.data.status === value : true))
              .map((o) => ({ id: o.id, data: () => o.data, ref: { id: o.id } })),
          }),
        }),
      };
    },
  };
}

const RESUMABLE = new Set(["rollout"]);

describe("resumeOrphanedRunningOps", () => {
  it("re-drives a running rollout op (orphaned by a restart)", async () => {
    const redrive = vi.fn(async () => undefined);
    const ops: FakeOpDoc[] = [
      { id: "op-roll", data: { status: "running", kind: "rollout" } },
    ];
    const result = await resumeOrphanedRunningOps({
      db: makeFakeDb(ops) as never,
      log: vi.fn(),
      resumableKinds: RESUMABLE,
      redrive,
    });
    expect(result).toEqual({ scanned: 1, resumed: 1 });
    expect(redrive).toHaveBeenCalledTimes(1);
    expect(redrive.mock.calls[0][0]).toMatchObject({ id: "op-roll", kind: "rollout" });
  });

  it("skips non-resumable running kinds (migrate-customer sub-ops, add-gateway) — the rollout re-drive re-issues those", async () => {
    const redrive = vi.fn(async () => undefined);
    const ops: FakeOpDoc[] = [
      { id: "op-mig", data: { status: "running", kind: "migrate-customer" } },
      { id: "op-add", data: { status: "running", kind: "add-gateway" } },
    ];
    const result = await resumeOrphanedRunningOps({
      db: makeFakeDb(ops) as never,
      log: vi.fn(),
      resumableKinds: RESUMABLE,
      redrive,
    });
    expect(result).toEqual({ scanned: 2, resumed: 0 });
    expect(redrive).not.toHaveBeenCalled();
  });

  it("only scans `running` ops (pending/succeeded are left to the normal worker)", async () => {
    const redrive = vi.fn(async () => undefined);
    const ops: FakeOpDoc[] = [
      { id: "op-pending", data: { status: "pending", kind: "rollout" } },
      { id: "op-done", data: { status: "succeeded", kind: "rollout" } },
      { id: "op-run", data: { status: "running", kind: "rollout" } },
    ];
    const result = await resumeOrphanedRunningOps({
      db: makeFakeDb(ops) as never,
      log: vi.fn(),
      resumableKinds: RESUMABLE,
      redrive,
    });
    expect(result).toEqual({ scanned: 1, resumed: 1 });
    expect(redrive).toHaveBeenCalledTimes(1);
  });

  it("a re-drive that throws is logged and does not abort the sweep", async () => {
    const redrive = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(undefined);
    const log = vi.fn();
    const ops: FakeOpDoc[] = [
      { id: "op-a", data: { status: "running", kind: "rollout" } },
      { id: "op-b", data: { status: "running", kind: "rollout" } },
    ];
    const result = await resumeOrphanedRunningOps({
      db: makeFakeDb(ops) as never,
      log,
      resumableKinds: RESUMABLE,
      redrive,
    });
    expect(result).toEqual({ scanned: 2, resumed: 1 });
    expect(redrive).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("op-a"));
  });
});
