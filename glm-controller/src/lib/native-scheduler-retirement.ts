import { FieldValue, type DocumentData, type Firestore } from "firebase-admin/firestore";
import type { MigrationClient } from "@octogee/core/fleet-migration-client";
import type { GatewayVmClient } from "./compute-vm.js";

export interface NativeSchedulerRetirementInput {
  uid: string;
  slug: string;
  gatewayId: string;
  operationId: string;
  claimedStartedAt: number | null;
}

type ReturnInput = { uid: string; slug: string; fromGatewayId: string; toGatewayId: string; operationId: string };
type Retirement = Record<"uid" | "slug" | "returnOperationId" | "migrationId" | "sourceGatewayId" | "sharedGatewayId" |
  "instanceName" | "instanceId" | "zone" | "homeDiskId" | "homeDiskSource", string> & { completedAt?: number; cutoverCommittedAt?: number };
const KEYS: Array<keyof Omit<Retirement, "completedAt" | "cutoverCommittedAt">> = ["uid", "slug", "returnOperationId", "migrationId", "sourceGatewayId", "sharedGatewayId",
  "instanceName", "instanceId", "zone", "homeDiskId", "homeDiskSource"];

export function readNativeSchedulerRetirement(data: DocumentData | undefined): Retirement | null {
  if (data === undefined) return null;
  if (!data || KEYS.some(key => typeof data[key] !== "string" || !data[key])) throw new Error("native scheduler retirement authority is malformed");
  if ((data.completedAt !== undefined || data.cutoverCommittedAt !== undefined) &&
      !(typeof data.completedAt === "number" && Number.isFinite(data.completedAt) &&
        typeof data.cutoverCommittedAt === "number" && data.cutoverCommittedAt > 0 && data.completedAt >= data.cutoverCommittedAt)) {
    throw new Error("native scheduler retirement completion authority is malformed");
  }
  return data as Retirement;
}

function sameRetirement(a: Retirement | null, b: Retirement): boolean {
  return a !== null && KEYS.every(key => a[key] === b[key]) && a.completedAt === b.completedAt && a.cutoverCommittedAt === b.cutoverCommittedAt;
}

function handoffMatches(handoff: DocumentData, input: ReturnInput): boolean {
  return handoff.uid === input.uid && handoff.slug === input.slug &&
    handoff.fromGatewayId === input.fromGatewayId && handoff.toGatewayId === input.toGatewayId;
}

function retainedIdentity(user: DocumentData | undefined, runtime: DocumentData | undefined) {
  const home = user?.provisioning?.homeDisk, vm = runtime?.vm;
  return { instanceName: vm?.instanceName, instanceId: vm?.instanceId, zone: vm?.zone, homeDiskId: home?.id, homeDiskSource: home?.source };
}

export function nativeSchedulerRetirementForReturn(
  input: ReturnInput, user: DocumentData | undefined, runtime: DocumentData | undefined, operation: DocumentData | undefined,
): Retirement | null {
  const handoff = operation?.schedulerHandoff;
  if (!handoff) return null;
  if (!handoffMatches(handoff, input)) throw new Error("native scheduler retirement handoff authority changed");
  const record = readNativeSchedulerRetirement({ uid: input.uid, slug: input.slug, returnOperationId: input.operationId, migrationId: handoff.migrationId,
    sourceGatewayId: input.fromGatewayId, sharedGatewayId: input.toGatewayId,
    ...retainedIdentity(user, runtime) })!;
  const existing = readNativeSchedulerRetirement(user?.provisioning?.pendingNativeSchedulerRetirement);
  if (existing && !KEYS.every(key => existing[key] === record[key])) throw new Error("another native scheduler retirement remains pending");
  return existing ?? record;
}

type Deps = {
  db: Pick<Firestore, "collection" | "runTransaction">;
  vm: Pick<GatewayVmClient, "describe">;
  log: (message: string) => void;
};

function activeAttempt(op: DocumentData | undefined, input: NativeSchedulerRetirementInput): boolean {
  return op?.kind === "migrate-customer" && op.status === "running" && typeof input.claimedStartedAt === "number" &&
    op.startedAt === input.claimedStartedAt && op.cancellationRequestedAt === undefined &&
    op.input?.uid === input.uid && op.input.toGatewayId === input.gatewayId && typeof op.cutoverCommittedAt === "number";
}

export function isCompletedNativeReturn(op: DocumentData | undefined, pending: Retirement): boolean {
  if (pending.completedAt === undefined || pending.cutoverCommittedAt === undefined) return false;
  if (op === undefined) return true;
  const h = op.schedulerHandoff;
  return op.kind === "migrate-customer" && op.status === "succeeded" && op.cutoverCommittedAt === pending.cutoverCommittedAt &&
    op.input?.uid === pending.uid && op.input.fromGatewayId === pending.sourceGatewayId && op.input.toGatewayId === pending.sharedGatewayId &&
    h?.migrationId === pending.migrationId && handoffMatches(h, {
      uid: pending.uid, slug: pending.slug, fromGatewayId: pending.sourceGatewayId,
      toGatewayId: pending.sharedGatewayId, operationId: pending.returnOperationId,
    });
}

function ownerMatches(p: DocumentData | undefined, input: NativeSchedulerRetirementInput, pending: Retirement): boolean {
  return sameRetirement(readNativeSchedulerRetirement(p?.pendingNativeSchedulerRetirement), pending) &&
    pending.uid === input.uid && pending.slug === input.slug && p?.openclaw?.gatewayId === input.gatewayId &&
    p?.homeDisk?.id === pending.homeDiskId && p.homeDisk.source === pending.homeDiskSource;
}

function targetMatches(root: DocumentData | undefined, runtime: DocumentData | undefined, input: NativeSchedulerRetirementInput, pending: Retirement): boolean {
  const vm = runtime?.vm;
  return root?.gatewayClass === "builder" && root.ownerUid === input.uid && root.builderSlug === input.slug && root.desiredStatus === "running" &&
    runtime?.runtime === "gce-vm" && vm?.instanceName === pending.instanceName && vm.instanceId === pending.instanceId && vm.zone === pending.zone;
}

async function authorize(deps: Deps, input: NativeSchedulerRetirementInput, pending: Retirement, acknowledge = false): Promise<void> {
  await deps.db.runTransaction(async tx => {
    const userRef = deps.db.collection("users").doc(input.uid);
    const [user, root, runtime, current, previous] = await Promise.all([
      tx.get(userRef), tx.get(deps.db.collection("gateways").doc(input.gatewayId)),
      tx.get(deps.db.collection("glmGateways").doc(input.gatewayId)),
      tx.get(deps.db.collection("glmOperations").doc(input.operationId)),
      tx.get(deps.db.collection("glmOperations").doc(pending.returnOperationId)),
    ]);
    const exact = ownerMatches(user.data()?.provisioning, input, pending) &&
      targetMatches(root.data(), runtime.data(), input, pending) &&
      activeAttempt(current.data(), input) && isCompletedNativeReturn(previous.data(), pending);
    if (!exact) throw new Error("native scheduler retirement authority changed");
    if (acknowledge) tx.update(userRef, { "provisioning.pendingNativeSchedulerRetirement": FieldValue.delete() });
  });
}

export async function retireNativeSchedulerBeforeStage(
  deps: Deps, input: NativeSchedulerRetirementInput, scheduler: MigrationClient["scheduler"],
): Promise<void> {
  const user = await deps.db.collection("users").doc(input.uid).get();
  const pending = readNativeSchedulerRetirement(user.data()?.provisioning?.pendingNativeSchedulerRetirement);
  if (!pending) return;
  const target = await deps.db.collection("glmGateways").doc(input.gatewayId).get();
  if (target.data()?.runtime !== "gce-vm") return;
  await authorize(deps, input, pending);
  const vm = await deps.vm.describe(pending.instanceName, pending.zone);
  if (vm?.instanceId !== pending.instanceId || vm.gatewayId !== input.gatewayId || vm.status !== "RUNNING") {
    throw new Error("native scheduler retirement computer identity changed");
  }
  await authorize(deps, input, pending);
  const result = await scheduler({ migrationId: pending.migrationId, gatewayId: input.gatewayId, slug: input.slug, phase: "retire" });
  if (result.operationId !== pending.migrationId || result.phase !== "retire" || result.drained !== true) {
    throw new Error("native scheduler retirement acknowledgement changed");
  }
  await authorize(deps, input, pending, true);
  deps.log(`[migrate-customer] ${input.slug}: retired exported native schedules ${pending.migrationId} on retained computer ${pending.instanceId}`);
}
