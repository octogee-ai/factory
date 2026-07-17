import { describe, expect, it, vi } from "vitest";
import { MigrationTransportError, type MigrationClient } from "./fleet-migration-client.js";
import {
  advanceCustomerMigrationV2,
  beginCustomerMigrationV2Abort,
  classifyCustomerMigrationV2Error,
  isCustomerMigrationV2PostIntent,
  isCustomerMigrationV2Transition,
  type CustomerMigrationV2Deps,
} from "./customer-migration-v2.js";
import type {
  CustomerMigrationV2Phase,
  CustomerMigrationV2State,
} from "@octogee/shared/types/glm";

function gatewayRootFence(
  gatewayId: string,
  release: number,
): CustomerMigrationV2State["sourceRootFence"] {
  return {
    gatewayId,
    updatedAt: release * 10,
    latestRelease: release,
    desiredRelease: release,
    liveRelease: release,
    gatewayClass: "operator",
    ownerUid: "uid-1",
    builderSlug: "alice",
    configHash: gatewayId === "source" ? "1".repeat(64) : "2".repeat(64),
  };
}

function state(
  phase: CustomerMigrationV2State["phase"] = "initialized",
): CustomerMigrationV2State {
  return {
    phase,
    operationId: "op-1",
    migrationId: "mig-op-1",
    uid: "uid-1",
    slug: "alice",
    sourceGatewayId: "source",
    sourceRelease: 1,
    sourceEpoch: 7,
    sourceAssignmentMode: "assigned",
    sourceRootFence: gatewayRootFence("source", 1),
    targetGatewayId: "target",
    targetRelease: 3,
    targetRootFence: gatewayRootFence("target", 3),
  };
}

function deps(): CustomerMigrationV2Deps {
  const client = {
    transferState: vi.fn(async () => ({ migrationId: "mig-op-1", slug: "alice", imported: true })),
    restoreTarget: vi.fn(async () => ({ migrationId: "mig-op-1", slug: "alice", restored: true })),
    quiesce: vi.fn(async () => ({ migrationId: "mig-op-1", slug: "alice", drained: true, runningCount: 0 })),
    verifyTarget: vi.fn(async () => ({ migrationId: "mig-op-1", slug: "alice", ready: true })),
    unmount: vi.fn(async () => ({ migrationId: "mig-op-1", slug: "alice", unmounted: true })),
    flushGateway: vi.fn(),
  } as unknown as MigrationClient;
  return {
    client,
    restoreSnapshot: { uid: "uid-1" } as never,
    setSourceAssignmentState: vi.fn(async () => undefined),
    commitCutover: vi.fn(async () => undefined),
    now: vi.fn(() => 1_000),
  };
}

describe("advanceCustomerMigrationV2", () => {
  it("drives the lean data-plane migration with no config-protocol steps", async () => {
    const d = deps();
    let current = state();
    const phases: string[] = [];
    while (current.phase !== "complete") {
      current = await advanceCustomerMigrationV2(current, d);
      phases.push(current.phase);
    }

    expect(phases).toEqual([
      "keysSynced", "targetRestored", "preSynced", "sourceQuiesced",
      "finalSynced", "targetVerified", "cutover", "sourceRetired", "complete",
    ]);
    const client = d.client as unknown as Record<string, ReturnType<typeof vi.fn>>;
    expect(client.transferState.mock.calls.map((call) => call[0].mode)).toEqual([
      "keys", "pre", "final",
    ]);
    expect(client.transferState).toHaveBeenCalledWith(expect.objectContaining({
      fromTransportId: "source",
      toTransportId: "target",
      includeActivationManifest: true,
    }));
    expect(client.restoreTarget).toHaveBeenCalledWith(expect.objectContaining({
      gatewayId: "target",
      transportId: "target",
      uid: "uid-1",
    }));
    expect(d.setSourceAssignmentState).toHaveBeenCalledWith("quiescing");
    expect(client.quiesce).toHaveBeenCalledWith(expect.objectContaining({
      gatewayId: "source",
      transportId: "source",
    }));
    expect(d.commitCutover).toHaveBeenCalledWith({
      operationId: "op-1",
      migrationId: "mig-op-1",
      sourceGatewayId: "source",
      sourceEpoch: 7,
      sourceRelease: 1,
      sourceAssignmentMode: "assigned",
      sourceRootFence: gatewayRootFence("source", 1),
      targetGatewayId: "target",
      targetRelease: 3,
      targetRootFence: gatewayRootFence("target", 3),
    });
    expect(client.unmount).toHaveBeenCalledWith(expect.objectContaining({
      gatewayId: "source",
      transportId: "source",
    }));
    expect(Object.keys(client).every((name) => !/config/iu.test(name))).toBe(true);
  });

  it("marks the source quiescing before the quiesce RPC so the edge blocks first", async () => {
    const d = deps();
    const order: string[] = [];
    (d.setSourceAssignmentState as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push("assignment-quiescing");
    });
    const client = d.client as unknown as Record<string, ReturnType<typeof vi.fn>>;
    client.quiesce.mockImplementation(async () => {
      order.push("quiesce-rpc");
      return { migrationId: "mig-op-1", slug: "alice", drained: true, runningCount: 0 };
    });

    await advanceCustomerMigrationV2(state("preSynced"), d);

    expect(order).toEqual(["assignment-quiescing", "quiesce-rpc"]);
  });

  it("advances state only after the RPC response so a lost response is reissued", async () => {
    const d = deps();
    const client = d.client as unknown as Record<string, ReturnType<typeof vi.fn>>;
    client.transferState.mockRejectedValueOnce(new MigrationTransportError("response lost"));

    await expect(advanceCustomerMigrationV2(state("initialized"), d)).rejects.toThrow(
      /response lost/u,
    );
    const retried = await advanceCustomerMigrationV2(state("initialized"), d);
    expect(retried.phase).toBe("keysSynced");
    expect(client.transferState).toHaveBeenCalledTimes(2);
  });

  it("refuses to restore without a durable snapshot", async () => {
    const d = deps();
    delete (d as { restoreSnapshot?: unknown }).restoreSnapshot;

    await expect(advanceCustomerMigrationV2(state("keysSynced"), d)).rejects.toThrow(
      /durable snapshot/u,
    );
  });

  it("drives the abort path: unmount target, restore source serving", async () => {
    const d = deps();
    let current = state("abortIntent");
    current = await advanceCustomerMigrationV2(current, d);
    expect(current.phase).toBe("abortTargetUnmounted");
    const client = d.client as unknown as Record<string, ReturnType<typeof vi.fn>>;
    expect(client.unmount).toHaveBeenCalledWith(expect.objectContaining({
      gatewayId: "target",
      transportId: "target",
    }));

    current = await advanceCustomerMigrationV2(current, d);
    expect(current.phase).toBe("aborted");
    expect(current.abortedAt).toBe(1_000);
    expect(d.setSourceAssignmentState).toHaveBeenCalledWith("serving");
  });
});

describe("customer migration V2 failure boundary", () => {
  it("persists abort intent before cutover and never aborts after it", () => {
    const aborted = beginCustomerMigrationV2Abort(state("finalSynced"), "target broke", 42);
    expect(aborted).toMatchObject({
      phase: "abortIntent",
      abortFromPhase: "finalSynced",
      abortReason: "target broke",
      abortIntentAt: 42,
    });

    expect(() => beginCustomerMigrationV2Abort(state("initialized"), "nothing durable", 42))
      .toThrow(/no durable target footprint/u);
    for (const phase of ["cutover", "sourceRetired", "complete"] as const) {
      expect(isCustomerMigrationV2PostIntent(state(phase))).toBe(true);
      expect(() => beginCustomerMigrationV2Abort(state(phase), "too late", 42))
        .toThrow(/must roll forward/u);
    }
    const alreadyAborting = state("abortIntent");
    expect(beginCustomerMigrationV2Abort(alreadyAborting, "again", 42)).toBe(alreadyAborting);
  });

  it("accepts only the next durable phase or the legal pre-cutover abort branch", () => {
    const forward: CustomerMigrationV2Phase[] = [
      "initialized", "keysSynced", "targetRestored", "preSynced", "sourceQuiesced",
      "finalSynced", "targetVerified", "cutover", "sourceRetired", "complete",
    ];
    for (let index = 0; index < forward.length - 1; index += 1) {
      expect(isCustomerMigrationV2Transition(forward[index], forward[index + 1])).toBe(true);
      expect(isCustomerMigrationV2Transition(forward[index], forward[index])).toBe(true);
    }
    expect(isCustomerMigrationV2Transition("keysSynced", "preSynced")).toBe(false);
    expect(isCustomerMigrationV2Transition("initialized", "abortIntent")).toBe(false);
    expect(isCustomerMigrationV2Transition("targetVerified", "abortIntent")).toBe(true);
    expect(isCustomerMigrationV2Transition("cutover", "abortIntent")).toBe(false);
    expect(isCustomerMigrationV2Transition("abortIntent", "abortTargetUnmounted")).toBe(true);
    expect(isCustomerMigrationV2Transition("abortTargetUnmounted", "aborted")).toBe(true);
  });
});

describe("classifyCustomerMigrationV2Error", () => {
  it("classifies transport loss and server unavailability as retry", () => {
    expect(classifyCustomerMigrationV2Error(new MigrationTransportError("fetch failed"))).toBe("retry");
    expect(classifyCustomerMigrationV2Error({ status: 503 })).toBe("retry");
    expect(classifyCustomerMigrationV2Error({ status: 429 })).toBe("retry");
    expect(classifyCustomerMigrationV2Error({ code: "ECONNRESET" })).toBe("retry");
    expect(classifyCustomerMigrationV2Error(new Error("socket hang up"))).toBe("retry");
  });

  it("classifies definitive rejections as terminal", () => {
    expect(classifyCustomerMigrationV2Error({ status: 400 })).toBe("terminal");
    expect(classifyCustomerMigrationV2Error({ status: 409 })).toBe("terminal");
    expect(classifyCustomerMigrationV2Error(new Error("target verify failed checks"))).toBe("terminal");
  });
});
