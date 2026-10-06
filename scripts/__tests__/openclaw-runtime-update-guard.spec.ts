import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenClawRuntimeUpdateGuard } from "../lib/openclaw-runtime-update-guard.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("OpenClaw runtime update coordination", () => {
  afterEach(() => vi.useRealTimers());

  it("runs uncontended work without a timer and wakes immediately when repair finishes", async () => {
    vi.useFakeTimers();
    const guard = new OpenClawRuntimeUpdateGuard();
    await expect(guard.run(async () => "ready")).resolves.toBe("ready");
    expect(vi.getTimerCount()).toBe(0);
    const repair = deferred();
    const first = guard.tryRun(() => repair.promise)!;
    const imported = vi.fn(async () => "imported");
    const second = guard.run(imported);
    expect(imported).not.toHaveBeenCalled();
    expect(guard.tryRun(async () => "duplicate repair")).toBeUndefined();
    repair.resolve();
    await first;
    await expect(second).resolves.toBe("imported");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds an import wait without releasing the still-running repair", async () => {
    vi.useFakeTimers();
    const guard = new OpenClawRuntimeUpdateGuard();
    const repair = deferred();
    const first = guard.tryRun(() => repair.promise)!;
    const imported = vi.fn(async () => undefined);
    const waiting = expect(guard.run(imported)).rejects.toThrow("Timed out waiting");
    await vi.advanceTimersByTimeAsync(60_000);
    await waiting;
    expect(imported).not.toHaveBeenCalled();
    expect(guard.tryRun(imported)).toBeUndefined();
    repair.resolve();
    await first;
    await guard.run(imported);
    expect(imported).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a queued import before it starts", async () => {
    const guard = new OpenClawRuntimeUpdateGuard();
    const repair = deferred();
    const first = guard.tryRun(() => repair.promise)!;
    const controller = new AbortController();
    const imported = vi.fn(async () => undefined);
    const waiting = guard.run(imported, { signal: controller.signal });
    const reason = new Error("migration cancelled");
    controller.abort(reason);
    await expect(waiting).rejects.toBe(reason);
    repair.resolve();
    await first;
    expect(imported).not.toHaveBeenCalled();
  });

  it.each([false, true])("holds publication custody after work settles until its fingerprint tail ends (failed: %s)", async (failed) => {
    const guard = new OpenClawRuntimeUpdateGuard();
    const tail = deferred();
    const work = guard.run(async () => {
      if (failed) throw new Error("publication failed");
      return "published";
    }, { holdUntil: tail.promise });
    if (failed) await expect(work).rejects.toThrow("publication failed");
    else await expect(work).resolves.toBe("published");
    const exported = vi.fn(async () => "exported");
    const waiting = guard.run(exported);
    expect(exported).not.toHaveBeenCalled();
    expect(guard.tryRun(exported)).toBeUndefined();
    tail.resolve();
    await expect(waiting).resolves.toBe("exported");
  });

  it("does not release unfinished runtime work when its owner tail ends first", async () => {
    const guard = new OpenClawRuntimeUpdateGuard();
    const pending = deferred();
    const work = guard.run(() => pending.promise, { holdUntil: Promise.resolve() });
    const exported = vi.fn(async () => undefined);
    const waiting = guard.run(exported);
    await Promise.resolve();
    expect(exported).not.toHaveBeenCalled();
    pending.resolve();
    await work;
    await waiting;
    expect(exported).toHaveBeenCalledOnce();
  });

  it("releases failed work and gives a waiting import priority over background repair", async () => {
    const guard = new OpenClawRuntimeUpdateGuard();
    const repair = deferred();
    const first = guard.tryRun(async () => { await repair.promise; throw new Error("repair failed"); })!;
    const failure = expect(first).rejects.toThrow("repair failed");
    const imported = deferred();
    const second = guard.run(() => imported.promise);
    repair.resolve();
    await failure;
    expect(guard.tryRun(async () => undefined)).toBeUndefined();
    imported.resolve();
    await second;
    await expect(guard.tryRun(async () => "repaired")).resolves.toBe("repaired");
  });
});
