import { isDeepStrictEqual } from "node:util";
import { runNormalFleetMutation } from "@octogee/core/normal-fleet-mutation";
import type { GatewayRuntimeRestartFenceValue, PlatformStateStore } from "@octogee/core/platform-state";
import {
  readForceMigrationPlan, readForceMigrationPlanInTransaction, readForceMigrationSource,
  type ForceMigrationTarget, type OwnedMigrationRestart,
} from "./fleet-force-migration.js";
import type { ForceMigrationPod, ForceMigrationReceipt, ForceMigrationTransport } from "./fleet-force-migration-transport.js";

interface ForceMigrationResult { operationId: string; auditId: string; sourceEpoch: number; completedAt: number }

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function result(target: ForceMigrationTarget, request: Record<string, unknown>): ForceMigrationResult {
  return { operationId: target.operationId, auditId: String(request.auditId), sourceEpoch: Number(request.sourceEpoch), completedAt: Number(request.completedAt) };
}

export async function readForcedMigrationRecovery(store: PlatformStateStore, target: ForceMigrationTarget): Promise<{
  owned?: OwnedMigrationRestart;
  completed?: ForceMigrationResult;
}> {
  await readForceMigrationSource(store, target);
  const operation = await store.journal.operations.get(target.operationId);
  if (operation?.forceDrainRequest === undefined) return {};
  const request = record(operation.forceDrainRequest);
  if (typeof request.auditId !== "string" || !request.auditId || request.uid !== target.uid ||
    request.sourceGatewayId !== target.fromGatewayId || request.targetGatewayId !== target.toGatewayId ||
    !Number.isSafeInteger(request.sourceEpoch) || Number(request.sourceEpoch) < 1) throw new Error("force migration request ownership changed");
  if (request.completedAt !== undefined) {
    if (!Number.isSafeInteger(request.completedAt) || Number(request.completedAt) < 1) throw new Error("force migration completion is malformed");
    return { completed: result(target, request) };
  }
  const fence = record((await store.gateways.roots.get(target.fromGatewayId))?.runtimeRestartFence);
  if (fence.kind !== "process" || fence.auditId !== request.auditId || fence.attemptId !== request.auditId ||
    fence.gatewayId !== target.fromGatewayId || fence.operationId !== target.operationId ||
    !["reserved", "dispatched"].includes(String(fence.phase))) throw new Error("force migration restart fence ownership changed");
  boundPod(fence);
  return { owned: { fence, request } };
}

function boundPod(fence: Record<string, unknown>): ForceMigrationPod {
  const target = record(fence.target);
  if (![target.podName, target.podUid, target.containerImage, target.beforeBootId].every(value => typeof value === "string" && value.length > 0) ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(String(target.beforeBootId))) throw new Error("force migration retained pod binding is malformed");
  return target as unknown as ForceMigrationPod;
}

function verifyReceipt(receipt: ForceMigrationReceipt, fence: Record<string, unknown>): void {
  const beforeBootId = boundPod(fence).beforeBootId;
  if (receipt?.version !== 1 || receipt.attemptId !== fence.attemptId || receipt.ready !== true ||
    receipt.beforeBootId !== beforeBootId || typeof receipt.afterBootId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(receipt.afterBootId) || receipt.afterBootId === beforeBootId) throw new Error("force migration restart completion unverified");
}

function restartFence(fence: Record<string, unknown>): GatewayRuntimeRestartFenceValue {
  return fence as GatewayRuntimeRestartFenceValue;
}

export async function runForcedMigration(input: {
  store: PlatformStateStore; target: ForceMigrationTarget; actor: string; transport: ForceMigrationTransport; now?: () => number;
}): Promise<ForceMigrationResult> {
  const { store, target, actor, transport } = input;
  const now = input.now ?? Date.now;
  const recovery = await readForcedMigrationRecovery(store, target);
  if (recovery.completed) return recovery.completed;
  const plan = await readForceMigrationPlan(store, target, recovery.owned);
  const pod = recovery.owned ? boundPod(recovery.owned.fence) : await transport.capture(target.fromGatewayId);
  return runNormalFleetMutation(store, {
    actor, forced: true, what: recovery.owned ? "Observe forced migration recovery" : "Force source gateway restart for blocked migration",
    why: "Operator accepts interruption of the dedicated isolated gateway while preserving its pod, disk, and existing migration",
    target: { ...target, sourceEpoch: plan.sourceEpoch }, preActionStatus: { ...plan },
    mutation: { kind: "force-migration", observationOnly: recovery.owned?.fence.phase === "dispatched" }, now,
    action: async claim => {
      let owned = recovery.owned;
      if (!owned) {
        const requestedAt = now();
        const request = { auditId: claim.auditId, requestedBy: actor, requestedAt, uid: target.uid,
          sourceGatewayId: target.fromGatewayId, targetGatewayId: target.toGatewayId, sourceEpoch: plan.sourceEpoch };
        const fence = { kind: "process", attemptId: claim.auditId, auditId: claim.auditId, gatewayId: target.fromGatewayId,
          operationId: target.operationId, phase: "reserved", startedAt: requestedAt, target: pod, plan };
        await store.transaction({ label: "fleet-force-migration.reserve" }, async tx => {
          const fresh = await readForceMigrationPlanInTransaction(tx, target);
          if (!isDeepStrictEqual(fresh, plan)) throw new Error("force migration authority changed before reservation");
          await tx.gateways.roots.compareAndSetRuntimeRestartFence(target.fromGatewayId, null, restartFence(fence));
          await tx.journal.operations.patch(target.operationId, { forceDrainRequest: request });
        });
        owned = { fence, request };
      }
      const save = async (next: Record<string, unknown> | null, receipt?: ForceMigrationReceipt): Promise<void> => {
        const current = owned!;
        await store.transaction({ label: "fleet-force-migration.save" }, async tx => {
          const fresh = await readForceMigrationPlanInTransaction(tx, target, current);
          if (!isDeepStrictEqual(fresh, current.fence.plan)) throw new Error("force migration authority changed during restart");
          await tx.gateways.roots.compareAndSetRuntimeRestartFence(
            target.fromGatewayId, restartFence(current.fence), next ? restartFence(next) : null,
          );
          if (!next) await tx.journal.operations.patch(target.operationId, {
            forceDrainRequest: { ...current.request, completedAt: now(), podUid: pod.podUid, containerImage: pod.containerImage, receipt },
            nextAttemptAt: now(),
          });
        });
        if (next) owned = { ...current, fence: next };
      };
      if (owned.fence.phase === "reserved") {
        await save({ ...owned.fence, phase: "dispatched" });
        await transport.dispatch(pod);
      }
      const receipt = await transport.observe(pod, String(owned.fence.attemptId));
      verifyReceipt(receipt, owned.fence);
      await save(null, receipt);
      return result(target, { ...owned.request, completedAt: now() });
    },
  });
}
