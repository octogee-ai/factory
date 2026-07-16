import { describe, it, expect, vi } from "vitest";
import type { OperationStep } from "@octogee/shared/types/glm";
import { createOperationContext } from "../operation-context";

function makeDeps() {
  const persistedSnapshots: OperationStep[][] = [];
  const logCalls: string[] = [];
  return {
    persist: vi.fn(async (steps: OperationStep[]) => {
      persistedSnapshots.push(steps);
    }),
    log: (msg: string) => logCalls.push(msg),
    opId: "op-test-1",
    persistedSnapshots,
    logCalls,
  };
}

describe("createOperationContext", () => {
  it("persists migration V2 state and exposes cancellation without swallowing errors", async () => {
    const persistCustomerMigrationV2 = vi.fn(async () => undefined);
    const cancellationRequested = vi.fn(async () => true);
    const { ctx } = createOperationContext({
      ...makeDeps(),
      persistCustomerMigrationV2,
      cancellationRequested,
    });
    const migration = {
      phase: "initialized" as const,
      operationId: "op-1",
      migrationId: "mig-op-1",
      uid: "u1",
      slug: "alice",
      sourceGatewayId: "source",
      sourceRevisionId: "source-r1",
      sourceRelease: 1,
      sourceEpoch: 1,
      targetGatewayId: "target",
      targetRevisionId: "target-r1",
      targetRelease: 1,
      sourceImageTag: "image",
      sourceBuildSha: "build",
      sourceOpenclawVersion: "oc",
      targetImageTag: "target-image",
    };

    await ctx.persistCustomerMigrationV2?.(migration);

    expect(persistCustomerMigrationV2).toHaveBeenCalledWith(migration);
    await expect(ctx.cancellationRequested?.()).resolves.toBe(true);
  });
  it("appends the first running event as a new step", async () => {
    const deps = makeDeps();
    const { ctx, steps } = createOperationContext(deps);

    await ctx.reportStep({ name: "quiesce-source", status: "running", startedAt: 100 });

    expect(steps).toEqual([{ name: "quiesce-source", status: "running", startedAt: 100 }]);
  });

  it("collapses a matching done event onto the most recent running step of the same name", async () => {
    const deps = makeDeps();
    const { ctx, steps } = createOperationContext(deps);

    await ctx.reportStep({ name: "quiesce-source", status: "running", startedAt: 100 });
    await ctx.reportStep({ name: "quiesce-source", status: "done", completedAt: 200 });

    expect(steps).toEqual([
      { name: "quiesce-source", status: "done", startedAt: 100, completedAt: 200 },
    ]);
  });

  it("refreshes a matching running step without growing the operation step history", async () => {
    const deps = makeDeps();
    const { ctx, steps } = createOperationContext(deps);

    await ctx.reportStep({ name: "release-roll", status: "running", startedAt: 100 });
    await ctx.reportStep({ name: "release-roll", status: "running", startedAt: 100 });

    expect(steps).toEqual([{ name: "release-roll", status: "running", startedAt: 100 }]);
    expect(deps.persistedSnapshots).toHaveLength(2);
  });

  it("collapses a matching failed event onto the running step and preserves the error", async () => {
    const deps = makeDeps();
    const { ctx, steps } = createOperationContext(deps);

    await ctx.reportStep({ name: "transfer-state", status: "running", startedAt: 200 });
    await ctx.reportStep({
      name: "transfer-state",
      status: "failed",
      completedAt: 300,
      error: "503",
    });

    expect(steps).toEqual([
      {
        name: "transfer-state",
        status: "failed",
        startedAt: 200,
        completedAt: 300,
        error: "503",
      },
    ]);
  });

  it("treats rollback steps as separate entries — they never collapse onto forward-pass steps of the same suffix", async () => {
    const deps = makeDeps();
    const { ctx, steps } = createOperationContext(deps);

    await ctx.reportStep({ name: "quiesce-source", status: "running", startedAt: 100 });
    await ctx.reportStep({ name: "quiesce-source", status: "done", completedAt: 200 });
    await ctx.reportStep({ name: "rollback:quiesce-source", status: "running", startedAt: 300 });
    await ctx.reportStep({ name: "rollback:quiesce-source", status: "done", completedAt: 400 });

    expect(steps.map((s) => `${s.name}:${s.status}`)).toEqual([
      "quiesce-source:done",
      "rollback:quiesce-source:done",
    ]);
  });

  it("calls persist with a fresh array snapshot on every reportStep — never with a mutating reference", async () => {
    const deps = makeDeps();
    const { ctx } = createOperationContext(deps);

    await ctx.reportStep({ name: "quiesce-source", status: "running" });
    await ctx.reportStep({ name: "quiesce-source", status: "done" });

    expect(deps.persistedSnapshots).toHaveLength(2);
    expect(deps.persistedSnapshots[0]).not.toBe(deps.persistedSnapshots[1]);
    expect(deps.persistedSnapshots[0].map((s) => s.status)).toEqual(["running"]);
    expect(deps.persistedSnapshots[1].map((s) => s.status)).toEqual(["done"]);
  });

  it("logs but does not throw when persist fails — migration must not be aborted by Firestore hiccups", async () => {
    const persist = vi.fn(async () => {
      throw new Error("Firestore unavailable");
    });
    const logCalls: string[] = [];
    const { ctx } = createOperationContext({
      persist,
      log: (msg) => logCalls.push(msg),
      opId: "op-test-1",
    });

    await expect(
      ctx.reportStep({ name: "quiesce-source", status: "running" }),
    ).resolves.toBeUndefined();
    expect(logCalls.some((l) => l.includes("Firestore unavailable"))).toBe(true);
  });

  it("appends a new entry when the buffer has no in-progress step of the same name (e.g. duplicate done)", async () => {
    const deps = makeDeps();
    const { ctx, steps } = createOperationContext(deps);

await ctx.reportStep({ name: "quiesce-source", status: "done", completedAt: 200 });

    expect(steps).toEqual([{ name: "quiesce-source", status: "done", completedAt: 200 }]);
  });
});
