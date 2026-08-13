import { describe, expect, it, vi } from "vitest";
import { MigrationTransportError, type MigrationClient } from "./fleet-migration-client.js";
import {
  advanceCustomerMigrationV2,
  beginCustomerMigrationV2Abort,
  classifyCustomerMigrationV2Error,
  customerMigrationV2GatewayRootFence,
  isCustomerMigrationV2PostIntent,
  isCustomerMigrationV2Transition,
  type CustomerMigrationV2Deps,
} from "./customer-migration-v2.js";
import type {
  CustomerMigrationV2Phase,
  CustomerMigrationV2State,
} from "@octogee/shared/types/glm";

const SOURCE_SYSTEM_CONFIG_COMMIT = "a".repeat(40);

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
    gatewayClass: "builder",
    ownerUid: "uid-1",
    builderSlug: "alice",
    configHash: gatewayId === "source" ? "1".repeat(64) : "2".repeat(64),
  };
}

function state(
  phase: CustomerMigrationV2State["phase"] = "initialized",
): CustomerMigrationV2State {
  const value: CustomerMigrationV2State = {
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
  if (["sourceQuiesced", "finalSynced", "targetVerified", "cutover", "sourceRetired", "complete"].includes(phase)) {
    value.sourceSystemConfigCommit = SOURCE_SYSTEM_CONFIG_COMMIT;
  }
  return value;
}

function deps(): CustomerMigrationV2Deps {
  const client = {
    transferState: vi.fn(async () => ({ migrationId: "mig-op-1", slug: "alice", imported: true })),
    restoreTarget: vi.fn(async () => ({ migrationId: "mig-op-1", slug: "alice", restored: true })),
    quiesce: vi.fn(async () => ({ migrationId: "mig-op-1", slug: "alice", drained: true, runningCount: 0 })),
    flushGateway: vi.fn(async () => ({
      migrationId: "mig-op-1",
      slug: "alice",
      ok: true,
      durationMs: 1,
      steps: [],
      systemConfigCommit: SOURCE_SYSTEM_CONFIG_COMMIT,
    })),
    verifyTarget: vi.fn(async () => ({ migrationId: "mig-op-1", slug: "alice", ready: true })),
    unmount: vi.fn(async () => ({ migrationId: "mig-op-1", slug: "alice", unmounted: true })),
  } as unknown as MigrationClient;
  return {
    client,
    setSourceAssignmentState: vi.fn(async () => undefined),
    commitCutover: vi.fn(async () => undefined),
    now: vi.fn(() => 1_000),
  };
}

describe("customerMigrationV2GatewayRootFence", () => {
  const root = (coOwnerUids: string[]) => ({
    gatewayId: "source",
    createdAt: 1,
    createdBy: "test",
    updatedAt: 10,
    updatedBy: "test",
    latestRelease: 1,
    desiredRelease: 1,
    liveRelease: 1,
    desiredStatus: "running",
    configSchemaVersion: 1,
    profile: "builder",
    gatewayClass: "builder",
    imageProfile: "builder",
    sizingTier: "l",
    gcpProject: null,
    gatewayContainerSecurityContext: null,
    serviceAccountName: null,
    serviceAccount: null,
    builderAccess: { shellsEnabled: true },
    ownerUid: "uid-1",
    builderSlug: "alice",
    openclawOverrides: null,
    modelBrokerLimits: null,
    preemption: null,
    allocation: null,
    coOwnerUids,
  });

  it("projects an empty retired co-owner mirror and rejects non-empty legacy authority", () => {
    expect(customerMigrationV2GatewayRootFence(root([]), "source")).toMatchObject({
      gatewayId: "source",
      ownerUid: "uid-1",
    });
    expect(customerMigrationV2GatewayRootFence(
      root(["uid-former-helper"]),
      "source",
    )).toBeNull();
  });
});

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
      "keysSynced", "preSynced", "sourceQuiesced",
      "finalSynced", "targetVerified", "cutover", "sourceRetired", "complete",
    ]);
    const client = d.client as unknown as Record<string, ReturnType<typeof vi.fn>>;
    expect(client.transferState.mock.calls.map((call) => call[0].mode)).toEqual([
      "keys", "pre", "final",
    ]);
    expect(client.transferState.mock.calls.map((call) => call[0])).toEqual([
      expect.objectContaining({
        mode: "keys",
        fromTransportId: "source",
        toTransportId: "target",
        includeActivationManifest: false,
      }),
      expect.objectContaining({
        mode: "pre",
        fromTransportId: "source",
        toTransportId: "target",
        includeActivationManifest: false,
      }),
      expect.objectContaining({
        mode: "final",
        fromTransportId: "source",
        toTransportId: "target",
        includeActivationManifest: true,
      }),
    ]);
    expect(client.restoreTarget).not.toHaveBeenCalled();
    expect(d.setSourceAssignmentState).toHaveBeenCalledWith("quiescing");
    expect(client.quiesce).toHaveBeenCalledWith(expect.objectContaining({
      gatewayId: "source",
      transportId: "source",
    }));
    expect(client.flushGateway.mock.calls.map((call) => call[0])).toEqual([
      {
        migrationId: "mig-op-1",
        gatewayId: "source",
        transportId: "source",
        slug: "alice",
        reason: "migration-final",
      },
      {
        migrationId: "mig-op-1",
        gatewayId: "target",
        transportId: "target",
        slug: "alice",
        reason: "migration-converge",
        expectedSystemConfigCommit: SOURCE_SYSTEM_CONFIG_COMMIT,
      },
    ]);
    expect(d.commitCutover).toHaveBeenCalledWith({
      strategy: "migrate-state",
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

    client.flushGateway.mockImplementation(async () => {
      order.push("source-flush");
      return {
        migrationId: "mig-op-1",
        slug: "alice",
        ok: true,
        durationMs: 1,
        steps: [],
        systemConfigCommit: SOURCE_SYSTEM_CONFIG_COMMIT,
      };
    });

    await advanceCustomerMigrationV2(state("preSynced"), d);

    expect(order).toEqual(["assignment-quiescing", "quiesce-rpc", "source-flush"]);
  });

  it("persists the source's exact accepted config commit before final transfer", async () => {
    const d = deps();

    await expect(advanceCustomerMigrationV2(state("preSynced"), d)).resolves.toMatchObject({
      phase: "sourceQuiesced",
      sourceSystemConfigCommit: SOURCE_SYSTEM_CONFIG_COMMIT,
    });
  });

  it.each([undefined, "not-a-commit"])(
    "fails closed when source flush does not prove an accepted config commit (%s)",
    async (systemConfigCommit) => {
      const d = deps();
      const client = d.client as unknown as Record<string, ReturnType<typeof vi.fn>>;
      client.flushGateway.mockResolvedValueOnce({
        migrationId: "mig-op-1",
        slug: "alice",
        ok: true,
        durationMs: 1,
        steps: [],
        ...(systemConfigCommit === undefined ? {} : { systemConfigCommit }),
      });

      await expect(advanceCustomerMigrationV2(state("preSynced"), d))
        .rejects.toThrow(/accepted system.config commit/iu);
    },
  );

  it("converges target config after final transfer and before target verification", async () => {
    const d = deps();
    const order: string[] = [];
    const client = d.client as unknown as Record<string, ReturnType<typeof vi.fn>>;
    client.transferState.mockImplementation(async () => {
      order.push("final-transfer");
      return { migrationId: "mig-op-1", slug: "alice", imported: true };
    });
    client.flushGateway.mockImplementation(async () => {
      order.push("target-flush");
      return { migrationId: "mig-op-1", slug: "alice", ok: true, durationMs: 1, steps: [] };
    });
    client.verifyTarget.mockImplementation(async () => {
      order.push("target-verify");
      return { migrationId: "mig-op-1", slug: "alice", ready: true };
    });

    const finalSynced = await advanceCustomerMigrationV2(state("sourceQuiesced"), d);
    await advanceCustomerMigrationV2(finalSynced, d);

    expect(order).toEqual(["final-transfer", "target-flush", "target-verify"]);
  });

  it.each([
    ["source", "preSynced" as const, "quiesce"],
    ["target", "sourceQuiesced" as const, "transferState"],
  ])("replays the %s handoff phase after a lost flush response", async (_name, phase, priorRpc) => {
    const d = deps();
    const client = d.client as unknown as Record<string, ReturnType<typeof vi.fn>>;
    client.flushGateway.mockRejectedValueOnce(new MigrationTransportError("flush response lost"));

    await expect(advanceCustomerMigrationV2(state(phase), d)).rejects.toThrow(/response lost/u);
    await expect(advanceCustomerMigrationV2(state(phase), d)).resolves.toBeDefined();

    expect(client.flushGateway).toHaveBeenCalledTimes(2);
    expect(client[priorRpc]).toHaveBeenCalledTimes(2);
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

  it("restores source serving before a retryable target-unmount failure can return", async () => {
    const d = deps();
    const client = d.client as unknown as Record<string, ReturnType<typeof vi.fn>>;
    client.unmount.mockRejectedValueOnce(new Error("target unavailable"));

    await expect(advanceCustomerMigrationV2(state("abortIntent"), d))
      .rejects.toThrow(/target unavailable/u);

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
      "initialized", "keysSynced", "preSynced", "sourceQuiesced",
      "finalSynced", "targetVerified", "cutover", "sourceRetired", "complete",
    ];
    for (let index = 0; index < forward.length - 1; index += 1) {
      expect(isCustomerMigrationV2Transition(forward[index], forward[index + 1])).toBe(true);
      expect(isCustomerMigrationV2Transition(forward[index], forward[index])).toBe(true);
    }
    expect(isCustomerMigrationV2Transition("initialized", "abortIntent")).toBe(false);
    expect(isCustomerMigrationV2Transition("targetVerified", "abortIntent")).toBe(true);
    expect(isCustomerMigrationV2Transition("initialized", "freshSourceQuiesced")).toBe(true);
    expect(isCustomerMigrationV2Transition("freshSourceQuiesced", "freshCutoverReady")).toBe(true);
    expect(isCustomerMigrationV2Transition("freshCutoverReady", "cutover")).toBe(true);
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
