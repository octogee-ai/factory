import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import {
  PLACEMENT_POLICY_MAX_ABANDONED_PASSES,
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

  it("caps abandoned passes and halts loudly instead of accumulating hung work", async () => {
    const log = vi.fn();
    const runPass = vi.fn().mockImplementation(() => new Promise<void>(() => undefined));
    const stop = startPlacementPolicyReconciler(loopDeps(log), PLACEMENT_POLICY_RECONCILE_MS_DEFAULT, { runPass });
    await vi.advanceTimersByTimeAsync(PLACEMENT_POLICY_PASS_DEADLINE_MS * 10);
    expect(runPass).toHaveBeenCalledTimes(PLACEMENT_POLICY_MAX_ABANDONED_PASSES);
    const halts = log.mock.calls.filter(([m]) => String(m).includes("halted"));
    expect(halts.length).toBe(1);
    stop();
  });

  it("resumes launching passes once an abandoned pass settles", async () => {
    const log = vi.fn();
    const releases: Array<() => void> = [];
    const runPass = vi.fn().mockImplementation(
      () => new Promise<void>((resolve) => { releases.push(resolve); }),
    );
    const stop = startPlacementPolicyReconciler(loopDeps(log), PLACEMENT_POLICY_RECONCILE_MS_DEFAULT, { runPass });
    await vi.advanceTimersByTimeAsync(PLACEMENT_POLICY_PASS_DEADLINE_MS * 10);
    expect(runPass).toHaveBeenCalledTimes(PLACEMENT_POLICY_MAX_ABANDONED_PASSES);
    releases[0]();
    await vi.advanceTimersByTimeAsync(PLACEMENT_POLICY_RECONCILE_MS_DEFAULT);
    expect(runPass).toHaveBeenCalledTimes(PLACEMENT_POLICY_MAX_ABANDONED_PASSES + 1);
    stop();
  });

  it("an abandoned pass can no longer publish idle sleep or send sleep warnings", async () => {
    const log = vi.fn();
    const publishIdleSleep = vi.fn().mockResolvedValue(undefined);
    const sendRuntimeSleepWarning = vi.fn().mockResolvedValue(undefined);
    const deps = {
      now: () => Date.now(),
      log,
      publishIdleSleep,
      sendRuntimeSleepWarning,
    } as unknown as PlacementPolicyReconcilerDeps;
    let resume: () => void = () => undefined;
    let fenced: PlacementPolicyReconcilerDeps | null = null;
    const runPass = vi.fn()
      .mockImplementationOnce((passDeps: PlacementPolicyReconcilerDeps) => {
        fenced = passDeps;
        return new Promise<void>((resolve) => { resume = resolve; });
      })
      .mockResolvedValue(undefined);
    const stop = startPlacementPolicyReconciler(deps, PLACEMENT_POLICY_RECONCILE_MS_DEFAULT, { runPass });
    await vi.advanceTimersByTimeAsync(PLACEMENT_POLICY_PASS_DEADLINE_MS + PLACEMENT_POLICY_RECONCILE_MS_DEFAULT);
    await fenced!.publishIdleSleep({ uid: "uid-x", projection: null });
    await fenced!.sendRuntimeSleepWarning({ uid: "uid-x" } as never);
    expect(publishIdleSleep).not.toHaveBeenCalled();
    expect(sendRuntimeSleepWarning).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("dropped idle-sleep publish"));
    resume();
    stop();
  });

  it("a live pass publishes idle sleep through the fence untouched", async () => {
    const log = vi.fn();
    const publishIdleSleep = vi.fn().mockResolvedValue(undefined);
    const deps = {
      now: () => Date.now(),
      log,
      publishIdleSleep,
      sendRuntimeSleepWarning: vi.fn().mockResolvedValue(undefined),
    } as unknown as PlacementPolicyReconcilerDeps;
    const runPass = vi.fn().mockImplementation(async (passDeps: PlacementPolicyReconcilerDeps) => {
      await passDeps.publishIdleSleep({ uid: "uid-live", projection: null });
    });
    const stop = startPlacementPolicyReconciler(deps, PLACEMENT_POLICY_RECONCILE_MS_DEFAULT, { runPass });
    await vi.advanceTimersByTimeAsync(0);
    expect(publishIdleSleep).toHaveBeenCalledWith({ uid: "uid-live", projection: null });
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
