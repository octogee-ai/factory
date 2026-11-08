import { describe, expect, it, vi } from "vitest";
import { runForcedMigration } from "../ops/fleet-force-migration-executor.js";
import { forceMigrationHarness, forceMigrationTarget as target } from "./fleet-force-migration.test-support.js";

function setup() {
  const h = forceMigrationHarness();
  const bound = { podName: "shared-pod", podUid: "pod-uid", containerImage: "retained-recovery-image", beforeBootId: "boot-before" };
  const transport = {
    capture: vi.fn(async () => bound),
    dispatch: vi.fn(async () => {
      expect(h.docs.get("gateways/builder-a")?.runtimeRestartFence).toMatchObject({ phase: "dispatched", target: bound });
      expect(h.op().status).toBe("pending");
    }),
    observe: vi.fn(async (_bound: typeof bound, attemptId: string) => ({
      version: 1 as const, attemptId, beforeBootId: bound.beforeBootId, afterBootId: "boot-after", ready: true as const,
    })),
  };
  const run = () => runForcedMigration({ store: h.store, target, actor: "operator", transport, now: () => 1000 });
  return { ...h, bound, transport, run };
}

describe("synchronous Fleet force migration recovery", () => {
  it.each(["fresh", "completed", "dispatched"])("refuses a Shared %s force before audit, capture, or dispatch", async phase => {
    const h = setup();
    h.docs.get("gateways/builder-a")!.gatewayClass = "shared";
    if (phase !== "fresh") {
      h.op().forceDrainRequest = { auditId: "historical", requestedAt: 100,
        uid: "u1", sourceGatewayId: "builder-a", targetGatewayId: "shared-b", sourceEpoch: 75,
        ...(phase === "completed" ? { completedAt: 200 } : {}),
      };
      if (phase === "dispatched") h.docs.get("gateways/builder-a")!.runtimeRestartFence = {
        kind: "process", attemptId: "historical", auditId: "historical", gatewayId: "builder-a",
        operationId: "move-1", phase: "dispatched", target: h.bound,
      };
    }
    const before = structuredClone([...h.docs]);
    await expect(h.run()).rejects.toThrow("Shared sources cannot be restarted");
    expect([...h.docs]).toEqual(before);
    expect(h.transport.capture).not.toHaveBeenCalled();
    expect(h.transport.dispatch).not.toHaveBeenCalled();
    expect(h.transport.observe).not.toHaveBeenCalled();
    expect(h.writes).toEqual([]);
  });

  it("reports the unsupported GCE VM transport before auditing a Builder force", async () => {
    const h = setup();
    h.docs.get("gateways/builder-a")!.runtime = "gce-vm";
    await expect(h.run()).rejects.toThrow("GCE VM transport is not available");
    expect(h.transport.capture).not.toHaveBeenCalled();
    expect(h.writes).toEqual([]);
  });

  it("restarts once, preserves migration history, then atomically wakes the same pending operation", async () => {
    const h = setup();
    const original = structuredClone(h.op());
    const result = await h.run();
    expect(h.transport.dispatch).toHaveBeenCalledTimes(1);
    expect(h.transport.observe).toHaveBeenCalledTimes(1);
    expect(h.docs.get("gateways/builder-a")).not.toHaveProperty("runtimeRestartFence");
    expect(h.op()).toMatchObject({ ...original, nextAttemptAt: 1000, forceDrainRequest: { auditId: result.auditId, completedAt: 1000 } });
    expect([...h.docs.values()].filter(doc => doc.kind === "migrate-customer")).toHaveLength(1);
    await h.run();
    expect(h.transport.dispatch).toHaveBeenCalledTimes(1);
    expect(h.transport.observe).toHaveBeenCalledTimes(1);
  });

  it.each(["dispatch", "observe"] as const)("retains an uncertain %s and retries only observation", async phase => {
    const h = setup();
    h.transport[phase].mockRejectedValueOnce(new Error("unconfirmed native restart"));
    await expect(h.run()).rejects.toThrow("unconfirmed native restart");
    expect(h.docs.get("gateways/builder-a")?.runtimeRestartFence).toMatchObject({ phase: "dispatched", target: h.bound });
    expect(h.op().nextAttemptAt).toBe(9000);
    expect(h.op().forceDrainRequest.completedAt).toBeUndefined();
    await h.run();
    expect(h.transport.dispatch).toHaveBeenCalledTimes(1);
    expect(h.transport.capture).toHaveBeenCalledTimes(1);
    expect(h.docs.get("gateways/builder-a")).not.toHaveProperty("runtimeRestartFence");
  });

  it("does not clear a replacement fence or wake migration after proof", async () => {
    const h = setup();
    h.transport.observe.mockImplementationOnce(async (_bound, attemptId) => {
      h.docs.get("gateways/builder-a")!.runtimeRestartFence.attemptId = "foreign";
      return { version: 1, attemptId, beforeBootId: "boot-before", afterBootId: "boot-after", ready: true };
    });
    await expect(h.run()).rejects.toThrow();
    expect(h.docs.get("gateways/builder-a")?.runtimeRestartFence.attemptId).toBe("foreign");
    expect(h.op().nextAttemptAt).toBe(9000);
  });

  it("rejects unchanged boot proof without clearing the dispatched fence", async () => {
    const h = setup();
    h.transport.observe.mockImplementationOnce(async (_bound, attemptId) => ({
      version: 1, attemptId, beforeBootId: "boot-before", afterBootId: "boot-before", ready: true,
    }));
    await expect(h.run()).rejects.toThrow("unverified");
    expect(h.docs.get("gateways/builder-a")?.runtimeRestartFence.phase).toBe("dispatched");
  });
});
