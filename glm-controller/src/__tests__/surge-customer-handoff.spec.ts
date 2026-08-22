import { describe, expect, it, vi } from "vitest";
import {
  reconcileSurgeCustomerHandoff,
  assertSurgeAssignmentCoverage,
  SurgeOpenClawProcessEndpointMissingError,
  type SurgeAssignment,
  type SurgeCustomerHandoffDeps,
  type SurgePod,
  type SurgePodHealth,
} from "../surge-customer-handoff.js";
import { decideRollStateMigration } from "../roll-state-migration.js";
import type { OperationStatus } from "@octogee/shared/types/glm";

const MIGRATE_STATE = decideRollStateMigration({
  sourceOpenclawVersion: "2026.7.2-beta.7",
  targetOpenclawVersion: "2026.7.2-beta.7",
});
const PROVISION_FRESH = decideRollStateMigration({
  sourceOpenclawVersion: "2026.7.1",
  targetOpenclawVersion: "2026.7.2-beta.7",
});

const oldPod: SurgePod = {
  uid: "old-uid",
  name: "gateway-old",
  podIP: "10.0.0.1",
  ready: true,
  terminating: false,
};
const targetPod: SurgePod = {
  uid: "target-uid",
  name: "gateway-new",
  podIP: "10.0.0.2",
  ready: false,
  terminating: false,
};
const abandonedPodUid = "11111111-2222-4333-8444-555555555555";
const abandonedOperationId = `surge-default-${abandonedPodUid}`;
const otherGatewayOperationId = `surge-default-blue-${abandonedPodUid}`;

function assignment(
  uid: string,
  slug: string,
  overrides: Partial<SurgeAssignment> = {},
): SurgeAssignment {
  return {
    uid,
    slug,
    state: "serving",
    epoch: 1,
    updatedByOperationId: null,
    ...overrides,
  };
}

function harness(input: {
  pods?: SurgePod[];
  observedPodUids?: string[];
  assignments?: SurgeAssignment[];
  targetReleased?: boolean;
  transferError?: Error;
  transferErrorSlug?: string;
  discardError?: Error;
  markErrorUid?: string;
  releaseErrorBeforeCommit?: Error;
  releaseErrorAfterCommit?: Error;
  targetVersion?: string;
  sourceMountedCustomers?: string[];
  targetMountedCustomers?: string[];
  ownerOperations?: Record<string, { status: OperationStatus } | null>;
  bootingUids?: string[];
  prelaunchByUid?: Record<string, SurgePodHealth["prelaunchState"]>;
  fleetSignatureCapabilityByUid?: Record<string, SurgePodHealth["fleetSignatureCapability"]>;
  resumeSourceError?: Error;
  stopSourceError?: Error;
  stopSourceLegacy?: boolean;
  holdTargetError?: Error;
  holdTargetErrorFromCall?: number;
} = {}) {
  const events: string[] = [];
  let assignments = input.assignments ?? [assignment("u1", "alice"), assignment("u2", "bob")];
  let targetReleased = input.targetReleased === true;
  let sourceHeld = false;
  const operationId = "surge-default-target-uid";
  const deps: SurgeCustomerHandoffDeps = {
    listPods: vi.fn(async () => {
      const pods = input.pods ?? [oldPod, targetPod];
      return {
        pods,
        observedPodUids: input.observedPodUids ?? pods.map((pod) => pod.uid),
      };
    }),
    readPodHealth: vi.fn(async (pod) => ({
      status: input.bootingUids?.includes(pod.uid) ? "booting" as const : "ready" as const,
      version: pod.uid === targetPod.uid ? input.targetVersion ?? "new-sha" : "old-sha",
      fleetSignatureCapability: input.fleetSignatureCapabilityByUid?.[pod.uid] ?? "gateway-scoped",
      handoffReleased: pod.uid === targetPod.uid && targetReleased,
      prelaunchState: input.prelaunchByUid?.[pod.uid] ??
        (pod.uid !== targetPod.uid && sourceHeld ? "held" : "none"),
      mountedCustomers: pod.uid === targetPod.uid
        ? input.targetMountedCustomers ?? []
        : input.sourceMountedCustomers ?? assignments.map((item) => item.slug),
    })),
    stopSourceOpenClaw: vi.fn(async ({ sourcePod, slug }) => {
      events.push(`stop-source:${sourcePod.uid}:${slug}`);
      if (input.stopSourceLegacy) {
        throw new SurgeOpenClawProcessEndpointMissingError(
          `pod ${sourcePod.name} lacks the required surge OpenClaw hold endpoint`,
        );
      }
      if (input.stopSourceError) throw input.stopSourceError;
      sourceHeld = true;
    }),
    resumeSourceOpenClaw: vi.fn(async ({ sourcePod, slug }) => {
      events.push(`resume-source:${sourcePod.uid}:${slug}`);
      if (input.resumeSourceError) throw input.resumeSourceError;
      sourceHeld = false;
    }),
    holdTargetOpenClaw: vi.fn(async ({ targetPod: pod, slug }) => {
      events.push(`hold-target:${pod.uid}:${slug}`);
      const call = events.filter((event) => event.startsWith("hold-target:")).length;
      if (input.holdTargetError && call >= (input.holdTargetErrorFromCall ?? 1)) {
        throw input.holdTargetError;
      }
    }),
    unreserveTargetOpenClaw: vi.fn(async ({ targetPod: pod, slug }) => {
      events.push(`unreserve-target:${pod.uid}:${slug}`);
    }),
    readAssignments: vi.fn(async () => assignments),
    markAssignment: vi.fn(async ({ uid, state, updatedByOperationId, expected }) => {
      events.push(`assignment:${uid}:${state}`);
      if (input.markErrorUid === uid && state === "quiescing") {
        throw new Error("assignment write failed");
      }
      const current = assignments.find((item) => item.uid === uid);
      if (
        current?.state !== expected.state ||
        current.updatedByOperationId !== expected.updatedByOperationId
      ) {
        throw new Error("assignment ownership changed");
      }
      assignments = assignments.map((item) => item.uid === uid
        ? { ...item, state, updatedByOperationId }
        : item);
    }),
    quiesce: vi.fn(async ({ slug }) => {
      events.push(`quiesce:${slug}`);
    }),
    flush: vi.fn(async ({ pod, slug, reason }) => {
      events.push(`flush:${pod.uid}:${slug}:${reason}`);
      return reason === "migration-final"
        ? { systemConfigCommit: "a".repeat(40) }
        : {};
    }),
    transfer: vi.fn(async ({ slug }) => {
      events.push(`transfer:${slug}`);
      if (input.transferError && (!input.transferErrorSlug || input.transferErrorSlug === slug)) {
        throw input.transferError;
      }
    }),
    discardTargetCustomer: vi.fn(async ({ slug }) => {
      events.push(`discard:${slug}`);
      if (input.discardError) throw input.discardError;
    }),
    readDurableSessionDigest: vi.fn(async ({ pod, slug }) => {
      events.push(`digest:${pod.uid}:${slug}`);
      return { fileCount: 2, totalBytes: 20, sha256: "a".repeat(64) };
    }),
    releaseTarget: vi.fn(async ({ pod }) => {
      events.push(`release:${pod.uid}`);
      if (input.releaseErrorBeforeCommit) throw input.releaseErrorBeforeCommit;
      if (input.releaseErrorAfterCommit) {
        targetReleased = true;
        throw input.releaseErrorAfterCommit;
      }
      targetReleased = true;
    }),
    readOwnerOperation: vi.fn(async (id: string) => (
      input.ownerOperations && id in input.ownerOperations
        ? input.ownerOperations[id]
        : { status: "running" as OperationStatus }
    )),
    log: vi.fn(),
  };
  return {
    deps,
    events,
    assignments: () => assignments,
    operationId,
    setTargetReleased: (released: boolean) => {
      targetReleased = released;
    },
  };
}

describe("surge customer handoff", () => {
  it("rejects the ambiguous short heartbeat for a pinned OpenClaw image tag", async () => {
    const h = harness({
      pods: [{ ...targetPod, ready: true }],
      assignments: [],
      targetVersion: "27b966b",
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "27b966b-oc2026.7.1",
      requiresCustomerMigration: false,
      stateMigration: MIGRATE_STATE,
    })).resolves.toEqual({ ready: false });
  });

  it("refuses to hand off a user mirror that has no exact assignment document", () => {
    expect(() => assertSurgeAssignmentCoverage(
      [assignment("u1", "alice")],
      [{ uid: "u1", slug: "alice" }, { uid: "u2", slug: "bob" }],
    )).toThrow(/missing assignment.*u2\/bob/);
    expect(() => assertSurgeAssignmentCoverage(
      [assignment("u1", "alice")],
      [{ uid: "u1", slug: "alice" }],
    )).not.toThrow();
  });

  it("leaves a healthy first-install pod for pod-side self-release", async () => {
    const h = harness({ pods: [targetPod], assignments: [] });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: false,
      stateMigration: MIGRATE_STATE,
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual([]);
  });

  it("finalizes a Builder source as quiesce, flush, reserve target, stop source, copy, verify", async () => {
    const h = harness({ assignments: [assignment("u1", "alice")] });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: false,
      disposableBuilderGateway: true,
      stateMigration: MIGRATE_STATE,
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual([
      "assignment:u1:quiescing",
      "quiesce:alice",
      "flush:old-uid:alice:migration-final",
      "hold-target:target-uid:alice",
      "stop-source:old-uid:alice",
      "transfer:alice",
      "digest:old-uid:alice",
      "digest:target-uid:alice",
      "release:target-uid",
    ]);
    expect(h.deps.transfer).toHaveBeenCalledWith(expect.objectContaining({
      loadStrategy: "standard",
      configTransferMode: "configured-builder-system-config",
      expectedSystemConfigCommit: "a".repeat(40),
    }));
  });

  it("uses the expedited load only for a terminating disposable-gateway source", async () => {
    const h = harness({
      pods: [{ ...oldPod, ready: false, terminating: true }, targetPod],
      assignments: [assignment("u1", "alice")],
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: false,
      disposableBuilderGateway: true,
      stateMigration: MIGRATE_STATE,
    })).resolves.toEqual({ ready: false });

    expect(h.deps.transfer).toHaveBeenCalledWith(expect.objectContaining({
      loadStrategy: "expedited",
      configTransferMode: "configured-builder-system-config",
    }));
  });

  it("rolls back a failed Builder handoff by holding the target, resuming the source, then reopening", async () => {
    const h = harness({
      assignments: [assignment("u1", "alice")],
      transferError: new Error("configured Builder durable path is invalid"),
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: false,
      disposableBuilderGateway: true,
      stateMigration: MIGRATE_STATE,
    })).rejects.toThrow("configured Builder durable path is invalid");

    expect(h.events).toEqual([
      "assignment:u1:quiescing",
      "quiesce:alice",
      "flush:old-uid:alice:migration-final",
      "hold-target:target-uid:alice",
      "stop-source:old-uid:alice",
      "transfer:alice",
      "hold-target:target-uid:alice",
      "resume-source:old-uid:alice",
      "assignment:u1:serving",
    ]);
    expect(h.deps.discardTargetCustomer).not.toHaveBeenCalled();
    expect(h.deps.releaseTarget).not.toHaveBeenCalled();
    expect(h.assignments()).toEqual([
      expect.objectContaining({ state: "serving", updatedByOperationId: h.operationId }),
    ]);
  });

  it("keeps the roster gated when a Builder rollback cannot resume its source", async () => {
    const h = harness({
      assignments: [assignment("u1", "alice")],
      transferError: new Error("rsync failed"),
      resumeSourceError: new Error("source resume refused"),
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: false,
      disposableBuilderGateway: true,
      stateMigration: MIGRATE_STATE,
    })).rejects.toThrow("configured Builder handoff failed and its source could not be resumed");

    expect(h.events).toEqual([
      "assignment:u1:quiescing",
      "quiesce:alice",
      "flush:old-uid:alice:migration-final",
      "hold-target:target-uid:alice",
      "stop-source:old-uid:alice",
      "transfer:alice",
      "hold-target:target-uid:alice",
      "resume-source:old-uid:alice",
    ]);
    expect(h.assignments()).toEqual([
      expect.objectContaining({ state: "quiescing", updatedByOperationId: h.operationId }),
    ]);
  });

  it("copies from a quiesced legacy source that predates the OpenClaw process gate", async () => {
    const h = harness({
      assignments: [assignment("u1", "alice")],
      stopSourceLegacy: true,
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: false,
      disposableBuilderGateway: true,
      stateMigration: MIGRATE_STATE,
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual([
      "assignment:u1:quiescing",
      "quiesce:alice",
      "flush:old-uid:alice:migration-final",
      "hold-target:target-uid:alice",
      "stop-source:old-uid:alice",
      "transfer:alice",
      "digest:old-uid:alice",
      "digest:target-uid:alice",
      "release:target-uid",
    ]);
    expect(h.deps.resumeSourceOpenClaw).not.toHaveBeenCalled();
    expect(h.deps.log).toHaveBeenCalledWith(
      expect.stringContaining("predates the OpenClaw process gate"),
    );
  });

  it("restores the roster without a resume when the source stop never landed", async () => {
    const h = harness({
      assignments: [assignment("u1", "alice")],
      stopSourceError: new Error("source pod connection reset"),
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: false,
      disposableBuilderGateway: true,
      stateMigration: MIGRATE_STATE,
    })).rejects.toThrow("source pod connection reset");

    expect(h.events).toEqual([
      "assignment:u1:quiescing",
      "quiesce:alice",
      "flush:old-uid:alice:migration-final",
      "hold-target:target-uid:alice",
      "stop-source:old-uid:alice",
      "assignment:u1:serving",
    ]);
    expect(h.deps.transfer).not.toHaveBeenCalled();
    expect(h.deps.resumeSourceOpenClaw).not.toHaveBeenCalled();
    expect(h.assignments()).toEqual([
      expect.objectContaining({ state: "serving", updatedByOperationId: h.operationId }),
    ]);
  });

  it("still resumes the source when the rollback target hold fails", async () => {
    const h = harness({
      assignments: [assignment("u1", "alice")],
      transferError: new Error("rsync failed"),
      holdTargetError: new Error("target unreachable"),
      holdTargetErrorFromCall: 2,
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: false,
      disposableBuilderGateway: true,
      stateMigration: MIGRATE_STATE,
    })).rejects.toThrow("rsync failed");

    expect(h.events).toContain("resume-source:old-uid:alice");
    expect(h.events.at(-1)).toBe("assignment:u1:serving");
    expect(h.deps.log).toHaveBeenCalledWith(
      expect.stringContaining("rollback target hold failed"),
    );
  });

  it("keeps a terminating shared-gateway source on the standard load", async () => {
    const h = harness({
      pods: [{ ...oldPod, ready: false, terminating: true }, targetPod],
      assignments: [assignment("u1", "alice")],
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: false,
      disposableBuilderGateway: false,
      stateMigration: MIGRATE_STATE,
    })).resolves.toEqual({ ready: false });

    expect(h.deps.transfer).toHaveBeenCalledWith(expect.objectContaining({
      loadStrategy: "standard",
      configTransferMode: "activation-manifest",
    }));
  });

  it("selects a replacement that reports the complete OpenClaw-qualified image tag", async () => {
    const h = harness({
      assignments: [assignment("u1", "alice")],
      targetVersion: "cf36a88-oc2026.7.1",
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "cf36a88-oc2026.7.1",
      requiresCustomerMigration: true,
      stateMigration: MIGRATE_STATE,
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual([
      "assignment:u1:quiescing",
      "quiesce:alice",
      "transfer:alice",
      "digest:old-uid:alice",
      "digest:target-uid:alice",
      "release:target-uid",
    ]);
  });

  it("gates each assignment only when its serial transfer begins", async () => {
    const h = harness();

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      stateMigration: MIGRATE_STATE,
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual([
      "assignment:u1:quiescing",
      "quiesce:alice",
      "transfer:alice",
      "digest:old-uid:alice",
      "digest:target-uid:alice",
      "assignment:u2:quiescing",
      "quiesce:bob",
      "transfer:bob",
      "digest:old-uid:bob",
      "digest:target-uid:bob",
      "release:target-uid",
    ]);
    expect(h.assignments().every((item) => item.updatedByOperationId === h.operationId)).toBe(true);
  });

  it("carries no state across an openclaw version change — gates, then releases a blank target", async () => {
    const h = harness();

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      stateMigration: PROVISION_FRESH,
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual([
      "assignment:u1:quiescing",
      "assignment:u2:quiescing",
      "release:target-uid",
    ]);
    expect(h.deps.quiesce).not.toHaveBeenCalled();
    expect(h.deps.transfer).not.toHaveBeenCalled();
    expect(h.deps.readDurableSessionDigest).not.toHaveBeenCalled();
    expect(h.deps.log).toHaveBeenCalledWith(expect.stringContaining(PROVISION_FRESH.reason));
  });

  it("restores the roster to serving once the blank replacement is the only pod", async () => {
    const pods = [oldPod, targetPod];
    const h = harness({
      pods,
      assignments: [assignment("u1", "alice")],
      targetMountedCustomers: ["alice"],
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      stateMigration: PROVISION_FRESH,
    })).resolves.toEqual({ ready: false });

    pods.splice(0, pods.length, { ...targetPod, ready: true });
    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      stateMigration: PROVISION_FRESH,
    })).resolves.toEqual({ ready: true });

    expect(h.events).toEqual([
      "assignment:u1:quiescing",
      "release:target-uid",
      "assignment:u1:serving",
    ]);
  });

  it("gates but does not transfer an assigned customer that the source never mounted", async () => {
    const pods = [oldPod, targetPod];
    const targetMountedCustomers: string[] = [];
    const h = harness({
      pods,
      assignments: [
        assignment("u1", "alice"),
        assignment("u2", "posthog-smoke-v0"),
      ],
      sourceMountedCustomers: ["alice"],
      targetMountedCustomers,
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      stateMigration: MIGRATE_STATE,
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual([
      "assignment:u1:quiescing",
      "quiesce:alice",
      "transfer:alice",
      "digest:old-uid:alice",
      "digest:target-uid:alice",
      "assignment:u2:quiescing",
      "release:target-uid",
    ]);

    pods.splice(0, pods.length, { ...targetPod, ready: true });
    targetMountedCustomers.push("alice", "posthog-smoke-v0");
    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      stateMigration: MIGRATE_STATE,
    })).resolves.toEqual({ ready: true });
    expect(h.events.slice(-2)).toEqual([
      "assignment:u1:serving",
      "assignment:u2:serving",
    ]);
  });

  it("fails closed when the source mounts a customer without an assignment", async () => {
    const h = harness({
      assignments: [assignment("u1", "alice")],
      sourceMountedCustomers: ["alice", "orphan"],
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      stateMigration: MIGRATE_STATE,
    })).rejects.toThrow("source mounted customer orphan has no assignment");

    expect(h.events).toEqual([]);
  });

  it("restores owned assignments only after Kubernetes removes the old pod", async () => {
    const h = harness({
      pods: [{ ...targetPod, ready: true }],
      targetReleased: true,
      targetMountedCustomers: ["alice"],
      assignments: [assignment("u1", "alice", {
        state: "quiescing",
        updatedByOperationId: "surge-default-target-uid",
      })],
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      stateMigration: MIGRATE_STATE,
    })).resolves.toEqual({ ready: true });

    expect(h.events).toEqual(["assignment:u1:serving"]);
  });

  it("does not mark a source-less released replacement ready until every assigned customer is mounted", async () => {
    const h = harness({
      pods: [{ ...targetPod, ready: true }],
      targetReleased: true,
      assignments: [assignment("u1", "alice", {
        state: "quiescing",
        updatedByOperationId: "surge-default-target-uid",
      })],
      targetMountedCustomers: [],
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      stateMigration: MIGRATE_STATE,
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual([]);
    expect(h.assignments()[0]).toMatchObject({
      state: "quiescing",
      updatedByOperationId: "surge-default-target-uid",
    });
    expect(h.deps.log).toHaveBeenCalledWith(expect.stringContaining("assigned mounted roster"));
  });

  it("waits with both pods gated after target readiness opens", async () => {
    const h = harness({
      pods: [oldPod, { ...targetPod, ready: true }],
      targetReleased: true,
      assignments: [assignment("u1", "alice", {
        state: "quiescing",
        updatedByOperationId: "surge-default-target-uid",
      })],
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      stateMigration: MIGRATE_STATE,
    })).resolves.toEqual({ ready: false });
    expect(h.events).toEqual([]);
  });

  it("releases a sourceless shared target, then heals its owned roster gates", async () => {
    const pods: SurgePod[] = [targetPod];
    const h = harness({
      pods,
      targetMountedCustomers: ["alice"],
      assignments: [assignment("u1", "alice", {
        state: "quiescing",
        updatedByOperationId: "surge-default-target-uid",
      })],
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      stateMigration: MIGRATE_STATE,
    })).resolves.toEqual({ ready: false });
    expect(h.events).toEqual(["release:target-uid"]);

    h.setTargetReleased(true);
    pods[0] = { ...targetPod, ready: true };
    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      stateMigration: MIGRATE_STATE,
    })).resolves.toEqual({ ready: true });
    expect(h.events).toEqual([
      "release:target-uid",
      "assignment:u1:serving",
    ]);
  });

  it("does not accept source loss while the old pod still exists but is NotReady", async () => {
    const h = harness({ pods: [{ ...oldPod, ready: false }, targetPod] });

    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(reconcileSurgeCustomerHandoff(h.deps, {
        gatewayId: "default",
        desiredImageTag: "new-sha",
        requiresCustomerMigration: true,
        stateMigration: MIGRATE_STATE,
      })).resolves.toEqual({ ready: false });
    }
    expect(h.events).toEqual([]);
  });

  it("releases an empty release migration without requiring a healthy source pod", async () => {
    const h = harness({
      pods: [{ ...oldPod, ready: false }, targetPod],
      assignments: [],
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "trial-op-000001",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      stateMigration: MIGRATE_STATE,
      ownerlessOperatorPrewarm: true,
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual(["release:target-uid"]);
  });

  it("keeps a non-empty operator prewarm closed while its source pod is NotReady", async () => {
    const h = harness({
      pods: [{ ...oldPod, ready: false }, targetPod],
      assignments: [assignment("u1", "alice")],
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "trial-op-000001",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      stateMigration: MIGRATE_STATE,
      ownerlessOperatorPrewarm: true,
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual([]);
  });

  it("leaves an empty same-release replacement to the pod-side readiness gate", async () => {
    const h = harness({
      pods: [{ ...oldPod, ready: false }, targetPod],
      assignments: [],
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "trial-op-000001",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: false,
      stateMigration: MIGRATE_STATE,
      ownerlessOperatorPrewarm: true,
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual([]);
  });

  it("does not bypass source health for an empty customer gateway release migration", async () => {
    const h = harness({
      pods: [{ ...oldPod, ready: false }, targetPod],
      assignments: [],
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      stateMigration: MIGRATE_STATE,
      ownerlessOperatorPrewarm: false,
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual([]);
  });

  it("reclaims an abandoned surge gate before retrying the verified handoff", async () => {
    const h = harness({
      assignments: [assignment("u1", "alice", {
        state: "quiescing",
        updatedByOperationId: abandonedOperationId,
      })],
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      stateMigration: MIGRATE_STATE,
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual([
      "assignment:u1:serving",
      "assignment:u1:quiescing",
      "quiesce:alice",
      "transfer:alice",
      "digest:old-uid:alice",
      "digest:target-uid:alice",
      "release:target-uid",
    ]);
    expect(h.assignments()[0]).toMatchObject({
      state: "quiescing",
      updatedByOperationId: h.operationId,
    });
  });

  it("reclaims the completed prior handoff when its target becomes the next Ready source", async () => {
    const priorTargetUid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const priorTarget = {
      ...oldPod,
      uid: priorTargetUid,
      name: "gateway-prior-target",
    };
    const priorOperationId = `surge-default-${priorTargetUid}`;
    const h = harness({
      pods: [priorTarget, targetPod],
      assignments: [assignment("u1", "alice", {
        state: "quiescing",
        updatedByOperationId: priorOperationId,
      })],
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      stateMigration: MIGRATE_STATE,
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual([
      "assignment:u1:serving",
      "assignment:u1:quiescing",
      "quiesce:alice",
      "transfer:alice",
      `digest:${priorTargetUid}:alice`,
      "digest:target-uid:alice",
      "release:target-uid",
    ]);
    expect(h.assignments()[0]).toMatchObject({
      state: "quiescing",
      updatedByOperationId: h.operationId,
    });
  });

  it("reopens an abandoned surge gate while Kubernetes replaces the missing target", async () => {
    const h = harness({
      pods: [oldPod],
      assignments: [assignment("u1", "alice", {
        state: "quiescing",
        updatedByOperationId: abandonedOperationId,
      })],
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      stateMigration: MIGRATE_STATE,
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual(["assignment:u1:serving"]);
    expect(h.assignments()[0]).toMatchObject({
      state: "serving",
      updatedByOperationId: abandonedOperationId,
    });
  });

  it("keeps an assignment gated while its owner pod object is terminating", async () => {
    const h = harness({
      pods: [oldPod],
      observedPodUids: [oldPod.uid, abandonedPodUid],
      assignments: [assignment("u1", "alice", {
        state: "quiescing",
        updatedByOperationId: abandonedOperationId,
      })],
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      stateMigration: MIGRATE_STATE,
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual([]);
    expect(h.assignments()[0]).toMatchObject({
      state: "quiescing",
      updatedByOperationId: abandonedOperationId,
    });
  });

  it("reopens an abandoned surge gate after the replacement becomes the only pod", async () => {
    const h = harness({
      pods: [{ ...targetPod, ready: true }],
      targetReleased: true,
      targetMountedCustomers: ["alice"],
      assignments: [assignment("u1", "alice", {
        state: "quiescing",
        updatedByOperationId: abandonedOperationId,
      })],
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      stateMigration: MIGRATE_STATE,
    })).resolves.toEqual({ ready: true });

    expect(h.events).toEqual(["assignment:u1:serving"]);
    expect(h.assignments()[0]).toMatchObject({
      state: "serving",
      updatedByOperationId: h.operationId,
    });
  });

  it("does not reclaim a surge gate while its owning pod still exists", async () => {
    const h = harness({
      assignments: [assignment("u1", "alice", {
        state: "quiescing",
        updatedByOperationId: "surge-default-old-uid",
      })],
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      stateMigration: MIGRATE_STATE,
    })).rejects.toThrow(/foreign assignment gate/);
    expect(h.events).toEqual([]);
  });

  it("does not reclaim a surge gate owned by a gateway with a shared prefix", async () => {
    const h = harness({
      assignments: [assignment("u1", "alice", {
        state: "quiescing",
        updatedByOperationId: otherGatewayOperationId,
      })],
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      stateMigration: MIGRATE_STATE,
    })).rejects.toThrow(/foreign assignment gate/);
    expect(h.events).toEqual([]);
  });

  it("reclaims a lease whose owning operation is no longer running", async () => {
    const h = harness({
      assignments: [assignment("u1", "alice", {
        state: "quiescing",
        updatedByOperationId: "placement-f061f700711dbdec1d7f8f2add33d1d3",
      })],
      ownerOperations: {
        "placement-f061f700711dbdec1d7f8f2add33d1d3": { status: "failed" },
      },
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      stateMigration: MIGRATE_STATE,
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual([
      "assignment:u1:serving",
      "assignment:u1:quiescing",
      "quiesce:alice",
      "transfer:alice",
      "digest:old-uid:alice",
      "digest:target-uid:alice",
      "release:target-uid",
    ]);
    expect(h.deps.log).toHaveBeenCalledWith(expect.stringContaining(
      "owner=placement-f061f700711dbdec1d7f8f2add33d1d3: owning operation is failed",
    ));
  });

  it("reclaims a lease whose owning operation no longer exists", async () => {
    const h = harness({
      assignments: [assignment("u1", "alice", {
        state: "quiescing",
        updatedByOperationId: "placement-deleted",
      })],
      ownerOperations: { "placement-deleted": null },
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      stateMigration: MIGRATE_STATE,
    })).resolves.toEqual({ ready: false });

    expect(h.events[0]).toBe("assignment:u1:serving");
    expect(h.deps.log).toHaveBeenCalledWith(expect.stringContaining(
      "owner=placement-deleted: owning operation no longer exists",
    ));
  });

  it("refuses a foreign migration gate", async () => {
    const h = harness({
      assignments: [assignment("u1", "alice", {
        state: "quiescing",
        updatedByOperationId: "migrate-customer-op",
      })],
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      stateMigration: MIGRATE_STATE,
    })).rejects.toThrow(/foreign assignment gate/);
    expect(h.events).toEqual([]);
  });

  it("reopens its assignments when transfer fails before target release", async () => {
    const h = harness({
      assignments: [assignment("u1", "alice")],
      transferError: new Error("rsync failed"),
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      stateMigration: MIGRATE_STATE,
    })).rejects.toThrow("rsync failed");
    expect(h.events).toEqual([
      "assignment:u1:quiescing",
      "quiesce:alice",
      "transfer:alice",
      "discard:alice",
      "assignment:u1:serving",
    ]);
  });

  it("preserves configured Builder target state when its transfer fails", async () => {
    const h = harness({
      assignments: [assignment("u1", "alice")],
      transferError: new Error("rsync failed"),
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      disposableBuilderGateway: true,
      stateMigration: MIGRATE_STATE,
    })).rejects.toThrow("rsync failed");

    expect(h.events).toEqual([
      "assignment:u1:quiescing",
      "quiesce:alice",
      "flush:old-uid:alice:migration-final",
      "hold-target:target-uid:alice",
      "stop-source:old-uid:alice",
      "transfer:alice",
      "hold-target:target-uid:alice",
      "resume-source:old-uid:alice",
      "assignment:u1:serving",
    ]);
    expect(h.deps.discardTargetCustomer).not.toHaveBeenCalled();
  });

  it("discards every target customer touched when a later transfer fails", async () => {
    const h = harness({
      transferError: new Error("bob rsync failed"),
      transferErrorSlug: "bob",
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      stateMigration: MIGRATE_STATE,
    })).rejects.toThrow("bob rsync failed");

    expect(h.events).toEqual([
      "assignment:u1:quiescing",
      "quiesce:alice",
      "transfer:alice",
      "digest:old-uid:alice",
      "digest:target-uid:alice",
      "assignment:u2:quiescing",
      "quiesce:bob",
      "transfer:bob",
      "discard:bob",
      "discard:alice",
      "assignment:u1:serving",
      "assignment:u2:serving",
    ]);
  });

  it("cleans stale target mounts before replaying a handoff", async () => {
    const h = harness({ targetMountedCustomers: ["alice"] });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      stateMigration: MIGRATE_STATE,
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual([
      "assignment:u1:quiescing",
      "discard:alice",
      "assignment:u1:serving",
      "assignment:u1:quiescing",
      "quiesce:alice",
      "transfer:alice",
      "digest:old-uid:alice",
      "digest:target-uid:alice",
      "assignment:u2:quiescing",
      "quiesce:bob",
      "transfer:bob",
      "digest:old-uid:bob",
      "digest:target-uid:bob",
      "release:target-uid",
    ]);
  });

  it("preserves a configured Builder target mount before replaying a handoff", async () => {
    const h = harness({
      assignments: [assignment("u1", "alice")],
      targetMountedCustomers: ["alice"],
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      disposableBuilderGateway: true,
      stateMigration: MIGRATE_STATE,
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual([
      "assignment:u1:quiescing",
      "quiesce:alice",
      "flush:old-uid:alice:migration-final",
      "hold-target:target-uid:alice",
      "stop-source:old-uid:alice",
      "transfer:alice",
      "digest:old-uid:alice",
      "digest:target-uid:alice",
      "release:target-uid",
    ]);
    expect(h.deps.discardTargetCustomer).not.toHaveBeenCalled();
  });

  it("transfers into a held prelaunch Builder target whose OpenClaw is intentionally stopped", async () => {
    const h = harness({
      assignments: [assignment("u1", "alice")],
      bootingUids: [targetPod.uid],
      prelaunchByUid: { [targetPod.uid]: "hydrated" },
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      disposableBuilderGateway: true,
      stateMigration: MIGRATE_STATE,
    })).resolves.toEqual({ ready: false });

    expect(h.events).toContain("transfer:alice");
    expect(h.events).toContain("release:target-uid");
  });

  it("keeps a booting non-prelaunch target out of transfer", async () => {
    const booting = harness({
      assignments: [assignment("u1", "alice")],
      bootingUids: [targetPod.uid],
    });
    await expect(reconcileSurgeCustomerHandoff(booting.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      disposableBuilderGateway: true,
      stateMigration: MIGRATE_STATE,
    })).resolves.toEqual({ ready: false });
    expect(booting.events).toEqual([]);

    const starting = harness({
      assignments: [assignment("u1", "alice")],
      bootingUids: [targetPod.uid],
      prelaunchByUid: { [targetPod.uid]: "starting" },
    });
    await expect(reconcileSurgeCustomerHandoff(starting.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      disposableBuilderGateway: true,
      stateMigration: MIGRATE_STATE,
    })).resolves.toEqual({ ready: false });
    expect(starting.events).toEqual([]);
  });

  it("retries the handoff for a Builder target left released but held by a rollback race", async () => {
    const h = harness({
      assignments: [assignment("u1", "alice")],
      targetReleased: true,
      bootingUids: [targetPod.uid],
      prelaunchByUid: { [targetPod.uid]: "hydrated" },
      targetMountedCustomers: ["alice"],
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      disposableBuilderGateway: true,
      stateMigration: MIGRATE_STATE,
    })).resolves.toEqual({ ready: false });

    expect(h.events).toContain("transfer:alice");
    expect(h.events).toContain("release:target-uid");
  });

  it("resumes a held NotReady Builder source instead of waiting forever and restores its roster", async () => {
    const h = harness({
      pods: [{ ...oldPod, ready: false }, targetPod],
      assignments: [{ ...assignment("u1", "alice"), state: "quiescing", updatedByOperationId: "surge-default-target-uid" }],
      bootingUids: [oldPod.uid, targetPod.uid],
      prelaunchByUid: { [oldPod.uid]: "held", [targetPod.uid]: "hydrated" },
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      disposableBuilderGateway: true,
      stateMigration: MIGRATE_STATE,
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual(["resume-source:old-uid:alice", "assignment:u1:serving"]);
  });

  it("does not read assignments for a Barn whose source is missing or NotReady", async () => {
    const h = harness({
      pods: [{ ...oldPod, ready: false }, targetPod],
      bootingUids: [oldPod.uid],
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      stateMigration: MIGRATE_STATE,
    })).resolves.toEqual({ ready: false });

    expect(h.deps.readAssignments).not.toHaveBeenCalled();
    expect(h.events).toEqual([]);
  });

  it("leaves a NotReady non-held Builder source to recover on its own", async () => {
    const h = harness({
      pods: [{ ...oldPod, ready: false }, targetPod],
      assignments: [assignment("u1", "alice")],
      bootingUids: [oldPod.uid, targetPod.uid],
      prelaunchByUid: { [oldPod.uid]: "serving", [targetPod.uid]: "hydrated" },
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      disposableBuilderGateway: true,
      stateMigration: MIGRATE_STATE,
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual([]);
  });

  it("unreserves a sourceless reserved Builder target so it may rebuild from durable state", async () => {
    const h = harness({
      pods: [targetPod],
      assignments: [assignment("u1", "alice")],
      bootingUids: [targetPod.uid],
      prelaunchByUid: { [targetPod.uid]: "held" },
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      disposableBuilderGateway: true,
      stateMigration: MIGRATE_STATE,
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual(["unreserve-target:target-uid:alice"]);
  });

  it("leaves assignments open when a legacy source cannot begin a scoped handoff", async () => {
    const h = harness({
      assignments: [assignment("u1", "alice")],
      fleetSignatureCapabilityByUid: { [oldPod.uid]: "legacy" },
    });
    const input = {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      stateMigration: MIGRATE_STATE,
    };

    await expect(reconcileSurgeCustomerHandoff(h.deps, input)).resolves.toEqual({ ready: false });
    await expect(reconcileSurgeCustomerHandoff(h.deps, input)).resolves.toEqual({ ready: false });

    expect(h.events).toEqual([]);
    expect(h.deps.readAssignments).not.toHaveBeenCalled();
    expect(h.deps.quiesce).not.toHaveBeenCalled();
    expect(h.deps.releaseTarget).not.toHaveBeenCalled();
  });

  it("does not settle a ready legacy target through assignment or release control", async () => {
    const h = harness({
      pods: [{ ...targetPod, ready: true }],
      assignments: [assignment("u1", "alice", {
        state: "quiescing",
        updatedByOperationId: "surge-default-target-uid",
      })],
      targetReleased: true,
      targetMountedCustomers: ["alice"],
      fleetSignatureCapabilityByUid: { [targetPod.uid]: "legacy" },
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      stateMigration: MIGRATE_STATE,
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual([]);
    expect(h.deps.readAssignments).not.toHaveBeenCalled();
    expect(h.deps.releaseTarget).not.toHaveBeenCalled();
  });

  it("gates only the stale target customer when retry cleanup fails", async () => {
    const h = harness({
      targetMountedCustomers: ["alice"],
      discardError: new Error("stale target cleanup failed"),
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      stateMigration: MIGRATE_STATE,
    })).rejects.toThrow("stale target cleanup failed");

    expect(h.events).toEqual([
      "assignment:u1:quiescing",
      "discard:alice",
    ]);
    expect(h.assignments().find((item) => item.uid === "u2")?.state).toBe("serving");
  });

  it("keeps admission closed when batch cleanup fails and attempts every touched customer", async () => {
    const h = harness({
      transferError: new Error("bob rsync failed"),
      transferErrorSlug: "bob",
      discardError: new Error("target cleanup failed"),
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      stateMigration: MIGRATE_STATE,
    })).rejects.toThrow(/target cleanup failed/);

    expect(h.events).toEqual([
      "assignment:u1:quiescing",
      "quiesce:alice",
      "transfer:alice",
      "digest:old-uid:alice",
      "digest:target-uid:alice",
      "assignment:u2:quiescing",
      "quiesce:bob",
      "transfer:bob",
      "discard:bob",
      "discard:alice",
    ]);
  });

  it("rolls back an earlier roster gate when a later gate write fails", async () => {
    const h = harness({ markErrorUid: "u2" });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      stateMigration: MIGRATE_STATE,
    })).rejects.toThrow("assignment write failed");
    expect(h.events).toEqual([
      "assignment:u1:quiescing",
      "quiesce:alice",
      "transfer:alice",
      "digest:old-uid:alice",
      "digest:target-uid:alice",
      "assignment:u2:quiescing",
      "discard:alice",
      "assignment:u1:serving",
    ]);
  });

  it("keeps admission closed when a failed target import cannot be discarded", async () => {
    const h = harness({
      assignments: [assignment("u1", "alice")],
      transferError: new Error("rsync failed"),
      discardError: new Error("target cleanup failed"),
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      stateMigration: MIGRATE_STATE,
    })).rejects.toThrow(/target cleanup failed/);
    expect(h.events).toEqual([
      "assignment:u1:quiescing",
      "quiesce:alice",
      "transfer:alice",
      "discard:alice",
    ]);
  });

  it("confirms a committed target release when its HTTP response is lost", async () => {
    const h = harness({
      assignments: [assignment("u1", "alice")],
      releaseErrorAfterCommit: new Error("connection reset"),
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      stateMigration: MIGRATE_STATE,
    })).resolves.toEqual({ ready: false });
    expect(h.events).toEqual([
      "assignment:u1:quiescing",
      "quiesce:alice",
      "transfer:alice",
      "digest:old-uid:alice",
      "digest:target-uid:alice",
      "release:target-uid",
    ]);
  });

  it("keeps admission closed when target release cannot be confirmed", async () => {
    const h = harness({
      assignments: [assignment("u1", "alice")],
      releaseErrorBeforeCommit: new Error("connection refused"),
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      stateMigration: MIGRATE_STATE,
    })).rejects.toThrow("connection refused");
    expect(h.events).toEqual([
      "assignment:u1:quiescing",
      "quiesce:alice",
      "transfer:alice",
      "digest:old-uid:alice",
      "digest:target-uid:alice",
      "release:target-uid",
    ]);
    expect(h.assignments()[0]).toMatchObject({
      state: "quiescing",
      updatedByOperationId: h.operationId,
    });
  });
  it("stands down instead of converging a pod a pending release replaces", async () => {
    const h = harness();

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      stateMigration: MIGRATE_STATE,
      supersedingImageTag: "next-sha",
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual([]);
    expect(h.assignments().every((item) => item.state === "serving")).toBe(true);
  });

  it("resumes a held Builder source while standing down for a pending release", async () => {
    const h = harness({
      pods: [{ ...oldPod, ready: false }, targetPod],
      assignments: [assignment("u1", "alice", {
        state: "quiescing",
        updatedByOperationId: "surge-default-target-uid",
      })],
      bootingUids: [oldPod.uid, targetPod.uid],
      prelaunchByUid: { [oldPod.uid]: "held", [targetPod.uid]: "hydrated" },
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      disposableBuilderGateway: true,
      stateMigration: MIGRATE_STATE,
      supersedingImageTag: "next-sha",
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual(["resume-source:old-uid:alice", "assignment:u1:serving"]);
  });

  it("unreserves a sourceless Builder target while standing down for a pending release", async () => {
    const h = harness({
      pods: [targetPod],
      assignments: [assignment("u1", "alice")],
      bootingUids: [targetPod.uid],
      prelaunchByUid: { [targetPod.uid]: "held" },
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      disposableBuilderGateway: true,
      stateMigration: MIGRATE_STATE,
      supersedingImageTag: "next-sha",
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual(["unreserve-target:target-uid:alice"]);
  });

  it("still settles a released target while a rollout is queued", async () => {
    const h = harness({
      pods: [{ ...targetPod, ready: true }],
      targetReleased: true,
      targetMountedCustomers: ["alice"],
      assignments: [assignment("u1", "alice")],
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      stateMigration: MIGRATE_STATE,
      supersedingImageTag: "next-sha",
    })).resolves.toEqual({ ready: true });
  });

  it("reopens a gated lease for the sourceless target it unreserves while standing down", async () => {
    const h = harness({
      pods: [targetPod],
      assignments: [assignment("u1", "alice", {
        state: "quiescing",
        updatedByOperationId: "surge-default-target-uid",
      })],
      bootingUids: [targetPod.uid],
      prelaunchByUid: { [targetPod.uid]: "held" },
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      disposableBuilderGateway: true,
      stateMigration: MIGRATE_STATE,
      supersedingImageTag: "next-sha",
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual([
      "unreserve-target:target-uid:alice",
      "assignment:u1:serving",
    ]);
  });

  it("reopens a lease its own dead handoff left gated while standing down", async () => {
    const h = harness({
      assignments: [assignment("u1", "alice", {
        state: "quiescing",
        updatedByOperationId: "surge-default-target-uid",
      })],
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      stateMigration: MIGRATE_STATE,
      supersedingImageTag: "next-sha",
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual(["assignment:u1:serving"]);
    expect(h.assignments()[0]).toMatchObject({ state: "serving" });
  });

  it("reopens an abandoned surge gate while standing down for a pending release", async () => {
    const h = harness({
      assignments: [assignment("u1", "alice", {
        state: "quiescing",
        updatedByOperationId: abandonedOperationId,
      })],
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      stateMigration: MIGRATE_STATE,
      supersedingImageTag: "next-sha",
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual(["assignment:u1:serving"]);
    expect(h.assignments()[0]).toMatchObject({ state: "serving" });
  });
});
