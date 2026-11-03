import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { FieldValue, type DocumentReference, type Firestore } from "firebase-admin/firestore";
import { GLM_MIGRATION_TRANSFER_TASKS_COLLECTION } from "@octogee/shared/types/glm";
import type { MigrationClient } from "@octogee/core/fleet-migration-client";
import type { CommandRunner } from "./migration-rsync-transfer.js";

export interface ControllerPodIdentity { name: string; uid: string }
export interface TransferClaim {
  taskId: string;
  ref: DocumentReference;
  attempt: number;
  attemptId: string;
  workerId: string;
}

interface LeaseDeps {
  db: Firestore;
  now: () => number;
  workerId: string;
  leaseMs: number;
  namespace: string;
  runCommand: CommandRunner;
  controllerPod?: ControllerPodIdentity;
  log: (message: string) => void;
  beforeRecovery: () => Promise<void>;
}

export function controllerPodIdentity(env: NodeJS.ProcessEnv): ControllerPodIdentity | undefined {
  if (env.POD_NAME === undefined && env.POD_UID === undefined) return undefined;
  const value = { name: env.POD_NAME, uid: env.POD_UID };
  if (!isPodIdentity(value)) throw new Error("invalid controller pod identity");
  return value;
}

function isPodIdentity(value: unknown): value is ControllerPodIdentity {
  if (!value || typeof value !== "object") return false;
  const pod = value as ControllerPodIdentity;
  return typeof pod.name === "string" && /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/.test(pod.name) &&
    typeof pod.uid === "string" && /^[A-Za-z0-9-]{1,128}$/.test(pod.uid);
}

async function observeControllerPod(deps: Pick<LeaseDeps, "runCommand" | "namespace">, pod: ControllerPodIdentity): Promise<{ gone: boolean; restartCount?: number }> {
  const result = await deps.runCommand("kubectl", ["-n", deps.namespace, "get", "pod", pod.name, "--ignore-not-found", "-o", "json"], { timeoutMs: 15_000 });
  if (result.code !== 0) throw new Error(`controller pod observation failed: ${result.stderr || result.stdout}`);
  if (!result.stdout.trim()) return { gone: true };
  let observed: { metadata?: { name?: string; uid?: string }; status?: { containerStatuses?: Array<{ name?: string; restartCount?: number }> } };
  try { observed = JSON.parse(result.stdout); } catch { throw new Error("invalid controller pod observation"); }
  if (observed?.metadata?.name !== pod.name || typeof observed.metadata.uid !== "string" || !observed.metadata.uid) throw new Error("invalid controller pod observation");
  if (observed.metadata.uid !== pod.uid) return { gone: true };
  return { gone: false, restartCount: observed.status?.containerStatuses?.find(container => container.name === "glm-controller")?.restartCount };
}

async function claimRecovery(deps: LeaseDeps, taskId: string, observed: Record<string, unknown> | undefined): Promise<boolean> {
  if (observed?.status !== "running") return false;
  if (!isPodIdentity(observed.leasePod)) throw new Error(`transfer task ${taskId} is already running; owner identity unavailable`);
  if (!await ownerPodGone(deps, observed.leasePod, observed.leaseRestartCount)) {
    throw new Error(`transfer task ${taskId} is already running (leaseOwner=${observed.leaseOwner ?? "unknown"}); owner remains present`);
  }
  await deps.beforeRecovery();
  return true;
}

function assertTaskIdentity(existing: Record<string, unknown> | undefined, taskId: string, input: Parameters<MigrationClient["transferState"]>[0]): void {
  if (existing && [[existing.migrationId, input.migrationId], [existing.slug, input.slug],
    [existing.sourceGatewayId, input.fromGatewayId], [existing.targetGatewayId, input.toGatewayId],
    [existing.mode, input.mode ?? "pre"]].some(([actual, expected]) => actual !== expected)) throw new Error(`transfer task ${taskId} identity changed`);
}

async function ownerPodGone(deps: Pick<LeaseDeps, "runCommand" | "namespace">, pod: ControllerPodIdentity, restartCount: unknown): Promise<boolean> {
  const observed = await observeControllerPod(deps, pod);
  return observed.gone || Number.isSafeInteger(restartCount) && (restartCount as number) >= 0 && Number.isSafeInteger(observed.restartCount) && observed.restartCount! > (restartCount as number);
}

export async function readTransferAttemptForCleanup(
  deps: Pick<LeaseDeps, "db" | "now" | "runCommand" | "namespace">,
  input: Parameters<MigrationClient["abortImport"]>[0],
): Promise<string | undefined> {
  const ref = deps.db.collection(GLM_MIGRATION_TRANSFER_TASKS_COLLECTION).doc(`${input.migrationId.replace(/[^A-Za-z0-9._-]/g, "_")}__${input.mode}`);
  const observed = (await ref.get()).data();
  if (!observed) return undefined;
  if (observed.migrationId !== input.migrationId || observed.slug !== input.slug || observed.mode !== input.mode || observed.targetGatewayId !== input.gatewayId) {
    throw new Error("transfer cleanup identity changed");
  }
  if (observed.status === "running" && (!isPodIdentity(observed.leasePod) || !await ownerPodGone(deps, observed.leasePod, observed.leaseRestartCount))) {
    throw new Error("transfer cleanup refused while its owner may still be running");
  }
  if (!isDeepStrictEqual((await ref.get()).data(), observed)) throw new Error("transfer cleanup claim changed");
  if (observed.attemptId === undefined) return undefined;
  if (typeof observed.attemptId !== "string" || !observed.attemptId) throw new Error("invalid transfer cleanup attempt");
  return observed.attemptId;
}

export async function claimTransferTask(deps: LeaseDeps, taskId: string, input: Parameters<MigrationClient["transferState"]>[0]): Promise<TransferClaim> {
  const ref = deps.db.collection(GLM_MIGRATION_TRANSFER_TASKS_COLLECTION).doc(taskId);
  const observed = (await ref.get()).data();
  const recover = await claimRecovery(deps, taskId, observed);
  const ownPod = deps.controllerPod ? await observeControllerPod(deps, deps.controllerPod) : undefined;
  if (ownPod && (ownPod.gone || !Number.isSafeInteger(ownPod.restartCount) || ownPod.restartCount! < 0)) throw new Error("controller container identity unavailable");
  const attemptId = randomUUID();
  const claim = await deps.db.runTransaction(async tx => {
    const existing = (await tx.get(ref)).data();
    const now = deps.now();
    if (recover ? !isDeepStrictEqual(existing, observed) : existing?.status === "running") {
      throw new Error(`transfer task ${taskId} is already running (leaseOwner=${existing?.leaseOwner ?? "unknown"}); claim changed or owner remains present`);
    }
    assertTaskIdentity(existing, taskId, input);
    const attempt = Number(existing?.attempt ?? 0) + 1;
    tx.set(ref, {
      kind: "gateway-rsync-transfer", migrationId: input.migrationId, slug: input.slug,
      mode: input.mode ?? "pre", sourceGatewayId: input.fromGatewayId, targetGatewayId: input.toGatewayId,
      status: "running", attempt, attemptId, leaseOwner: deps.workerId,
      leasePod: deps.controllerPod ?? FieldValue.delete(), leaseExpiresAt: now + deps.leaseMs,
      leaseRestartCount: ownPod?.restartCount ?? FieldValue.delete(),
      createdAt: existing?.createdAt ?? now, updatedAt: now, startedAt: now,
      completedAt: FieldValue.delete(), error: FieldValue.delete(),
    }, { merge: true });
    return { taskId, ref, attempt, attemptId, workerId: deps.workerId };
  });
  if (recover) deps.log(`[migration-rsync] reclaimed abandoned transfer task=${taskId} attempt=${claim.attempt} previousOwner=${String(observed?.leaseOwner)}`);
  return claim;
}

function ownsClaim(task: Record<string, unknown> | undefined, claim: TransferClaim): boolean {
  return task?.status === "running" && task.attempt === claim.attempt && task.attemptId === claim.attemptId && task.leaseOwner === claim.workerId;
}

export async function assertTransferClaim(claim: TransferClaim): Promise<void> {
  if (!ownsClaim((await claim.ref.get()).data(), claim)) throw new Error(`transfer task ${claim.taskId} attempt ownership changed`);
}

export async function finishTransferTask(db: Firestore, claim: TransferClaim, now: () => number, error?: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await db.runTransaction(async tx => {
    if (!ownsClaim((await tx.get(claim.ref)).data(), claim)) throw new Error(`transfer task ${claim.taskId} attempt ownership changed`);
    tx.set(claim.ref, {
      status: error === undefined ? "succeeded" : "failed", completedAt: now(), updatedAt: now(),
      leaseOwner: FieldValue.delete(), leasePod: FieldValue.delete(), leaseRestartCount: FieldValue.delete(), leaseExpiresAt: FieldValue.delete(),
      error: error === undefined ? FieldValue.delete() : message,
    }, { merge: true });
  });
}
