import { isDeepStrictEqual } from "node:util";
import { FieldValue, type DocumentData, type DocumentReference, type Firestore, type Transaction } from "firebase-admin/firestore";

import { GLM_GATEWAYS_COLLECTION } from "@octogee/shared/types/glm";
import { assertSharedSourceRecoveryUnchanged, readSharedSourceRecoveryAuthority } from "@octogee/core/shared-source-recovery";
import { agentIdBelongsToSlug } from "@octogee/shared/types/agent-models";
import type { FleetBrokerOpenClawBootClaim } from "@octogee/shared/types/fleet-broker";

interface OpenClawBootInput {
  gatewayId: string;
  podUid: string;
  podName: string;
  releaseKey: string;
  openclawBuild?: string;
}

export interface OpenClawBootSentinelStore {
  claim(input: OpenClawBootInput): Promise<FleetBrokerOpenClawBootClaim | null>;
  assertDoctor(input: OpenClawBootInput & { requestId: string }): Promise<boolean>;
  complete(input: OpenClawBootInput): Promise<boolean>;
  completeDoctor(input: OpenClawBootInput & { requestId: string; verifiedAgentIds: string[] }): Promise<boolean>;
}

export const OPENCLAW_BUILD_PATTERN = /^[0-9a-f]{40}$/;

function recordedHealthyOpenClawBuild(runtime: DocumentData | undefined): string | undefined {
  const build = runtime?.openclawHealthyBuild;
  if (build === undefined) return undefined;
  if (typeof build !== "string" || !OPENCLAW_BUILD_PATTERN.test(build)) throw new Error("stored healthy OpenClaw build is malformed");
  return build;
}

function record(value: unknown): DocumentData {
  return value && typeof value === "object" && !Array.isArray(value) ? value as DocumentData : {};
}

function assertSourceRoot(root: DocumentData, captured: unknown): void {
  if (root.gatewayClass !== "shared" || !["running", "draining"].includes(root.desiredStatus) ||
      root.retirementClaim != null || !Number.isSafeInteger(root.liveRelease) || root.liveRelease < 1 || root.desiredRelease !== root.liveRelease) {
    throw new Error("source Doctor lifecycle custody mismatch");
  }
  const identity = Object.fromEntries(["gatewayId", "gatewayClass", "ownerUid", "builderSlug", "desiredStatus", "desiredRelease", "liveRelease", "latestRelease"].map((key) => [key, root[key]]));
  if (!isDeepStrictEqual(captured, identity)) throw new Error("source Doctor release custody changed");
}

function assertSourceFence(fence: DocumentData, input: OpenClawBootInput): void {
  const target = record(fence.target), doctor = record(fence.doctor);
  if (fence.gatewayId !== input.gatewayId || fence.phase !== "dispatched" || fence.attemptId !== doctor.requestId || fence.auditId !== doctor.requestId ||
      typeof doctor.requestId !== "string" || !doctor.requestId || doctor.requestId.includes("/") || doctor.error !== undefined ||
      target.podUid !== input.podUid || target.podName !== input.podName || !Number.isSafeInteger(fence.startedAt) || fence.startedAt <= 0) {
    throw new Error("source Doctor fence custody mismatch");
  }
}

function assertSourceOperation(op: DocumentData, recovery: DocumentData, target: DocumentData, gatewayId: string): void {
  if (op.kind !== "restart-gateway" || !["pending", "running"].includes(op.status) || op.completedAt !== null ||
      op.cancellationRequestedAt !== undefined || op.input?.gatewayId !== gatewayId ||
      typeof recovery.sourceSha !== "string" || !/^[a-f0-9]{40}$/.test(recovery.sourceSha) || target.sourceSha !== recovery.sourceSha ||
      !isDeepStrictEqual(target.images, recovery.images)) throw new Error("source Doctor operation mismatch");
}

function sourceAgentIds(assignments: unknown, captured: unknown): string[] {
  if (!Array.isArray(assignments) || assignments.length === 0) throw new Error("source Doctor requires owned agents");
  const agents = assignments.map((value) => {
    const agent = { ...record(value) }; delete agent.assignment;
    if (typeof agent.uid !== "string" || !agent.uid || agent.uid.includes("/") || typeof agent.slug !== "string" ||
        !/^[a-z0-9][a-z0-9_-]*$/.test(agent.slug) || agent.agentId !== `octogee-${agent.slug}-coach` ||
        !Number.isSafeInteger(agent.assignmentEpoch) || agent.assignmentEpoch < 0) throw new Error("source Doctor agent ownership mismatch");
    return agent;
  });
  const agentIds = agents.map((agent) => agent.agentId as string);
  if (!isDeepStrictEqual(captured, agents) || new Set(agentIds).size !== agentIds.length) throw new Error("source Doctor roster mismatch");
  return agentIds;
}

function sourceImageVerified(fence: DocumentData, podUid: string): boolean {
  if (fence.installedImage === undefined) return false;
  const image = record(fence.installedImage), target = record(fence.target);
  const wanted = typeof target.images?.gateway === "string" ? /@(sha256:[a-f0-9]{64})$/.exec(target.images.gateway)?.[1] : undefined;
  if (!wanted || image.podUid !== podUid || typeof image.gatewayImageId !== "string" || !image.gatewayImageId.endsWith(wanted) ||
      !Number.isSafeInteger(image.verifiedAt) || image.verifiedAt < fence.startedAt) throw new Error("source Doctor installed image mismatch");
  return true;
}

async function sourceDoctorContext(db: Firestore, txn: Transaction, input: OpenClawBootInput) {
  const rootRef = db.doc(`gateways/${input.gatewayId}`);
  const root = record((await txn.get(rootRef)).data()), fence = record(root.runtimeRestartFence);
  if (fence.kind !== "source-recovery") return null;
  assertSourceFence(fence, input);
  const target = record(fence.target), doctor = record(fence.doctor);
  const op = record((await txn.get(db.doc(`glmOperations/${doctor.requestId}`))).data()), recovery = record(op.input?.sourceRecovery);
  assertSourceRoot(root, recovery.root);
  assertSourceOperation(op, recovery, target, input.gatewayId);
  const coaches = sourceAgentIds(recovery.assignments, target.agents);
  const stores = sourcePostgresStores(recovery, target, coaches);
  if (recovery.schedulerStateRecovery !== true || target.schedulerStateRecovery !== true) throw new Error("source Doctor scheduler custody mismatch");
  const current = await readSharedSourceRecoveryAuthority(db, txn, input.gatewayId, doctor.requestId);
  assertSharedSourceRecoveryUnchanged(current, recovery as Parameters<typeof assertSharedSourceRecoveryUnchanged>[1]);
  return { rootRef, fence, doctor, agentIds: stores.map(s => s.agentId), postgresAgentStores: stores,
    schedulerStateRecovery: true as const, imageVerified: sourceImageVerified(fence, input.podUid) };
}

function sourcePostgresStores(recovery: DocumentData, target: DocumentData, coaches: string[]) {
  const stores = recovery.postgresAgentStores;
  if (!Array.isArray(stores) || !stores.length || !isDeepStrictEqual(stores, target.postgresAgentStores) ||
      coaches.some(id => !stores.some(s => s.agentId === id)) ||
      new Set(stores.map(s => s.agentId)).size !== stores.length || new Set(stores.map(s => s.storeId)).size !== stores.length ||
      new Set(stores.map(s => s.schema)).size !== stores.length || stores.some(s => {
        const owner = recovery.assignments.find((a: DocumentData) => a.uid === s.uid);
        return !owner || owner.slug !== s.slug || owner.assignmentEpoch !== s.assignmentEpoch || !agentIdBelongsToSlug(s.agentId, s.slug) ||
          typeof s.storeId !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(s.storeId) ||
          typeof s.schema !== "string" || !/^[a-z_][a-z0-9_]{0,62}$/.test(s.schema);
      })) throw new Error("source Doctor PostgreSQL roster mismatch");
  return stores.map(s => ({ agentId: s.agentId as string, storeId: s.storeId as string, schema: s.schema as string }));
}

function sourceDoctorCompleted(context: NonNullable<Awaited<ReturnType<typeof sourceDoctorContext>>>, input: OpenClawBootInput): boolean {
  const { doctor, agentIds } = context;
  return context.imageVerified && Number.isSafeInteger(doctor.startedAt) && doctor.startedAt > 0 && Number.isSafeInteger(doctor.completedAt) &&
    doctor.completedAt >= doctor.startedAt && doctor.releaseKey === input.releaseKey && isDeepStrictEqual(doctor.verifiedAgentIds, agentIds);
}
function sourceDoctorRequest(context: NonNullable<Awaited<ReturnType<typeof sourceDoctorContext>>>) {
  return { requestId: context.doctor.requestId as string, agentIds: context.agentIds,
    schedulerStateRecovery: context.schedulerStateRecovery, postgresAgentStores: context.postgresAgentStores };
}

function claimReleaseSentinel(
  txn: Transaction,
  runtimeRef: DocumentReference,
  runtime: DocumentData | undefined,
  input: OpenClawBootInput,
  at: number,
): FleetBrokerOpenClawBootClaim {
  const healthyBuild = recordedHealthyOpenClawBuild(runtime);
  const sentinel = runtime?.openclawBootSentinel as
    | Record<string, unknown>
    | undefined;
  if (sentinel?.releaseKey === input.releaseKey && sentinel.state === "starting") {
    txn.update(runtimeRef, {
      openclawBootSentinel: {
        releaseKey: input.releaseKey,
        state: "doctor-attempted",
        podUid: input.podUid,
        updatedAt: at,
      },
    });
    return { action: "doctor" };
  }
  if (sentinel?.releaseKey !== input.releaseKey) {
    txn.update(runtimeRef, {
      openclawBootSentinel: {
        releaseKey: input.releaseKey,
        state: "starting",
        podUid: input.podUid,
        updatedAt: at,
      },
    });
    if (input.openclawBuild && input.openclawBuild !== healthyBuild) {
      return { action: "doctor" as const, openclawUpgrade: healthyBuild ? { replacesBuild: healthyBuild } : {} };
    }
  } else if (
    sentinel.state === "doctor-attempted"
    && sentinel.podUid !== input.podUid
  ) {
    txn.update(runtimeRef, {
      "openclawBootSentinel.podUid": input.podUid,
      "openclawBootSentinel.updatedAt": at,
    });
  }
  return { action: "start" };
}

export function createOpenClawBootSentinelStore(
  db: Firestore,
  now: () => number,
): OpenClawBootSentinelStore {
  return {
    async claim(input) {
      const runtimeRef = db.collection(GLM_GATEWAYS_COLLECTION).doc(input.gatewayId);
      return db.runTransaction(async (txn) => {
        const runtimeSnap = await txn.get(runtimeRef);
        if (!runtimeSnap.exists) return null;
        const context = await sourceDoctorContext(db, txn, input);
        if (context) {
          if (sourceDoctorCompleted(context, input)) return { action: "start" as const };
          if (context.doctor.startedAt !== undefined || context.doctor.completedAt !== undefined) throw new Error("source Doctor attempted without matching success acknowledgement");
          const sourceDoctor = sourceDoctorRequest(context);
          if (!context.imageVerified) return { action: "wait" as const, sourceDoctor };
          txn.update(context.rootRef, {
            "runtimeRestartFence.doctor.startedAt": now(),
            "runtimeRestartFence.doctor.releaseKey": input.releaseKey,
          });
          return { action: "doctor" as const, sourceDoctor };
        }
        return claimReleaseSentinel(txn, runtimeRef, runtimeSnap.data(), input, now());
      });
    },
    async assertDoctor(input) {
      return db.runTransaction(async txn => {
        const context = await sourceDoctorContext(db, txn, input);
        if (!context?.imageVerified || context.doctor.requestId !== input.requestId || context.doctor.releaseKey !== input.releaseKey ||
            !Number.isSafeInteger(context.doctor.startedAt) || context.doctor.startedAt <= 0) throw new Error("source Doctor authority changed");
        return true;
      }, { readOnly: true });
    },
    async completeDoctor(input) {
      return db.runTransaction(async (txn) => {
        const context = await sourceDoctorContext(db, txn, input);
        if (!context || !context.imageVerified || context.doctor.requestId !== input.requestId ||
            context.doctor.releaseKey !== input.releaseKey || !Number.isSafeInteger(context.doctor.startedAt) || context.doctor.startedAt <= 0 ||
            !isDeepStrictEqual(context.agentIds, input.verifiedAgentIds)) throw new Error("source Doctor acknowledgement mismatch");
        if (context.doctor.completedAt !== undefined) {
          if (!sourceDoctorCompleted(context, input)) throw new Error("source Doctor stored acknowledgement mismatch");
          return true;
        }
        const completedAt = now();
        if (completedAt < context.doctor.startedAt) throw new Error("source Doctor completion predates its claim");
        txn.update(context.rootRef, {
          "runtimeRestartFence.doctor.completedAt": completedAt,
          "runtimeRestartFence.doctor.verifiedAgentIds": input.verifiedAgentIds,
        });
        return true;
      });
    },
    async complete(input) {
      const runtimeRef = db.collection(GLM_GATEWAYS_COLLECTION).doc(input.gatewayId);
      return db.runTransaction(async (txn) => {
        const runtimeSnap = await txn.get(runtimeRef);
        if (!runtimeSnap.exists) return false;
        const context = await sourceDoctorContext(db, txn, input);
        if (context && !sourceDoctorCompleted(context, input)) throw new Error("source Doctor success acknowledgement is required before health");
        const sentinel = runtimeSnap.data()?.openclawBootSentinel as
          | Record<string, unknown>
          | undefined;
        const update: DocumentData = {};
        if (
          sentinel?.releaseKey === input.releaseKey
          && sentinel.podUid === input.podUid
        ) {
          update.openclawBootSentinel = FieldValue.delete();
        }
        if (input.openclawBuild) update.openclawHealthyBuild = input.openclawBuild;
        if (Object.keys(update).length > 0) txn.update(runtimeRef, update);
        return true;
      });
    },
  };
}
