import { SurgeOpenClawProcessEndpointMissingError, type SurgeAssignment, type SurgeCustomerHandoffDeps, type SurgePod, type SurgePodHealth } from "../../surge-customer-handoff.js";
import { decideRollStateMigration } from "../../roll-state-migration.js";
import type { OperationStatus } from "@octogee/shared/types/glm";

export const MIGRATE_STATE = decideRollStateMigration({
  sourceOpenclawVersion: "OpenClaw 2026.7.2-beta.7 (aaaaaaaa)",
  targetOpenclawVersion: "2026.7.2-beta.7",
  targetOpenclawSourceSha: "a".repeat(40),
});
export const CROSS_VERSION = decideRollStateMigration({
  sourceOpenclawVersion: "2026.7.1",
  targetOpenclawVersion: "2026.7.2-beta.7",
});

export const oldPod: SurgePod = {
  uid: "old-uid",
  name: "gateway-old",
  podIP: "10.0.0.1",
  ready: true,
  terminating: false,
  crashLooping: false,
};
export const targetPod: SurgePod = {
  uid: "target-uid",
  name: "gateway-new",
  podIP: "10.0.0.2",
  ready: false,
  terminating: false,
  crashLooping: false,
};
export const abandonedPodUid = "11111111-2222-4333-8444-555555555555";
export const abandonedOperationId = `surge-default-${abandonedPodUid}`;
export const otherGatewayOperationId = `surge-default-blue-${abandonedPodUid}`;

export function assignment(
  uid: string,
  slug: string,
  overrides: Partial<SurgeAssignment> = {},
): SurgeAssignment {
  return {
    uid,
    slug,
    state: "serving",
    epoch: 1,
    updatedAt: 1,
    updatedByOperationId: null,
    ...overrides,
  };
}

export function createSurgeHandoffHarness(spy: <T extends (...args: never[]) => unknown>(implementation?: T) => T, input: {
  pods?: SurgePod[];
  unreachableUids?: string[];
  evictionBudgetSpent?: boolean;
  observedPodUids?: string[];
  assignments?: SurgeAssignment[];
  targetReleased?: boolean;
  terminalTargetByUid?: Record<string, SurgePodHealth["terminalTarget"]>;
  transferError?: Error;
  transferErrorSlug?: string;
  discardError?: Error;
  markErrorUid?: string;
  releaseErrorBeforeCommit?: Error;
  releaseErrorBeforeCommitOnce?: boolean;
  releaseErrorAfterCommit?: Error;
  targetVersion?: string;
  sourceMountedCustomers?: string[];
  targetMountedCustomers?: string[];
  ownerOperations?: Record<string, { status: OperationStatus; sourceRecoveryPending?: boolean } | null>;
  bootingUids?: string[];
  prelaunchByUid?: Record<string, SurgePodHealth["prelaunchState"]>;
  targetPrelaunchStateAfterRelease?: SurgePodHealth["prelaunchState"];
  fleetSignatureCapabilityByUid?: Record<string, SurgePodHealth["fleetSignatureCapability"]>;
  resumeSourceError?: Error;
  stopSourceError?: Error;
  stopSourceLegacy?: boolean;
  holdTargetError?: Error;
  holdTargetErrorFromCall?: number;
  digestByPodUid?: Record<string, { fileCount: number; totalBytes: number; sha256: string }>;
  wait?: (ms: number) => Promise<void>;
} = {}) {
  const events: string[] = [];
  let assignments = input.assignments ?? [assignment("u1", "alice"), assignment("u2", "bob")];
  let targetReleased = input.targetReleased === true;
  let sourceHeld = false;
  let targetReleaseCalls = 0;
  const operationId = "surge-default-target-uid";
  const deps: SurgeCustomerHandoffDeps = {
    reportMigrationProgress: spy(async () => undefined),
    recordMigrationProgress: spy(async () => undefined),
    listPods: spy(async () => {
      const pods = input.pods ?? [oldPod, targetPod];
      return {
        pods,
        observedPodUids: input.observedPodUids ?? pods.map((pod) => pod.uid),
      };
    }),
    readPodHealth: spy(async (pod) => input.unreachableUids?.includes(pod.uid) ? null : ({
      status: input.bootingUids?.includes(pod.uid) ? "booting" as const : "ready" as const,
      version: pod.uid === targetPod.uid ? input.targetVersion ?? "new-sha" : "old-sha",
      fleetSignatureCapability: input.fleetSignatureCapabilityByUid?.[pod.uid] ?? "gateway-scoped",
      handoffReleased: pod.uid === targetPod.uid ? targetReleased : true,
      terminalTarget: input.terminalTargetByUid?.[pod.uid],
      prelaunchState: (
        pod.uid === targetPod.uid &&
        targetReleaseCalls > 0 &&
        input.targetPrelaunchStateAfterRelease !== undefined
          ? input.targetPrelaunchStateAfterRelease
          : input.prelaunchByUid?.[pod.uid]
      ) ??
        (pod.uid !== targetPod.uid && sourceHeld ? "held" : "none"),
      mountedCustomers: pod.uid === targetPod.uid
        ? input.targetMountedCustomers ?? []
        : input.sourceMountedCustomers ?? assignments.map((item) => item.slug),
    })),
    deleteCancelledTarget: spy(async ({ pod }) => { events.push(`delete-cancelled:${pod.uid}`); }),
    deleteCrashLoopingPod: spy(async ({ pod }) => {
      events.push(`delete-pod:${pod.uid}`);
    }),
    claimCrashLoopEviction: spy(async () => (
      input.evictionBudgetSpent ? { allowed: false, count: 3, budget: 3 } : { allowed: true, count: 1, budget: 3 }
    )),
    stopSourceOpenClaw: spy(async ({ sourcePod, slug }) => {
      events.push(`stop-source:${sourcePod.uid}:${slug}`);
      if (input.stopSourceLegacy) {
        throw new SurgeOpenClawProcessEndpointMissingError(
          `pod ${sourcePod.name} lacks the required surge OpenClaw hold endpoint`,
        );
      }
      if (input.stopSourceError) throw input.stopSourceError;
      sourceHeld = true;
    }),
    resumeSourceOpenClaw: spy(async ({ sourcePod, slug }) => {
      events.push(`resume-source:${sourcePod.uid}:${slug}`);
      if (input.resumeSourceError) throw input.resumeSourceError;
      sourceHeld = false;
    }),
    holdTargetOpenClaw: spy(async ({ targetPod: pod, slug }) => {
      events.push(`hold-target:${pod.uid}:${slug}`);
      const call = events.filter((event) => event.startsWith("hold-target:")).length;
      if (input.holdTargetError && call >= (input.holdTargetErrorFromCall ?? 1)) {
        throw input.holdTargetError;
      }
    }),
    unreserveTargetOpenClaw: spy(async ({ targetPod: pod, slug }) => {
      events.push(`unreserve-target:${pod.uid}:${slug}`);
    }),
    readAssignments: spy(async () => assignments),
    markAssignment: spy(async ({ uid, state, updatedByOperationId, expected }) => {
      events.push(`assignment:${uid}:${state}`);
      if (input.markErrorUid === uid && state === "quiescing") {
        throw new Error("assignment write failed");
      }
      const current = assignments.find((item) => item.uid === uid);
      if (
        current?.state !== expected.state ||
        current.updatedByOperationId !== expected.updatedByOperationId ||
        expected.updatedAt !== undefined && current.updatedAt !== expected.updatedAt
      ) {
        throw new Error("assignment ownership changed");
      }
      assignments = assignments.map((item) => item.uid === uid
        ? { ...item, state, updatedByOperationId, updatedAt: (item.updatedAt ?? 0) + 1 }
        : item);
    }),
    waitForSourceIdle: spy(async () => undefined),
    resumeSourceIngress: spy(async () => undefined),
    scheduler: spy(async request => ({
      operationId: request.operationId, phase: request.phase, drained: true,
      agentIds: request.agentIds ?? [`octogee-${request.slug}-coach`],
      ...(request.phase === "export" ? { snapshot: { version: 1, operationId: request.operationId, agentIds: request.agentIds ?? [`octogee-${request.slug}-coach`], jobs: [], scratch: [] } } : {}),
    })),
    quiesce: spy(async ({ slug }) => {
      events.push(`quiesce:${slug}`);
    }),
    flush: spy(async ({ pod, slug, reason }) => {
      events.push(`flush:${pod.uid}:${slug}:${reason}`);
      return reason === "migration-final"
        ? { systemConfigCommit: "a".repeat(40) }
        : {};
    }),
    transfer: spy(async ({ slug }) => {
      events.push(`transfer:${slug}`);
      if (input.transferError && (!input.transferErrorSlug || input.transferErrorSlug === slug)) {
        throw input.transferError;
      }
    }),
    discardTargetCustomer: spy(async ({ slug }) => {
      events.push(`discard:${slug}`);
      if (input.discardError) throw input.discardError;
    }),
    readDurableSessionDigest: spy(async ({ pod, slug }) => {
      events.push(`digest:${pod.uid}:${slug}`);
      return input.digestByPodUid?.[pod.uid] ?? {
        fileCount: 2,
        totalBytes: 20,
        sha256: "a".repeat(64),
      };
    }),
    releaseTarget: spy(async ({ pod }) => {
      events.push(`release:${pod.uid}`);
      targetReleaseCalls += 1;
      if (input.releaseErrorBeforeCommit && (
        input.releaseErrorBeforeCommitOnce !== true || targetReleaseCalls === 1
      )) {
        throw input.releaseErrorBeforeCommit;
      }
      if (input.releaseErrorAfterCommit) {
        targetReleased = true;
        throw input.releaseErrorAfterCommit;
      }
      targetReleased = true;
    }),
    wait: input.wait,
    readOwnerOperation: spy(async (id: string) => (
      input.ownerOperations && id in input.ownerOperations
        ? input.ownerOperations[id]
        : { status: "running" as OperationStatus }
    )),
    log: spy(),
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

