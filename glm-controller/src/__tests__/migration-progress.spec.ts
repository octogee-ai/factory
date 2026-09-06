import { describe, expect, it, vi } from "vitest";
import { createMigrationProgress } from "../migration-progress.js";

describe("destination migration progress", () => {
  it("reports source work on the destination with elapsed time and propagates work failures", async () => {
    let now = 10;
    const send = vi.fn();
    const progress = createMigrationProgress({ send, log: vi.fn(), now: () => now });
    await progress.run("quiesce-source", async () => { now = 37; });
    expect(send.mock.calls.map(([event]) => event)).toEqual([
      { phase: "quiesce-source", status: "running", elapsedMs: 0 },
      { phase: "quiesce-source", status: "done", elapsedMs: 27 },
    ]);
    const error = new Error("source did not drain");
    await expect(progress.run("copy-state", async () => { throw error; })).rejects.toBe(error);
    expect(send).toHaveBeenLastCalledWith({ phase: "copy-state", status: "failed", elapsedMs: 0 });
  });
  it("keeps working and logs progress locally after one forwarding failure", async () => {
    const send = vi.fn().mockRejectedValue(new Error("destination offline"));
    const log = vi.fn();
    const action = vi.fn().mockResolvedValue("copied");
    const progress = createMigrationProgress({ send, log, now: () => 1 });
    await expect(progress.run("copy-state", action)).resolves.toBe("copied");
    expect(action).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("destination offline"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"status":"done"'));
  });
});
