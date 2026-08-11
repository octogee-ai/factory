import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import {
  PLACEMENT_POLICY_PASS_DEADLINE_MS,
  PLACEMENT_POLICY_RECONCILE_MS_DEFAULT,
  startPlacementPolicyReconciler,
  type PlacementPolicyReconcilerDeps,
} from "../placement-policy-reconciler.js";

function loopDeps(log: (message: string) => void): PlacementPolicyReconcilerDeps {
  return {
    now: () => Date.now(),
    log,
  } as unknown as PlacementPolicyReconcilerDeps;
}

describe("placement policy tick watchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps single-flight for a slow pass under the deadline", async () => {
    const log = vi.fn();
    let release: () => void = () => undefined;
    const runPass = vi.fn().mockImplementation(
      () => new Promise<void>((resolve) => { release = resolve; }),
    );
    const stop = startPlacementPolicyReconciler(loopDeps(log), PLACEMENT_POLICY_RECONCILE_MS_DEFAULT, { runPass });
    await vi.advanceTimersByTimeAsync(PLACEMENT_POLICY_RECONCILE_MS_DEFAULT * 3);
    expect(runPass).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(PLACEMENT_POLICY_RECONCILE_MS_DEFAULT);
    expect(runPass).toHaveBeenCalledTimes(2);
    stop();
  });

  it("releases the gate and logs when a pass exceeds the deadline", async () => {
    const log = vi.fn();
    const hang = new Promise<void>(() => undefined);
    const runPass = vi.fn()
      .mockImplementationOnce(() => hang)
      .mockResolvedValue(undefined);
    const stop = startPlacementPolicyReconciler(loopDeps(log), PLACEMENT_POLICY_RECONCILE_MS_DEFAULT, { runPass });
    await vi.advanceTimersByTimeAsync(PLACEMENT_POLICY_PASS_DEADLINE_MS + PLACEMENT_POLICY_RECONCILE_MS_DEFAULT);
    expect(runPass.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("exceeded"));
    stop();
  });

  it("logs the overrun once, not on every held tick", async () => {
    const log = vi.fn();
    const runPass = vi.fn().mockImplementation(() => new Promise<void>(() => undefined));
    const stop = startPlacementPolicyReconciler(loopDeps(log), PLACEMENT_POLICY_RECONCILE_MS_DEFAULT, { runPass });
    await vi.advanceTimersByTimeAsync(PLACEMENT_POLICY_PASS_DEADLINE_MS * 3);
    const overruns = log.mock.calls.filter(([m]) => String(m).includes("exceeded"));
    // Every pass after a release hangs again in this test, so each abandoned
    // pass logs exactly one overrun — never one per held tick.
    expect(overruns.length).toBeLessThanOrEqual(3);
    expect(overruns.length).toBeGreaterThanOrEqual(1);
    stop();
  });

  it("logs when an abandoned pass eventually settles", async () => {
    const log = vi.fn();
    let release: () => void = () => undefined;
    const runPass = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }))
      .mockResolvedValue(undefined);
    const stop = startPlacementPolicyReconciler(loopDeps(log), PLACEMENT_POLICY_RECONCILE_MS_DEFAULT, { runPass });
    await vi.advanceTimersByTimeAsync(PLACEMENT_POLICY_PASS_DEADLINE_MS + PLACEMENT_POLICY_RECONCILE_MS_DEFAULT);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("exceeded"));
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("settled"));
    stop();
  });

  it("a settling abandoned pass does not clear a newer pass's gate", async () => {
    const log = vi.fn();
    let releaseFirst: () => void = () => undefined;
    const second = new Promise<void>(() => undefined);
    const runPass = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => { releaseFirst = resolve; }))
      .mockImplementationOnce(() => second)
      .mockResolvedValue(undefined);
    const stop = startPlacementPolicyReconciler(loopDeps(log), PLACEMENT_POLICY_RECONCILE_MS_DEFAULT, { runPass });
    await vi.advanceTimersByTimeAsync(PLACEMENT_POLICY_PASS_DEADLINE_MS + PLACEMENT_POLICY_RECONCILE_MS_DEFAULT);
    expect(runPass).toHaveBeenCalledTimes(2);
    releaseFirst();
    await vi.advanceTimersByTimeAsync(PLACEMENT_POLICY_RECONCILE_MS_DEFAULT);
    // Pass 2 is under its own deadline and still running — the settled pass 1
    // must not have re-opened the gate for pass 3.
    expect(runPass).toHaveBeenCalledTimes(2);
    stop();
  });

  it("stop() cancels future ticks", async () => {
    const log = vi.fn();
    const runPass = vi.fn().mockResolvedValue(undefined);
    const stop = startPlacementPolicyReconciler(loopDeps(log), PLACEMENT_POLICY_RECONCILE_MS_DEFAULT, { runPass });
    await vi.advanceTimersByTimeAsync(0);
    stop();
    await vi.advanceTimersByTimeAsync(PLACEMENT_POLICY_RECONCILE_MS_DEFAULT * 5);
    expect(runPass).toHaveBeenCalledTimes(1);
  });
});
