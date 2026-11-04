import { FieldValue, type Firestore } from "firebase-admin/firestore";
import { GATEWAYS_COLLECTION } from "@octogee/shared/types/fleet-controller";
import {
  GLM_GATEWAYS_COLLECTION,
  GLM_OPERATIONS_COLLECTION,
  builderComputerInstanceName,
  resolveGatewayRuntime,
  homeCheckpointOutstanding,
  isGatewayVmBootRecoverySample,
  sameHomeCheckpoint,
  type GatewayVmHomeCheckpoint,
  type RetainedBuilderHome,
  isGatewayVmBootDiskType,
  isGatewayVmDesktop,
  isGatewayVmPreemptionNotice,
  type GatewayVmBootDiskType,
  type GatewayVmDesktop,
  type GatewayVmHomeState,
  type GatewayVmParkedCheckpoint,
  type GatewayVmSpec,
  type GatewayVmState,
  type GatewayVmStopReason,
} from "@octogee/shared/types/glm";
import type { BindGatewayVmInput, CreateGatewayVmInput, GatewayVmClient, GatewayVmDescription } from "./lib/compute-vm.js";
import { hasComputerIdentity } from "./lib/compute-vm.js";
import {
  HOME_CHECKPOINT_POLL_MS,
  HOME_CHECKPOINT_TIMEOUT_MS,
  awaitHomeCheckpoint,
  homeCheckpointCompletedAt,
  readHomeCheckpointCompletedAt,
  readVmHome,
} from "./lib/home-checkpoint.js";
import { readRetainedBuilderHome, recordRetainedBuilderHome, readHomeRecovery, readParkedComputer, releaseParkedComputer, writeParkedComputer } from "./lib/parked-computer.js";
import { selectRetainedBootImage, type RetainedBootImage } from "./lib/retained-boot-image.js";
import { occupiedComputerZones, spreadZones } from "./vm-placement.js";
import { assertComputerRecoveryFence, finishComputerRecovery } from "./lib/computer-recovery-fence.js";

export const STOPPED_STATUSES: ReadonlySet<string> = new Set(["TERMINATED", "STOPPED"]);
export const PARKED_STATUSES: ReadonlySet<string> = new Set([...STOPPED_STATUSES, "SUSPENDED"]);
const TRANSITIONAL_STATUSES = new Set(["STOPPING", "SUSPENDING"]);
const COWBOY_STOP_REASONS = new Set<GatewayVmStopReason>(["idle", "operator"]);

export interface ComputerLifecycleDeps {
  db: Firestore;
  vm: GatewayVmClient;
  environment: string;
  vmSpec: GatewayVmSpec;
  readDesiredStatus: (gatewayId: string) => Promise<string | null>;
  journalBootUpgrade: (input: { gatewayId: string; ownerUid: string; instanceId: string; imageId: string }, work: (assertAuthority: () => Promise<void>) => Promise<void>) => Promise<void>;
  resolveBridge: () => Promise<string>;
  reconcileRoutes: () => Promise<void>;
  wait: (ms: number) => Promise<void>;
  disposableParking?: boolean;
  homeCheckpointTimeoutMs?: number;
  homeCheckpointPollMs?: number;
  now: () => number;
  log: (msg: string) => void;
}

export interface ParkComputerOptions {
  awaitHomeCheckpoint?: boolean;
}

export interface ComputerLifecycle {
  readDeploymentPrerequisiteError(gatewayId: string): Promise<string | null>;
  ensureVm(gatewayId: string, image: string, ownerUid: string | undefined, bridge: string): Promise<GatewayVmState>;
  parkComputer(gatewayId: string, opts?: ParkComputerOptions): Promise<GatewayVmState | null>;
  pauseComputer(gatewayId: string): Promise<void>;
  recoverUnreachable(gatewayId: string): Promise<void>;
  deleteComputer(ownerUid: string): Promise<boolean>;
  replaceStoppedComputer(gatewayId: string, operationId: string, assertAuthority: () => Promise<void>, options?: { forceOwnerUid: string; expectedInstanceId: string }): Promise<Record<string, unknown>>;
  detectPreemption(gatewayId: string, sinceMs: number): Promise<string | null>;
}

type ParkedVmState = GatewayVmState & { parkedCheckpoint: GatewayVmParkedCheckpoint };
interface ReplacementOptions { boot?: boolean; expectedImageId?: string; forceOwnerUid?: string; expectedInstanceId?: string }

export async function recordVmObservation(
  deps: Pick<ComputerLifecycleDeps, "db" | "log">,
  gatewayId: string,
  observation: Record<string, unknown>,
  what: string,
): Promise<boolean> {
  const ref = deps.db.collection(GLM_GATEWAYS_COLLECTION).doc(gatewayId);
  const recorded = await deps.db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    if (!snap.exists) return false;
    transaction.set(ref, observation, { merge: true });
    return true;
  });
  if (!recorded) deps.log(`[vm-gateway-runtime] ${gatewayId}: runtime record is gone; dropped the ${what} observation instead of re-creating it`);
  return recorded;
}

export function clearReplacedComputer(deps: Pick<ComputerLifecycleDeps, "db" | "log">, gatewayId: string): Promise<boolean> {
  return recordVmObservation(deps, gatewayId, {
    vm: null,
    vmInstance: FieldValue.delete(),
    vmHome: { checkpointRequestedAt: FieldValue.delete(), parkRequestedAt: FieldValue.delete(), checkpointAcknowledgedAt: FieldValue.delete() },
  }, "replacement");
}

function stateFrom(
  description: GatewayVmDescription,
  now: number,
  stopReason: GatewayVmStopReason | null,
): GatewayVmState {
  return {
    instanceName: description.name,
    zone: description.zone,
    instanceId: description.instanceId,
    internalIp: description.internalIp,
    status: description.status,
    startedAt: description.lastStartedAt,
    provisioningModel: description.provisioningModel,
    stopReason,
    updatedAt: now,
  };
}

export function ownerComputerLabels(environment: string, ownerUid: string): Record<string, string> {
  return {
    "octogee-owner-uid": ownerUid.toLowerCase(),
    "octogee-environment": environment,
    purpose: "octogee-computer",
  };
}

function boundElsewhere(description: GatewayVmDescription, gatewayId: string): boolean {
  return description.gatewayId !== null && description.gatewayId !== gatewayId;
}

function computerIdentityPrerequisiteError(description: GatewayVmDescription, email: string): string | null {
  if (hasComputerIdentity(description, email) || PARKED_STATUSES.has(description.status)) return null;
  return `computer ${description.name}: identity scopes are outdated; pause and resume the gateway through Admin to repair them`;
}

function needsPark(description: GatewayVmDescription): boolean {
  return !PARKED_STATUSES.has(description.status) && !TRANSITIONAL_STATUSES.has(description.status);
}

function verifiedStoppedComputer(before: GatewayVmDescription, after: GatewayVmDescription | null, statuses = STOPPED_STATUSES): GatewayVmDescription {
  if (!after || !before.instanceId || after.instanceId !== before.instanceId
    || after.name !== before.name || after.zone !== before.zone
    || !statuses.has(after.status) || after.gatewayId !== before.gatewayId
    || after.metadata["octogee-owner-uid"] !== before.metadata["octogee-owner-uid"]
    || ["octogee-owner-uid", "octogee-environment", "purpose"].some(key => after.labels[key] !== before.labels[key])) {
    throw new Error(`computer ${before.name}: operation requires the same verified stopped computer`);
  }
  return after;
}

function sameObservation(recorded: GatewayVmState, description: GatewayVmDescription, stopReason: GatewayVmStopReason | null): boolean {
  return recorded.status === description.status
    && recorded.internalIp === description.internalIp
    && recorded.instanceId === description.instanceId
    && (recorded.startedAt ?? null) === description.lastStartedAt
    && (recorded.stopReason ?? null) === stopReason;
}

function parkedCheckpointFrom(home: Partial<GatewayVmHomeState> | undefined): GatewayVmParkedCheckpoint {
  const requestedAt = typeof home?.parkRequestedAt === "number" ? home.parkRequestedAt : null;
  const completedAt = homeCheckpointCompletedAt(home);
  const fresh = requestedAt !== null && completedAt !== null && !homeCheckpointOutstanding({ ...home, checkpointRequestedAt: requestedAt });
  return { outcome: fresh ? "fresh" : "stale", requestedAt, completedAt };
}

export class FinalHomeCheckpointPendingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FinalHomeCheckpointPendingError";
  }
}

function staleAtBound(
  deps: ComputerLifecycleDeps,
  gatewayId: string,
  description: GatewayVmDescription,
  requestedAt: number,
  completedAt: number | null,
): GatewayVmParkedCheckpoint {
  const timeoutMs = deps.homeCheckpointTimeoutMs ?? HOME_CHECKPOINT_TIMEOUT_MS;
  deps.log(`[vm-gateway-runtime] ⚠ ${gatewayId}: ${description.name} did not complete its final home checkpoint within ${timeoutMs}ms; parking stale (last checkpoint ${completedAt ?? "never"})`);
  return { outcome: "stale", requestedAt, completedAt };
}

function reusableParkRequest(home: Partial<GatewayVmHomeState> | undefined, description: GatewayVmDescription): number | null {
  const requestedAt = home?.parkRequestedAt;
  if (typeof requestedAt !== "number" || home?.checkpointRequestedAt !== requestedAt) return null;
  return description.lastStartedAt !== null && requestedAt < description.lastStartedAt ? null : requestedAt;
}

function completedParkCheckpoint(home: Partial<GatewayVmHomeState> | undefined, description: GatewayVmDescription, requestedAt: number): number | null {
  const completedAt = homeCheckpointCompletedAt(home);
  return completedAt !== null && home?.checkpointRequestedAt === requestedAt
    && (home.lastCheckpoint?.instanceId === undefined || home.lastCheckpoint.instanceId === description.instanceId)
    && !homeCheckpointOutstanding({ ...home, checkpointRequestedAt: requestedAt }) ? completedAt : null;
}

async function finalHomeCheckpoint(
  deps: ComputerLifecycleDeps,
  gatewayId: string,
  description: GatewayVmDescription,
  home: Partial<GatewayVmHomeState> | undefined,
  opts: ParkComputerOptions,
): Promise<GatewayVmParkedCheckpoint> {
  const timeoutMs = deps.homeCheckpointTimeoutMs ?? HOME_CHECKPOINT_TIMEOUT_MS;
  let requestedAt = reusableParkRequest(home, description);
  if (requestedAt === null) {
    requestedAt = deps.now();
    await recordVmObservation(deps, gatewayId, { vmHome: { checkpointRequestedAt: requestedAt, parkRequestedAt: requestedAt } }, "park request");
    deps.log(`[vm-gateway-runtime] ${gatewayId}: requested the final home checkpoint of ${description.name} before parking; waiting up to ${timeoutMs}ms`);
  }
  const completed = completedParkCheckpoint(home, description, requestedAt);
  if (completed !== null) return { outcome: "fresh", requestedAt, completedAt: completed };
  const completedAt = homeCheckpointCompletedAt(home);
  if (opts.awaitHomeCheckpoint) {
    const result = await awaitHomeCheckpoint(
      {
        readHomeCheckpointCompletedAt: async (id) => {
          const home = readVmHome((await readVmRecord(deps.db, id)).data);
          return home?.checkpointRequestedAt === requestedAt && home?.lastCheckpoint?.instanceId === description.instanceId
            ? readHomeCheckpointCompletedAt(deps.db, id) : null;
        },
        wait: deps.wait,
        now: deps.now,
        timeoutMs,
        pollMs: deps.homeCheckpointPollMs ?? HOME_CHECKPOINT_POLL_MS,
      },
      { gatewayId, requestedAt },
    );
    if (result.outcome === "completed") return { outcome: "fresh", requestedAt, completedAt: result.completedAt };
    return staleAtBound(deps, gatewayId, description, requestedAt, await readHomeCheckpointCompletedAt(deps.db, gatewayId));
  }
  if (deps.now() - requestedAt >= timeoutMs) return staleAtBound(deps, gatewayId, description, requestedAt, completedAt);
  throw new FinalHomeCheckpointPendingError(`computer ${description.name} is taking its final home checkpoint (requested at ${requestedAt}); parking on a later converge`);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parkedComputerOwner(data: Record<string, unknown> | undefined, description: GatewayVmDescription): string | null {
  const stamped = (data?.vmInstance as { ownerUid?: unknown } | undefined)?.ownerUid;
  return nonEmptyString(stamped) ?? nonEmptyString(description.metadata["octogee-owner-uid"]);
}

async function recordParkedComputer(
  deps: ComputerLifecycleDeps,
  gatewayId: string,
  ownerUid: string | null,
  parked: ParkedVmState,
  data: Record<string, unknown> | undefined,
): Promise<void> {
  if (!ownerUid) {
    deps.log(`[vm-gateway-runtime] ⚠ ${gatewayId}: parked ${parked.instanceName} without an owner; it is not replaceable while parked`);
    return;
  }
  await writeParkedComputer(deps.db, ownerUid, {
    instanceName: parked.instanceName,
    zone: parked.zone,
    instanceId: parked.instanceId,
    gatewayId,
    parkedAt: parked.updatedAt,
    checkpoint: parked.parkedCheckpoint,
    bootRecovery: data?.vmBootRecovery as import("@octogee/shared/types/glm").BuilderParkedComputer["bootRecovery"],
    vmSpec: data?.vmSpec as GatewayVmSpec | undefined,
  });
}

export interface ComputerInstanceSource {
  gatewayId: string;
  ownerUid: string;
  spec: GatewayVmSpec;
  environment: string;
  image: string;
  bridgeIp: string;
}

export const COMPUTER_DESKTOP_METADATA_KEY = "octogee-computer-desktop";

export function vmSpecDesktop(recorded: Partial<GatewayVmSpec> | undefined, configured: GatewayVmSpec): GatewayVmDesktop {
  if (!recorded) return configured.desktop;
  if (recorded.desktop === undefined) return "omarchy";
  if (!isGatewayVmDesktop(recorded.desktop)) throw new Error(`gateway vmSpec names an unknown desktop ${String(recorded.desktop)}`);
  return recorded.desktop;
}

function recordedBootDiskType(recorded: Partial<GatewayVmSpec>): GatewayVmBootDiskType {
  if (recorded.bootDiskType === undefined) return "pd-ssd";
  if (!isGatewayVmBootDiskType(recorded.bootDiskType)) throw new Error(`gateway vmSpec names an unknown boot disk type ${String(recorded.bootDiskType)}`);
  return recorded.bootDiskType;
}

function bootedDesktop(description: GatewayVmDescription): GatewayVmDesktop {
  const desktop = description.metadata[COMPUTER_DESKTOP_METADATA_KEY];
  if (desktop === undefined) return "omarchy";
  if (!isGatewayVmDesktop(desktop)) throw new Error(`computer ${description.name}: unknown ${COMPUTER_DESKTOP_METADATA_KEY} ${desktop}`);
  return desktop;
}

export function builderComputerInstanceInput(source: ComputerInstanceSource): CreateGatewayVmInput {
  return {
    instanceName: builderComputerInstanceName(source.environment, source.ownerUid),
    ...source.spec,
    labels: {
      "octogee-gateway-id": source.gatewayId.toLowerCase(),
      ...ownerComputerLabels(source.environment, source.ownerUid),
    },
    metadata: {
      "gateway-id": source.gatewayId,
      "octogee-owner-uid": source.ownerUid,
      "octogee-environment": source.environment,
      "gateway-image": source.image,
      "octogee-api-url": `http://${source.bridgeIp}:3001`,
      [COMPUTER_DESKTOP_METADATA_KEY]: source.spec.desktop,
    },
  };
}

function recordedSpecInConfiguredZones(recorded: GatewayVmSpec | undefined, configured: GatewayVmSpec): GatewayVmSpec {
  if (!recorded) return configured;
  const { machineType, imageFamily, imageProject, diskSizeGb, homeDiskSizeGb, provisioningModel, serviceAccountEmail, subnetwork } = recorded;
  const bootDiskType = recordedBootDiskType(recorded);
  return {
    zones: configured.zones,
    machineType, imageFamily, ...(imageProject ? { imageProject } : {}), diskSizeGb, bootDiskType, homeDiskSizeGb, provisioningModel,
    desktop: vmSpecDesktop(recorded, configured), serviceAccountEmail, subnetwork,
  };
}

function bindingOf(input: CreateGatewayVmInput): BindGatewayVmInput {
  return { labels: input.labels, metadata: input.metadata };
}

async function readVmRecord(db: Firestore, gatewayId: string): Promise<{ data: Record<string, unknown> | undefined; vm: GatewayVmState | null }> {
  const snap = await db.collection(GLM_GATEWAYS_COLLECTION).doc(gatewayId).get();
  const data = (snap.exists ? snap.data() : undefined) as Record<string, unknown> | undefined;
  const vm = data?.vm as GatewayVmState | null | undefined;
  return { data, vm: vm ?? null };
}

async function readComputerDeploymentPrerequisiteError(deps: ComputerLifecycleDeps, gatewayId: string): Promise<string | null> {
  const { data, vm } = await readVmRecord(deps.db, gatewayId);
  let description = vm ? await deps.vm.describe(vm.instanceName, vm.zone) : null;
  if (!description) {
    const gateway = await deps.db.collection(GATEWAYS_COLLECTION).doc(gatewayId).get();
    const ownerUid = nonEmptyString(gateway.data()?.ownerUid);
    if (!ownerUid) return `gateway ${gatewayId}: a gce-vm Builder gateway needs an owner`;
    description = await deps.vm.findByLabels(ownerComputerLabels(deps.environment, ownerUid));
  }
  if (!description || description.status === "STOPPING") return null;
  const spec = (data?.vmSpec as GatewayVmSpec | undefined) ?? deps.vmSpec;
  return computerIdentityPrerequisiteError(description, spec.serviceAccountEmail);
}

async function externalStopCause(
  deps: ComputerLifecycleDeps,
  gatewayId: string,
  description: GatewayVmDescription,
  recorded: GatewayVmState,
): Promise<string> {
  let preemptedAt: number | null = null;
  try {
    preemptedAt = await deps.vm.lastPreemptedAt(description.name, description.zone);
  } catch (err) {
    deps.log(`[vm-gateway-runtime] ⚠ ${gatewayId}: could not read Compute preemptions of ${description.name}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (preemptedAt !== null && preemptedAt >= recorded.updatedAt) {
    return `was preempted by Compute at ${new Date(preemptedAt).toISOString()} -> ${description.status}`;
  }
  if (recorded.stopReason === "preempted") return `was preempted by Compute -> ${description.status}`;
  return `was already ${description.status} (stopped outside Cowboy)`;
}

function announcedPreemptionAt(data: Record<string, unknown> | undefined, vm: GatewayVmState, sinceMs: number): number | null {
  const notice = data?.vmPreemption;
  if (!isGatewayVmPreemptionNotice(notice) || notice.instanceId !== vm.instanceId) return null;
  return notice.announcedAt >= sinceMs ? notice.announcedAt : null;
}

async function detectComputerPreemption(deps: ComputerLifecycleDeps, gatewayId: string, sinceMs: number): Promise<string | null> {
  const { data, vm } = await readVmRecord(deps.db, gatewayId);
  if (resolveGatewayRuntime(data?.runtime) !== "gce-vm" || !vm) return null;
  const announcedAt = announcedPreemptionAt(data, vm, sinceMs);
  if (announcedAt !== null) {
    deps.log(`[vm-gateway-runtime] ${gatewayId}: ${vm.instanceName} announced its preemption at ${new Date(announcedAt).toISOString()}, during work that started at ${new Date(sinceMs).toISOString()}`);
    return vm.instanceName;
  }
  const preemptedAt = await deps.vm.lastPreemptedAt(vm.instanceName, vm.zone);
  if (preemptedAt === null || preemptedAt < sinceMs) return null;
  deps.log(`[vm-gateway-runtime] ${gatewayId}: Compute preempted ${vm.instanceName} at ${new Date(preemptedAt).toISOString()}, during work that started at ${new Date(sinceMs).toISOString()}`);
  return vm.instanceName;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function suspendOrStop(deps: ComputerLifecycleDeps, gatewayId: string, description: GatewayVmDescription): Promise<"suspended" | "stopped"> {
  try {
    await deps.vm.suspend(description.name, description.zone);
    return "suspended";
  } catch (err) {
    deps.log(`[vm-gateway-runtime] ⚠ ${gatewayId}: could not suspend ${description.name} (${errorMessage(err)}); stopping it instead`);
  }
  await deps.vm.stop(description.name, description.zone);
  return "stopped";
}

async function stopSuspendedComputer(deps: ComputerLifecycleDeps, gatewayId: string, description: GatewayVmDescription, purpose: string): Promise<GatewayVmDescription> {
  if (description.status !== "SUSPENDED") return description;
  await deps.vm.stop(description.name, description.zone);
  const stopped = verifiedStoppedComputer(description, await deps.vm.describe(description.name, description.zone));
  deps.log(`[vm-gateway-runtime] ${gatewayId}: stopped suspended ${description.name} to ${purpose} -> ${stopped.status}`);
  return stopped;
}

interface StopOnPark {
  operationId: string;
  reason: string;
  claimedAt?: number;
}

function readStopOnPark(data: Record<string, unknown> | undefined): StopOnPark | null {
  const value = data?.vmStopOnPark as Partial<StopOnPark> | undefined;
  if (value === undefined) return null;
  if (typeof value?.operationId !== "string" || !value.operationId || typeof value.reason !== "string" ||
      (value.claimedAt !== undefined && typeof value.claimedAt !== "number")) {
    throw new Error("vmStopOnPark request is malformed");
  }
  return { operationId: value.operationId, reason: value.reason, ...(value.claimedAt === undefined ? {} : { claimedAt: value.claimedAt }) };
}

async function recordAwakeComputer(
  deps: ComputerLifecycleDeps,
  gatewayId: string,
  record: Record<string, unknown>,
): Promise<void> {
  const ref = deps.db.collection(GLM_GATEWAYS_COLLECTION).doc(gatewayId);
  const outcome = await deps.db.runTransaction(async (tx) => {
    const [runtime, root] = await Promise.all([tx.get(ref), tx.get(deps.db.collection(GATEWAYS_COLLECTION).doc(gatewayId))]);
    const stop = readStopOnPark(runtime.data());
    const writer = stop ? await tx.get(deps.db.collection(GLM_OPERATIONS_COLLECTION).doc(stop.operationId)) : null;
    const stale = stop !== null && stop.claimedAt === undefined && root.data()?.desiredStatus === "running" && writer?.data()?.status !== "running";
    tx.set(ref, { ...record, ...(stale ? { vmStopOnPark: FieldValue.delete() } : {}) }, { merge: true });
    return stop ? { stop, stale } : null;
  });
  if (!outcome) return;
  deps.log(outcome.stale
    ? `[vm-gateway-runtime] ${gatewayId}: cleared the leftover stop request of ${outcome.stop.operationId} on wake (${outcome.stop.reason})`
    : `[vm-gateway-runtime] ${gatewayId}: kept the stop request of ${outcome.stop.operationId}; it is claimed, its return is running, or the gateway is no longer running`);
}

async function claimStopOnPark(deps: ComputerLifecycleDeps, gatewayId: string, stopFor: StopOnPark): Promise<boolean> {
  const ref = deps.db.collection(GLM_GATEWAYS_COLLECTION).doc(gatewayId);
  return deps.db.runTransaction(async (tx) => {
    const current = readStopOnPark((await tx.get(ref)).data());
    if (current?.operationId !== stopFor.operationId) return false;
    if (current.claimedAt === undefined) tx.set(ref, { vmStopOnPark: { ...current, claimedAt: deps.now() } }, { merge: true });
    return true;
  });
}

async function releaseConfirmedStop(deps: ComputerLifecycleDeps, gatewayId: string, stopFor: StopOnPark): Promise<void> {
  const ref = deps.db.collection(GLM_GATEWAYS_COLLECTION).doc(gatewayId);
  await deps.db.runTransaction(async (tx) => {
    if (readStopOnPark((await tx.get(ref)).data())?.operationId !== stopFor.operationId) return;
    tx.set(ref, { vmStopOnPark: FieldValue.delete() }, { merge: true });
  });
}

async function parkNow(
  deps: ComputerLifecycleDeps,
  gatewayId: string,
  description: GatewayVmDescription,
  stopFor: StopOnPark | undefined,
): Promise<{ description: GatewayVmDescription; verb: string; parkedHere: boolean }> {
  const status = description.status;
  const wouldStop = stopFor !== undefined && (status === "SUSPENDED" || needsPark(description));
  if (wouldStop && !await claimStopOnPark(deps, gatewayId, stopFor)) {
    deps.log(`[vm-gateway-runtime] ${gatewayId}: the stop request of ${stopFor.operationId} was withdrawn; parking normally`);
    return parkNow(deps, gatewayId, description, undefined);
  }
  if (stopFor && status === "SUSPENDED") {
    const stopped = await stopSuspendedComputer(deps, gatewayId, description, `satisfy ${stopFor.operationId} (${stopFor.reason})`);
    await releaseConfirmedStop(deps, gatewayId, stopFor);
    return { description: stopped, verb: "stopped", parkedHere: true };
  }
  if (!needsPark(description)) return { description, verb: status === "SUSPENDED" ? "suspended" : "stopped", parkedHere: false };
  if (stopFor) {
    deps.log(`[vm-gateway-runtime] ${gatewayId}: stopping ${description.name} instead of suspending it for ${stopFor.operationId}: ${stopFor.reason}`);
    await deps.vm.stop(description.name, description.zone);
    const stopped = verifiedStoppedComputer(description, await deps.vm.describe(description.name, description.zone));
    await releaseConfirmedStop(deps, gatewayId, stopFor);
    return { description: stopped, verb: "stopped", parkedHere: true };
  }
  const verb = await suspendOrStop(deps, gatewayId, description);
  return { description: verifiedStoppedComputer(description, await deps.vm.describe(description.name, description.zone), PARKED_STATUSES), verb, parkedHere: true };
}

async function parkComputerInstance(
  deps: ComputerLifecycleDeps,
  gatewayId: string,
  described: GatewayVmDescription,
  recorded: GatewayVmState,
  park: { reason: GatewayVmStopReason; note?: string; stopFor?: StopOnPark },
): Promise<GatewayVmState> {
  const { reason, note = "", stopFor } = park;
  const { description: parkedDescription, verb, parkedHere } = await parkNow(deps, gatewayId, described, stopFor);
  const description = verifiedStoppedComputer(described, parkedDescription, PARKED_STATUSES);
  const cowboyPark = parkedHere || (recorded.stopReason !== null && COWBOY_STOP_REASONS.has(recorded.stopReason));
  const what = cowboyPark
    ? `${verb} ${description.name} for ${reason} -> ${description.status}`
    : `${description.name} ${await externalStopCause(deps, gatewayId, description, recorded)}; parked for ${reason}`;
  deps.log(`[vm-gateway-runtime] ${gatewayId}: ${what}; boot and home disks retained${note}`);
  const sameStoppedGeneration = !parkedHere && PARKED_STATUSES.has(recorded.status ?? "")
    && recorded.instanceId === description.instanceId && (description.lastStartedAt === null || description.lastStartedAt <= recorded.updatedAt);
  return stateFrom(description, sameStoppedGeneration ? recorded.updatedAt : deps.now(), reason);
}

async function assertComputerUnbound(deps: ComputerLifecycleDeps, gatewayId: string, description: GatewayVmDescription): Promise<void> {
  if (!description.instanceId) return;
  const snap = await deps.db.collection(GLM_GATEWAYS_COLLECTION).where("vm.instanceId", "==", description.instanceId).get();
  const holders = snap.docs.map((doc) => doc.id).filter((id) => id !== gatewayId);
  if (holders.length > 0) {
    throw new Error(`computer ${description.name} is still recorded by gateway ${holders.join(", ")}; waiting for its retirement to finish`);
  }
}

async function requireHomeRecovery(deps: ComputerLifecycleDeps, input: { gatewayId: string; ownerUid: string; data: Record<string, unknown> | undefined; description: GatewayVmDescription | null }): Promise<GatewayVmHomeCheckpoint | null> {
  const { gatewayId, ownerUid, data, description } = input;
  const parked = await readParkedComputer(deps.db, ownerUid);
  const recovery = await readHomeRecovery(deps.db, ownerUid);
  if (parked?.disposable && !recovery) throw new Error(`Builder ${ownerUid}: disposable home recovery checkpoint is missing`);
  const required = readVmHome(data)?.restoreCheckpoint;
  if (recovery && description?.instanceId !== recovery.instanceId && (!required || !sameHomeCheckpoint(required, recovery))) {
    const transferred = await recordVmObservation(deps, gatewayId, {
      vmHome: { restoreCheckpoint: recovery, checkpointRequestedAt: FieldValue.delete(), parkRequestedAt: FieldValue.delete(), checkpointAcknowledgedAt: FieldValue.delete() },
    }, "required home restore");
    if (!transferred) throw new Error(`gateway ${gatewayId}: cannot persist the required home restore`);
  }
  return recovery;
}

async function recordComputerHome(deps: ComputerLifecycleDeps, input: { gatewayId: string; ownerUid: string;
  description: GatewayVmDescription; retainedHome: RetainedBuilderHome | null; recovery: GatewayVmHomeCheckpoint | null }): Promise<RetainedBuilderHome> {
    const { gatewayId, ownerUid, description, retainedHome, recovery } = input;
    const home = await deps.vm.retainHome(description.name, description.zone, ownerUid);
    if (!recovery || description.instanceId === recovery.instanceId || retainedHome) {
      await recordRetainedBuilderHome(deps.db, ownerUid, home);
    }
    if (retainedHome) {
      if (home.id !== retainedHome.id || home.source !== retainedHome.source) throw new Error(`Builder ${ownerUid}: computer attached another home`);
      await recordVmObservation(deps, gatewayId, { vmHome: { restoreCheckpoint: FieldValue.delete() } }, "retained home disk");
    }
    return home;
 }

async function deleteOwnedComputer(deps: ComputerLifecycleDeps, ownerUid: string): Promise<boolean> {
    const description = await deps.vm.findByLabels(ownerComputerLabels(deps.environment, ownerUid));
    let home = await readRetainedBuilderHome(deps.db, ownerUid);
    if (!description) {
      if (home) {
        await deps.vm.deleteRetainedHome(home, ownerUid);
        await deps.db.collection("users").doc(ownerUid).set({ provisioning: { homeDisk: FieldValue.delete() } }, { merge: true });
        return true;
      }
      deps.log(`[vm-gateway-runtime] ${ownerUid} has no computer to delete`);
      return false;
    }
    home ??= await deps.vm.retainHome(description.name, description.zone, ownerUid);
    await recordRetainedBuilderHome(deps.db, ownerUid, home);
    await deps.vm.delete(description.name, description.zone);
    await deps.vm.deleteRetainedHome(home, ownerUid);
    await deps.db.collection("users").doc(ownerUid).set({ provisioning: { homeDisk: FieldValue.delete() } }, { merge: true });
    deps.log(`[vm-gateway-runtime] deleted computer ${description.name} in ${description.zone} (was ${description.status}, bound to ${description.gatewayId ?? "no gateway"})`);
    return true;
  }


function assertReplacementOwner(deps: ComputerLifecycleDeps, data: Record<string, unknown> | undefined, description: GatewayVmDescription): string {
  const ownerUid = parkedComputerOwner(data, description);
  if (!ownerUid || description.metadata["octogee-owner-uid"] !== ownerUid
    || Object.entries(ownerComputerLabels(deps.environment, ownerUid)).some(([key, value]) => description.labels[key] !== value)) throw new Error("boot replacement computer owner/environment/purpose differs");
  return ownerUid;
}

async function assertHomeAssignment(db: Firestore, ownerUid: string, gatewayId: string, boot = false): Promise<void> {
  const owner = (await db.collection("users").doc(ownerUid).get()).data();
  const assigned = owner?.provisioning?.openclaw?.gatewayId;
  if (assigned && assigned !== gatewayId) {
    const root = boot ? (await db.collection(GATEWAYS_COLLECTION).doc(assigned).get()).data() : null;
    if (root?.gatewayClass !== "shared") throw new Error("boot replacement home is assigned to another gateway");
  }
}

function assertReplacementRecoveryCapacity(data: Record<string, unknown> | undefined, vm: GatewayVmState, description: GatewayVmDescription): void {
  const recovery = data?.vmBootRecovery as { instanceId?: string; observedAt?: number } | undefined;
  if (!isGatewayVmBootRecoverySample(recovery) || !recovery.ready || recovery.retainedPoints > 1 || recovery.freeBytes < 2 * 1024 ** 3) throw new Error("boot replacement requires successful native admission and room for its pre-migration recovery point; source boot/home kept");
  const identity = recovery as typeof recovery & { instanceId?: string; observedAt?: number };
  if (identity.instanceId !== description.instanceId || typeof identity.observedAt !== "number" || identity.observedAt < vm.updatedAt - 90_000
    || description.lastStartedAt !== null && identity.observedAt < description.lastStartedAt) throw new Error("boot replacement recovery receipt is stale or belongs to another computer; source boot/home kept");
  if ((recovery.retainedPoints === 0) !== (recovery.currentPointId === null)) throw new Error("boot replacement recovery point count/identity differs; source boot/home kept");
}

function assertReplacementRoot(root: FirebaseFirestore.DocumentSnapshot, desired: string | null, forceOwnerUid?: string): void {
  if (desired === null && root.exists) throw new Error("force replacement requires a valid retired gateway or an absent gateway root");
  if (!forceOwnerUid) return;
  if (!root.exists && desired !== null) throw new Error("force replacement gateway disappeared");
  if (root.exists && (root.data()?.ownerUid !== forceOwnerUid || root.data()?.gatewayClass !== "builder" || root.data()?.desiredStatus !== desired)) throw new Error("force replacement gateway owner changed or status changed");
}

async function replacementRecord(deps: ComputerLifecycleDeps, gatewayId: string, desired: string | null, forceOwnerUid?: string): Promise<Awaited<ReturnType<typeof readVmRecord>>> {
  const record = await readVmRecord(deps.db, gatewayId);
  const forceRoot = forceOwnerUid ? await deps.db.collection(GATEWAYS_COLLECTION).doc(gatewayId).get() : null;
  if (forceRoot) assertReplacementRoot(forceRoot, desired, forceOwnerUid);
  if (record.data !== undefined) return record;
  if (desired !== "retired" && !(forceOwnerUid && desired === null)) return record;
  const root = forceRoot ?? await deps.db.collection(GATEWAYS_COLLECTION).doc(gatewayId).get();
  assertReplacementRoot(root, desired, forceOwnerUid);
  const ownerUid = forceOwnerUid ?? nonEmptyString(root.data()?.ownerUid);
  const parked = ownerUid ? await readParkedComputer(deps.db, ownerUid) : null;
  if (!parked || parked.gatewayId !== gatewayId) throw new Error("retired replacement requires the same owner-anchored parked computer");
  return { data: { runtime: "gce-vm", vmInstance: { ownerUid }, vmSpec: parked.vmSpec, vmBootRecovery: parked.bootRecovery },
    vm: { instanceName: parked.instanceName, zone: parked.zone, instanceId: parked.instanceId, updatedAt: parked.parkedAt,
      internalIp: null, status: "TERMINATED", startedAt: null, provisioningModel: null, stopReason: "idle" } };
}

async function clearForceReplacementRuntime(deps: ComputerLifecycleDeps, gatewayId: string, ownerUid: string, instanceId: string): Promise<boolean> {
  const runtime = deps.db.collection(GLM_GATEWAYS_COLLECTION).doc(gatewayId);
  const root = deps.db.collection(GATEWAYS_COLLECTION).doc(gatewayId);
  return deps.db.runTransaction(async tx => {
    const [runtimeSnapshot, rootSnapshot] = await Promise.all([tx.get(runtime), tx.get(root)]);
    const rootData = rootSnapshot.data();
    if (rootSnapshot.exists && (rootData?.ownerUid !== ownerUid || rootData.gatewayClass !== "builder" || !["paused", "retired"].includes(rootData.desiredStatus))) throw new Error("replacement gateway identity changed");
    if (!runtimeSnapshot.exists) return false;
    const data = runtimeSnapshot.data();
    if ((data?.vm != null && data.vm.instanceId !== instanceId) || (data?.vmInstance?.ownerUid != null && data.vmInstance.ownerUid !== ownerUid)) throw new Error("replacement runtime identity changed");
    tx.set(runtime, { vm: null, vmInstance: FieldValue.delete(), vmHome: { checkpointRequestedAt: FieldValue.delete(), parkRequestedAt: FieldValue.delete(), checkpointAcknowledgedAt: FieldValue.delete() } }, { merge: true });
    return true;
  });
}

async function finishForceRuntimeClear(deps: ComputerLifecycleDeps, gatewayId: string, ownerUid: string, instanceId?: string): Promise<void> {
  if (!instanceId) throw new Error("force replacement requires the recorded computer identity");
  if (await clearForceReplacementRuntime(deps, gatewayId, ownerUid, instanceId)) return;
  if (await deps.readDesiredStatus(gatewayId) === null &&
    !(await deps.db.collection(GATEWAYS_COLLECTION).doc(gatewayId).get()).exists &&
    (await readParkedComputer(deps.db, ownerUid))?.gatewayId === gatewayId &&
    (await readVmRecord(deps.db, gatewayId)).data === undefined) return;
  if (await deps.readDesiredStatus(gatewayId) === "retired" && (await readVmRecord(deps.db, gatewayId)).data === undefined) return;
  throw new Error("replacement runtime record disappeared; retained home preserved");
}

async function clearReplacementRuntime(deps: ComputerLifecycleDeps, gatewayId: string, boot = false, forceOwnerUid?: string, expectedInstanceId?: string): Promise<void> {
  if (forceOwnerUid) return finishForceRuntimeClear(deps, gatewayId, forceOwnerUid, expectedInstanceId);
  const cleared = boot
    ? await recordVmObservation(deps, gatewayId, { vm: null, vmHome: { checkpointRequestedAt: FieldValue.delete(), parkRequestedAt: FieldValue.delete(), checkpointAcknowledgedAt: FieldValue.delete() } }, "replacement")
    : await clearReplacedComputer(deps, gatewayId);
  if (cleared) return;
  if (await deps.readDesiredStatus(gatewayId) !== "retired" || (await readVmRecord(deps.db, gatewayId)).data !== undefined) {
    throw new Error("replacement runtime record disappeared; retained home preserved");
  }
}

async function assertNoBootProjectStorage(db: ComputerLifecycleDeps["db"], ownerUid: string): Promise<void> {
  const owner = (await db.collection("users").doc(ownerUid).get()).data();
  if (owner?.provisioning?.projectStorage?.nativeBoot === true) throw new Error("boot replacement cannot discard unpublished project work; source boot and home retained");
}

function replacementStatusAllowed(desired: string | null, boot: boolean): desired is string {
  return desired === "paused" || desired === "retired" || (boot && desired === "running");
}

function assertReplacementObservation(observed: GatewayVmDescription | null, vm: GatewayVmState, gatewayId: string): asserts observed is GatewayVmDescription {
  if (!observed || observed.instanceId !== vm.instanceId || observed.gatewayId !== gatewayId || !PARKED_STATUSES.has(observed.status)) throw new Error("boot replacement requires the same verified stopped computer");
}

async function replacementObservation(deps: ComputerLifecycleDeps, gatewayId: string, boot: boolean, forceOwnerUid?: string, expectedInstanceId?: string) {
  const desired = await deps.readDesiredStatus(gatewayId);
  if (!replacementStatusAllowed(desired, boot) && !(forceOwnerUid && desired === null)) throw new Error("boot replacement requires a paused or retired gateway, or a stopped computer during boot");
  const { data, vm } = await replacementRecord(deps, gatewayId, desired, forceOwnerUid);
  if (!vm || !vm.instanceId || resolveGatewayRuntime(data?.runtime) !== "gce-vm") throw new Error("boot replacement requires a recorded GCE computer");
  if (forceOwnerUid && (!expectedInstanceId || vm.instanceId !== expectedInstanceId)) throw new Error("force replacement computer changed");
  const observed = await deps.vm.describe(vm.instanceName, vm.zone);
  assertReplacementObservation(observed, vm, gatewayId);
  if (forceOwnerUid && assertReplacementOwner(deps, data, observed) !== forceOwnerUid) throw new Error("force replacement owner changed");
  return { data, vm, observed };
}

async function replacementSource(deps: ComputerLifecycleDeps, gatewayId: string, boot: boolean, forceOwnerUid?: string, expectedInstanceId?: string): Promise<{ description: GatewayVmDescription; ownerUid: string; spec: GatewayVmSpec }> {
  const { data, vm, observed } = await replacementObservation(deps, gatewayId, boot, forceOwnerUid, expectedInstanceId);
  if (forceOwnerUid) {
    await assertComputerUnbound(deps, gatewayId, observed);
    await assertHomeAssignment(deps.db, forceOwnerUid, gatewayId, true);
  }
  const description = await stopSuspendedComputer(deps, gatewayId, observed, "replace its boot");
  const ownerUid = assertReplacementOwner(deps, data, description);
  if (forceOwnerUid && forceOwnerUid !== ownerUid) throw new Error("force replacement owner changed");
  if (!boot && !forceOwnerUid) await assertNoBootProjectStorage(deps.db, ownerUid);
  if (!forceOwnerUid) assertReplacementRecoveryCapacity(data, vm, description);
  await assertComputerUnbound(deps, gatewayId, description);
  await assertHomeAssignment(deps.db, ownerUid, gatewayId, boot || !!forceOwnerUid);
  return { description, ownerUid, spec: recordedSpecInConfiguredZones(data?.vmSpec as GatewayVmSpec | undefined, deps.vmSpec) };
}

function assertAbsentReplacementRecord(input: { gatewayId: string; source: NonNullable<RetainedBootImage["sourceComputer"]>; home: RetainedBuilderHome; record: Awaited<ReturnType<typeof readVmRecord>>; desired: string }): void {
  const { gatewayId, source, home } = input;
  const { vm } = input.record;
  if (input.record.data === undefined && input.desired !== "retired") throw new Error("replacement retry runtime record disappeared; retained home preserved");
  if (input.record.data !== undefined && resolveGatewayRuntime(input.record.data.runtime) !== "gce-vm") throw new Error("replacement retry requires the original GCE substrate");
  if (source.gatewayId !== gatewayId || source.zone !== home.zone || !source.name || !source.instanceId) throw new Error("replacement source anchor is malformed");
  if (vm && (vm.instanceId !== source.instanceId || vm.instanceName !== source.name || vm.zone !== source.zone)) throw new Error("replacement retry runtime belongs to another computer");
}

async function releaseReplacementOwner(deps: ComputerLifecycleDeps, input: { ownerUid: string; gatewayId: string; instanceId: string; operationId: string; force: boolean }): Promise<void> {
  const { ownerUid, gatewayId, instanceId, operationId, force } = input;
  if (force) return finishComputerRecovery(deps.db, { ownerUid, gatewayId, instanceId, operationId });
  const parked = await readParkedComputer(deps.db, ownerUid);
  if (parked?.instanceId === instanceId && parked.gatewayId === gatewayId) await releaseParkedComputer(deps.db, ownerUid);
}

async function assertAbsentReplacementStatus(deps: ComputerLifecycleDeps, gatewayId: string, desired: string | null, boot: boolean, forceOwnerUid?: string): Promise<void> {
  if (replacementStatusAllowed(desired, boot)) return;
  if (forceOwnerUid && desired === null && !(await deps.db.collection(GATEWAYS_COLLECTION).doc(gatewayId).get()).exists) return;
  throw new Error("boot replacement retry requires paused or retired status, or an active boot");
}

async function finishAbsentBootReplacement(deps: ComputerLifecycleDeps, gatewayId: string, operationId: string, options: ReplacementOptions): Promise<Record<string, unknown> | null> {
  const { boot = false, forceOwnerUid, expectedInstanceId } = options;
  const ownerUid = forceOwnerUid ?? nonEmptyString((await deps.db.collection(GATEWAYS_COLLECTION).doc(gatewayId).get()).data()?.ownerUid);
  if (!ownerUid) return null;
  const home = await readRetainedBuilderHome(deps.db, ownerUid);
  const pin = (home as (RetainedBuilderHome & { bootImage?: RetainedBootImage }) | null)?.bootImage;
  if (!home || pin?.operationId !== operationId || !pin.sourceComputer) return null;
  const source = pin.sourceComputer;
  if (forceOwnerUid && source.instanceId !== expectedInstanceId) throw new Error("force replacement computer changed");
  if (await deps.vm.describe(source.name, source.zone)) return null;
  const desired = await deps.readDesiredStatus(gatewayId);
  await assertAbsentReplacementStatus(deps, gatewayId, desired, boot, forceOwnerUid);
  const record = await readVmRecord(deps.db, gatewayId);
  assertAbsentReplacementRecord({ gatewayId, source, home, record, desired: desired ?? "retired" });
  await assertHomeAssignment(deps.db, ownerUid, gatewayId, boot || !!forceOwnerUid);
  await deps.vm.verifyDetachedHome(home, ownerUid);
  const image = await selectRetainedBootImage({ db: deps.db, vm: deps.vm, ownerUid, home, spec: deps.vmSpec });
  await clearReplacementRuntime(deps, gatewayId, boot, forceOwnerUid, expectedInstanceId);
  await releaseReplacementOwner(deps, { ownerUid, gatewayId, instanceId: source.instanceId, operationId, force: !!forceOwnerUid });
  return { instanceName: source.name, home, previous: pin.previous, image, bootDeleted: true, resumeRequired: true };
}

async function logPossibleUnsavedProjects(deps: ComputerLifecycleDeps, gatewayId: string, ownerUid: string, boot: boolean): Promise<void> {
  if (boot && (await deps.db.collection("users").doc(ownerUid).get()).data()?.provisioning?.projectStorage?.nativeBoot === true) {
    deps.log(`[vm-gateway-runtime] ${gatewayId}: project autosave is best-effort; unsaved project work on the old boot disk may be lost`);
  }
}

async function confirmForceReplacement(deps: ComputerLifecycleDeps, input: { fence: { ownerUid: string; gatewayId: string; instanceId: string; operationId: string } | null; boot: boolean; source: GatewayVmDescription; assertAuthority: () => Promise<void> }): Promise<void> {
  if (!input.fence) return;
  await input.assertAuthority();
  await assertComputerRecoveryFence(deps.db, input.fence);
  const finalSource = await replacementSource(deps, input.fence.gatewayId, input.boot, input.fence.ownerUid, input.fence.instanceId);
  verifiedStoppedComputer(input.source, finalSource.description);
}

async function replaceStoppedComputer(deps: ComputerLifecycleDeps, gatewayId: string, operationId: string, assertAuthority: () => Promise<void>, options: ReplacementOptions = {}): Promise<Record<string, unknown>> {
  const { boot = false, expectedImageId, forceOwnerUid, expectedInstanceId } = options;
  if (forceOwnerUid && !expectedInstanceId) throw new Error("force replacement requires the recorded computer identity");
  await assertAuthority();
  const fence = forceOwnerUid && expectedInstanceId ? { ownerUid: forceOwnerUid, gatewayId, instanceId: expectedInstanceId, operationId } : null;
  if (fence) await assertComputerRecoveryFence(deps.db, fence);
  const completed = await finishAbsentBootReplacement(deps, gatewayId, operationId, options);
  if (completed) return completed;
  const source = await replacementSource(deps, gatewayId, boot, forceOwnerUid, expectedInstanceId);
  await logPossibleUnsavedProjects(deps, gatewayId, source.ownerUid, boot);
  const home = await deps.vm.retainHome(source.description.name, source.description.zone, source.ownerUid);
  await recordRetainedBuilderHome(deps.db, source.ownerUid, home);
  const previous = await deps.vm.readBootImage(source.description.name, source.description.zone);
  const selected = await selectRetainedBootImage({ db: deps.db, vm: deps.vm, ownerUid: source.ownerUid, home, spec: source.spec, previous, operationId, sourceComputer: { name: source.description.name, zone: source.description.zone, instanceId: source.description.instanceId!, gatewayId } });
  if (expectedImageId && selected.id !== expectedImageId) throw new Error("computer image family changed during boot upgrade; retry on a later boot");
  await assertAuthority();
  if (fence) await assertComputerRecoveryFence(deps.db, fence);
  const confirmed = await replacementSource(deps, gatewayId, boot, forceOwnerUid, expectedInstanceId);
  verifiedStoppedComputer(source.description, confirmed.description);
  const retained = await deps.vm.retainHome(confirmed.description.name, confirmed.description.zone, source.ownerUid);
  if (retained.id !== home.id || retained.source !== home.source) throw new Error("boot replacement home changed before deletion");
  await recordRetainedBuilderHome(deps.db, source.ownerUid, retained);
  await confirmForceReplacement(deps, { fence, boot, source: source.description, assertAuthority });
  await deps.vm.deleteRetainingHome(source.description.name, source.description.zone, source.ownerUid, home, source.description.instanceId!);
  await clearReplacementRuntime(deps, gatewayId, boot, forceOwnerUid, expectedInstanceId);
  await releaseReplacementOwner(deps, { ownerUid: source.ownerUid, gatewayId, instanceId: source.description.instanceId!, operationId, force: !!fence });
  deps.log(`[vm-gateway-runtime] ${gatewayId}: replaced platform boot; retained home ${home.name}/${home.id}; resume uses ${selected.name}/${selected.id}`);
  return { instanceName: source.description.name, home, previous, image: selected, bootDeleted: true, resumeRequired: true, ...(forceOwnerUid ? { force: true } : {}) };
}


  function capacityDiffers(description: GatewayVmDescription, spec: GatewayVmSpec): boolean {
    return description.machineType !== spec.machineType || description.provisioningModel !== spec.provisioningModel;
  }

  async function reconcileComputerCapacity(deps: ComputerLifecycleDeps, gatewayId: string, description: GatewayVmDescription, spec: GatewayVmSpec): Promise<GatewayVmDescription> {
    if (!capacityDiffers(description, spec)) return description;
    if (!PARKED_STATUSES.has(description.status)) throw new Error(`computer ${description.name}: expected ${spec.machineType} ${spec.provisioningModel}, observed ${description.machineType} ${description.provisioningModel}; pause and resume to apply the tier capacity`);
    description = await stopSuspendedComputer(deps, gatewayId, description, description.machineType !== spec.machineType ? "change its machine type" : "change its provisioning model");
    if (description.machineType !== spec.machineType) await deps.vm.setMachineType(description.name, description.zone, spec.machineType);
    if (description.provisioningModel !== spec.provisioningModel) await deps.vm.setProvisioningModel(description.name, description.zone, spec.provisioningModel);
    const resized = await deps.vm.describe(description.name, description.zone);
    if (!resized || resized.machineType !== spec.machineType) throw new Error(`computer ${description.name}: machine type did not converge to ${spec.machineType}`);
    if (resized.provisioningModel !== spec.provisioningModel) throw new Error(`computer ${description.name}: provisioning model did not converge to ${spec.provisioningModel}`);
    await recordVmObservation(deps, gatewayId, { vm: stateFrom(resized, deps.now(), null) }, "resize");
    return resized;
  }

  async function reconcileHomeCapacity(deps: ComputerLifecycleDeps, input: { gatewayId: string; ownerUid: string; description: GatewayVmDescription; home: RetainedBuilderHome; spec: GatewayVmSpec }): Promise<GatewayVmDescription> {
    const { gatewayId, ownerUid, spec } = input;
    let { home, description } = input;
    const applyOnResume = (home.sizeGb < spec.homeDiskSizeGb || capacityDiffers(description, spec)) && !PARKED_STATUSES.has(description.status);
    if (applyOnResume) deps.log(`[vm-gateway-runtime] ${gatewayId}: tier capacity will apply on the next resume; preserving running computer ${description.name}`);
    if (!applyOnResume && home.sizeGb < spec.homeDiskSizeGb) {
      description = await stopSuspendedComputer(deps, gatewayId, description, "grow its home");
      home = await deps.vm.expandHome(home, ownerUid, spec.homeDiskSizeGb);
      await recordRetainedBuilderHome(deps.db, ownerUid, home);
    }
    let status = "ready";
    if (home.sizeGb < spec.homeDiskSizeGb) status = "grow-pending";
    if (home.sizeGb > spec.homeDiskSizeGb) status = "shrink-pending";
    await deps.db.collection("users").doc(ownerUid).set({ provisioning: { homeCapacity: {
      desiredGiB: spec.homeDiskSizeGb, allocatedGiB: home.sizeGb,
      status,
      diskId: home.id, applyOnResume,
    } } }, { merge: true });
    return applyOnResume ? description : reconcileComputerCapacity(deps, gatewayId, description, spec);
  }

async function resumeComputer(deps: ComputerLifecycleDeps, gatewayId: string, description: GatewayVmDescription): Promise<GatewayVmDescription> {
  const resumed = await deps.vm.resume(description.name, description.zone);
  const after = (await deps.vm.describe(description.name, description.zone)) ?? description;
  deps.log(`[vm-gateway-runtime] ${gatewayId}: resumed ${description.name} -> ${after.status}${resumed.fellBackToStandard ? " (on-demand fallback)" : ""}`);
  return after;
}

async function bindParkedComputer(deps: ComputerLifecycleDeps, gatewayId: string, description: GatewayVmDescription, input: CreateGatewayVmInput): Promise<GatewayVmDescription> {
  try {
    await deps.vm.bind(description.name, description.zone, bindingOf(input));
    return description;
  } catch (err) {
    if (description.status !== "SUSPENDED") throw err;
    deps.log(`[vm-gateway-runtime] ⚠ ${gatewayId}: could not bind suspended ${description.name} (${errorMessage(err)}); stopping it to refresh its bootstrap metadata`);
  }
  const stopped = await stopSuspendedComputer(deps, gatewayId, description, "refresh its bootstrap metadata");
  await deps.vm.bind(stopped.name, stopped.zone, bindingOf(input));
  return stopped;
}

async function upgradeStoppedBoot(deps: ComputerLifecycleDeps, gatewayId: string, description: GatewayVmDescription, spec: GatewayVmSpec): Promise<GatewayVmDescription | null> {
  if (!STOPPED_STATUSES.has(description.status) || !description.instanceId) return description;
  try {
    const [current, latest] = await Promise.all([
      deps.vm.readBootImage(description.name, description.zone),
      deps.vm.readFamilyImage(spec.imageFamily, spec.imageProject),
    ]);
    if (current.id === latest.id) return description;
    const instanceId = description.instanceId;
    const ownerUid = nonEmptyString(description.metadata["octogee-owner-uid"]);
    if (!ownerUid) throw new Error("computer boot upgrade requires the recorded owner");
    const operationId = `boot-${gatewayId}-${instanceId}-${latest.id}`;
    await deps.journalBootUpgrade({ gatewayId, ownerUid, instanceId, imageId: latest.id }, async (assertAuthority) => {
      await replaceStoppedComputer(deps, gatewayId, operationId, assertAuthority, { boot: true, expectedImageId: latest.id });
    });
    return null;
  } catch (error) {
    const observed = await deps.vm.describe(description.name, description.zone);
    if (!observed || observed.instanceId !== description.instanceId || !PARKED_STATUSES.has(observed.status)) throw error;
    deps.log(`[vm-gateway-runtime] ${gatewayId}: boot image upgrade skipped; retaining ${description.name}: ${errorMessage(error)}`);
    return observed;
  }
}

async function confirmRetainedHome(deps: ComputerLifecycleDeps, gatewayId: string, description: GatewayVmDescription, recovery: GatewayVmHomeCheckpoint | null): Promise<void> {
  if (!recovery || description.instanceId !== recovery.instanceId) return;
  const retained = await recordVmObservation(deps, gatewayId, { vmHome: { restoreCheckpoint: FieldValue.delete() } }, "retained home");
  if (!retained) throw new Error(`gateway ${gatewayId}: cannot confirm the retained home`);
}

async function prepareParkedUpgrade(deps: ComputerLifecycleDeps, input: {
  gatewayId: string; ownerUid: string; description: GatewayVmDescription; spec: GatewayVmSpec;
  bind: (description: GatewayVmDescription) => Promise<GatewayVmDescription>;
}): Promise<GatewayVmDescription | null> {
  const { gatewayId, ownerUid, spec } = input;
  let { description } = input;
  if (!PARKED_STATUSES.has(description.status)) return description;
  if (description.gatewayId !== gatewayId) {
    const parked = await readParkedComputer(deps.db, ownerUid);
    if (parked?.bootRecovery && parked.gatewayId === description.gatewayId && parked.instanceId === description.instanceId
      && parked.instanceName === description.name && parked.zone === description.zone) {
      await assertComputerUnbound(deps, gatewayId, description);
      const recorded = await recordVmObservation(deps, gatewayId, {
        vm: stateFrom(description, parked.parkedAt, "idle"), vmBootRecovery: parked.bootRecovery,
      }, "parked computer adoption");
      if (recorded) description = await input.bind(description);
    }
  }
  if (description.metadata["octogee-owner-uid"] === ownerUid) return upgradeStoppedBoot(deps, gatewayId, description, spec);
  deps.log(`[vm-gateway-runtime] ${gatewayId}: boot image upgrade skipped; computer owner binding requires reconciliation`);
  return description;
}

function replacementPinMatches(gatewayId: string, vm: GatewayVmState | null, pin: RetainedBootImage | undefined): boolean {
  const source = pin?.sourceComputer;
  if (!pin?.operationId?.startsWith(`boot-${gatewayId}-`) || source?.gatewayId !== gatewayId) return false;
  return !vm || (vm.instanceId === source.instanceId && vm.instanceName === source.name && vm.zone === source.zone);
}

async function recoverMissingReplacement(deps: ComputerLifecycleDeps, input: {
  gatewayId: string; data: Record<string, unknown> | undefined; vm: GatewayVmState | null;
  ensureVm: ComputerLifecycle["ensureVm"];
}): Promise<void> {
  const { gatewayId, data, vm } = input;
  const instance = data?.vmInstance as { ownerUid?: unknown; image?: { repository?: unknown; tag?: unknown } } | undefined;
  const owner = nonEmptyString(instance?.ownerUid);
  const repository = nonEmptyString(instance?.image?.repository);
  const tag = nonEmptyString(instance?.image?.tag);
  const home = owner ? await readRetainedBuilderHome(deps.db, owner) : null;
  const pin = (home as (RetainedBuilderHome & { bootImage?: RetainedBootImage }) | null)?.bootImage;
  if (owner && repository && tag && replacementPinMatches(gatewayId, vm, pin)) {
    await input.ensureVm(gatewayId, `${repository}:${tag}`, owner, await deps.resolveBridge());
    await deps.reconcileRoutes();
    return;
  }
  deps.log(`[vm-gateway-runtime] ⚠ ${gatewayId}: ${vm?.instanceName ?? "computer"} is absent from Compute while the gateway expects it`);
}

async function upgradePreemptedBoot(deps: ComputerLifecycleDeps, gatewayId: string, description: GatewayVmDescription, ensureVm: ComputerLifecycle["ensureVm"]): Promise<GatewayVmDescription | null> {
  const image = description.metadata["gateway-image"];
  const owner = description.metadata["octogee-owner-uid"];
  let bridge: string | undefined;
  try {
    const url = new URL(description.metadata["octogee-api-url"]);
    if (url.protocol === "http:" && url.port === "3001" && url.pathname === "/") bridge = url.hostname;
  } catch { bridge = undefined; }
  if (!image || !owner || !bridge) {
    deps.log(`[vm-gateway-runtime] ${gatewayId}: boot image upgrade skipped during preemption recovery; computer binding is incomplete`);
    return description;
  }
  const { data } = await readVmRecord(deps.db, gatewayId);
  const spec = recordedSpecInConfiguredZones(data?.vmSpec as GatewayVmSpec | undefined, deps.vmSpec);
  const upgraded = await upgradeStoppedBoot(deps, gatewayId, description, spec);
  if (upgraded) return upgraded;
  await ensureVm(gatewayId, image, owner, bridge);
  await deps.reconcileRoutes();
  return null;
}


export function createComputerLifecycle(deps: ComputerLifecycleDeps): ComputerLifecycle {

  async function recordVm(gatewayId: string, vm: GatewayVmState | null, what: string): Promise<boolean> {
    return recordVmObservation(deps, gatewayId, { vm }, what);
  }

  async function startComputer(gatewayId: string, description: GatewayVmDescription, verb: "started" | "restarted"): Promise<GatewayVmDescription> {
    const started = await deps.vm.start(description.name, description.zone);
    const after = (await deps.vm.describe(description.name, description.zone)) ?? description;
    deps.log(`[vm-gateway-runtime] ${gatewayId}: ${verb} ${description.name} -> ${after.status}${started.fellBackToStandard ? " (on-demand fallback)" : ""}`);
    return after;
  }

  async function wakeComputer(gatewayId: string, description: GatewayVmDescription): Promise<GatewayVmDescription> {
    return description.status === "SUSPENDED" ? resumeComputer(deps, gatewayId, description) : startComputer(gatewayId, description, "started");
  }

  async function acquireComputer(gatewayId: string, ownerUid: string, input: CreateGatewayVmInput): Promise<GatewayVmDescription> {
    if (input.retainedHome) {
      await deps.vm.verifyDetachedHome(input.retainedHome, ownerUid);
      return (await deps.vm.create(input)).description;
    }
    const zones = spreadZones(input.zones, await occupiedComputerZones(deps.vm, deps.environment));
    const created = await deps.vm.create({ ...input, zones });
    deps.log(`[vm-gateway-runtime] ${gatewayId}: ${created.alreadyExisted ? "adopted" : "created"} ${input.instanceName} in ${created.description.zone} (${created.provisioningModel})`);
    return created.description;
  }


  async function reconcileComputerBinding(gatewayId: string, ownerUid: string, input: CreateGatewayVmInput, description: GatewayVmDescription): Promise<GatewayVmDescription> {
    const stampedOwner = description.metadata["octogee-owner-uid"];
    if ((stampedOwner && stampedOwner !== ownerUid) || (description.labels["octogee-owner-uid"] && description.labels["octogee-owner-uid"] !== ownerUid.toLowerCase())) {
      throw new Error(`computer ${description.name}: recorded owner differs; refusing state adoption`);
    }
    if (description.gatewayId !== gatewayId) {
      await assertComputerUnbound(deps, gatewayId, description);
      if (!STOPPED_STATUSES.has(description.status)) {
        await deps.vm.stop(description.name, description.zone);
        description = verifiedStoppedComputer(description, await deps.vm.describe(description.name, description.zone));
        await assertComputerUnbound(deps, gatewayId, description);
        deps.log(`[vm-gateway-runtime] ${gatewayId}: stopped ${description.name} to rebind it from ${description.gatewayId ?? "no gateway"}`);
      }
      description = await reconcileComputerIdentity(gatewayId, description, input.serviceAccountEmail);
      await deps.vm.bind(description.name, description.zone, bindingOf(input));
      deps.log(`[vm-gateway-runtime] ${gatewayId}: bound ${description.name} to ${gatewayId} (was ${description.gatewayId ?? "unbound"})`);
      await releaseParkedComputer(deps.db, ownerUid);
      description = (await deps.vm.describe(description.name, description.zone)) ?? description;
    } else {
      description = await reconcileComputerIdentity(gatewayId, description, input.serviceAccountEmail);
      description = await prepareDesktopChange(gatewayId, description, input.desktop);
      if (["gateway-image", "octogee-api-url", "octogee-owner-uid", COMPUTER_DESKTOP_METADATA_KEY].some((key) => description.metadata[key] !== input.metadata[key])) {
        description = await bindParkedComputer(deps, gatewayId, description, input);
        deps.log(`[vm-gateway-runtime] ${gatewayId}: refreshed bootstrap metadata for ${description.name}`);
      }
    }
    return description;
  }

  async function prepareDesktopChange(gatewayId: string, description: GatewayVmDescription, desktop: GatewayVmDesktop): Promise<GatewayVmDescription> {
    const booted = bootedDesktop(description);
    if (booted === desktop) return description;
    if (!PARKED_STATUSES.has(description.status)) {
      throw new Error(`computer ${description.name}: runs desktop ${booted}, its tier now wants ${desktop}; pause and resume to apply the tier capacity`);
    }
    return stopSuspendedComputer(deps, gatewayId, description, `boot it into the ${desktop} desktop`);
  }

  async function reconcileComputerIdentity(gatewayId: string, description: GatewayVmDescription, email: string): Promise<GatewayVmDescription> {
    if (hasComputerIdentity(description, email)) return description;
    const error = computerIdentityPrerequisiteError(description, email);
    if (error) throw new Error(error);
    const stopped = await stopSuspendedComputer(deps, gatewayId, description, "repair its identity");
    await deps.vm.setServiceAccount(stopped.name, stopped.zone, email);
    deps.log(`[vm-gateway-runtime] ${stopped.name}: reconciled parked computer identity before activation`);
    return stopped;
  }

  async function ensureVm(gatewayId: string, image: string, ownerUid: string | undefined, bridge: string): Promise<GatewayVmState> {
    if (!ownerUid) throw new Error(`gateway ${gatewayId}: a gce-vm Builder gateway needs an owner`);
    const { data, vm: existing } = await readVmRecord(deps.db, gatewayId);
    const spec = recordedSpecInConfiguredZones(data?.vmSpec as GatewayVmSpec | undefined, deps.vmSpec);
    let input = builderComputerInstanceInput({ gatewayId, ownerUid, spec, environment: deps.environment, image, bridgeIp: bridge });
    let description = existing ? await deps.vm.describe(existing.instanceName, existing.zone) : null;
    if (!description) description = await deps.vm.findByLabels(ownerComputerLabels(deps.environment, ownerUid));
    const recovery = await requireHomeRecovery(deps, { gatewayId, ownerUid, data, description });
    if (description) description = await prepareParkedUpgrade(deps, { gatewayId, ownerUid, description, spec,
      bind: (parked) => reconcileComputerBinding(gatewayId, ownerUid, input, parked) });
    const retainedHome = await readRetainedBuilderHome(deps.db, ownerUid);
    if (!description && retainedHome) {
      if (!spec.zones.includes(retainedHome.zone)) throw new Error(`Builder ${ownerUid}: retained home is outside configured zones; migration is required`);
      await deps.vm.verifyDetachedHome(retainedHome, ownerUid);
      const selected = await selectRetainedBootImage({ db: deps.db, vm: deps.vm, ownerUid, home: retainedHome, spec });
      input = { ...input, zones: [retainedHome.zone], retainedHome, image: selected, imageProject: selected.project };
    }
    description ??= await acquireComputer(gatewayId, ownerUid, input);
    await confirmRetainedHome(deps, gatewayId, description, recovery);
    if (TRANSITIONAL_STATUSES.has(description.status)) {
      throw new Error(`computer ${description.name} is still ${description.status.toLowerCase()}; retrying on the next converge`);
    }
    description = await reconcileComputerBinding(gatewayId, ownerUid, input, description);
    const home = await recordComputerHome(deps, { gatewayId, ownerUid, description, retainedHome, recovery });
    description = await reconcileHomeCapacity(deps, { gatewayId, ownerUid, description, home, spec });
    if (PARKED_STATUSES.has(description.status)) {
      await releaseParkedComputer(deps.db, ownerUid);
      description = await wakeComputer(gatewayId, description);
    }
    const state = stateFrom(description, deps.now(), null);
    await recordAwakeComputer(deps, gatewayId, { runtime: "gce-vm", vmSpec: spec, vm: state });
    return state;
  }


  async function parkComputer(gatewayId: string, opts: ParkComputerOptions = {}): Promise<GatewayVmState | null> {
    const { data, vm } = await readVmRecord(deps.db, gatewayId);
    if (!vm) return null;
    const description = await stoppableComputer(gatewayId, vm);
    if (!description) return null;
    const ownerUid = parkedComputerOwner(data, description);
    const checkpoint = opts.awaitHomeCheckpoint === true && needsPark(description)
      ? await finalHomeCheckpoint(deps, gatewayId, description, readVmHome(data), opts)
      : parkedCheckpointFrom(readVmHome(data));
    const state = await parkComputerInstance(deps, gatewayId, description, vm, { reason: "idle", note: ` (checkpoint ${checkpoint.outcome})` });
    const parked: ParkedVmState = { ...state, parkedCheckpoint: checkpoint };
    await recordParkedComputer(deps, gatewayId, ownerUid, parked, (await readVmRecord(deps.db, gatewayId)).data);
    return parked;
  }

  async function pauseComputer(gatewayId: string): Promise<void> {
    const { data, vm } = await readVmRecord(deps.db, gatewayId);
    if (!vm) return;
    const description = await stoppableComputer(gatewayId, vm);
    if (!description) return;
    const stopFor = readStopOnPark(data);
    await recordVm(gatewayId, await parkComputerInstance(deps, gatewayId, description, vm, { reason: "operator", ...(stopFor ? { stopFor } : {}) }), "pause");
  }

  async function stoppableComputer(gatewayId: string, vm: GatewayVmState): Promise<GatewayVmDescription | null> {
    const description = await deps.vm.describe(vm.instanceName, vm.zone);
    if (!description) {
      deps.log(`[vm-gateway-runtime] ${gatewayId}: ${vm.instanceName} is already absent from Compute`);
      return null;
    }
    if (!vm.instanceId || description.instanceId !== vm.instanceId) {
      throw new Error(`computer ${description.name}: recorded instance identity changed; refusing to stop`);
    }
    if (boundElsewhere(description, gatewayId)) {
      deps.log(`[vm-gateway-runtime] ${gatewayId}: leaving ${description.name} running: bound to ${description.gatewayId}`);
      return null;
    }
    return description;
  }

  async function recoverUnreachable(gatewayId: string): Promise<void> {
    const { data, vm } = await readVmRecord(deps.db, gatewayId);
    if (resolveGatewayRuntime(data?.runtime) !== "gce-vm") return;
    if (vm?.stopReason && COWBOY_STOP_REASONS.has(vm.stopReason)) return;
    if ((await deps.readDesiredStatus(gatewayId)) !== "running") return;
    const description = vm ? await deps.vm.describe(vm.instanceName, vm.zone) : null;
    if (!description) {
      await recoverMissingReplacement(deps, { gatewayId, data, vm, ensureVm });
      return;
    }
    if (!vm) return;
    if (boundElsewhere(description, gatewayId)) {
      deps.log(`[vm-gateway-runtime] ⚠ ${gatewayId}: ${description.name} is bound to ${description.gatewayId}; not restarting it for ${gatewayId}`);
      return;
    }
    if (STOPPED_STATUSES.has(description.status)) {
      await restartPreempted(gatewayId, description);
      return;
    }
    if (description.status === "STOPPING") {
      if (sameObservation(vm, description, "preempted")) return;
      await recordVm(gatewayId, stateFrom(description, deps.now(), "preempted"), "preempted");
      deps.log(`[vm-gateway-runtime] ${gatewayId}: ${description.name} is being stopped by Compute; restarting once it is TERMINATED`);
      return;
    }
    if (description.status === "SUSPENDED") {
      deps.log(`[vm-gateway-runtime] ⚠ ${gatewayId}: ${description.name} is SUSPENDED outside Cowboy; not resuming it`);
      return;
    }
    await recordRunningAgain(gatewayId, vm, description);
  }

  async function restartPreempted(gatewayId: string, description: GatewayVmDescription): Promise<void> {
    const upgraded = await upgradePreemptedBoot(deps, gatewayId, description, ensureVm);
    if (!upgraded) return;
    description = upgraded;
    if (!(await recordVm(gatewayId, stateFrom(description, deps.now(), "preempted"), "preempted"))) return;
    deps.log(`[vm-gateway-runtime] ${gatewayId}: ${description.name} was preempted (${description.status}); restarting`);
    const after = await startComputer(gatewayId, description, "restarted");
    await recordVm(gatewayId, stateFrom(after, deps.now(), null), "restart");
    await deps.reconcileRoutes();
  }

  async function recordRunningAgain(gatewayId: string, vm: GatewayVmState, description: GatewayVmDescription): Promise<void> {
    if (sameObservation(vm, description, null)) return;
    if (!(await recordVm(gatewayId, stateFrom(description, deps.now(), null), "running"))) return;
    await deps.reconcileRoutes();
    deps.log(`[vm-gateway-runtime] ${gatewayId}: ${description.name} is ${description.status} again at ${description.internalIp ?? "no-ip"}`);
  }


  return {
    readDeploymentPrerequisiteError: (gatewayId) => readComputerDeploymentPrerequisiteError(deps, gatewayId),
    detectPreemption: (gatewayId, sinceMs) => detectComputerPreemption(deps, gatewayId, sinceMs),
    ensureVm, parkComputer, pauseComputer, recoverUnreachable, replaceStoppedComputer: (gatewayId, operationId, assertAuthority, options) => replaceStoppedComputer(deps, gatewayId, operationId, assertAuthority, options), deleteComputer: (ownerUid) => deleteOwnedComputer(deps, ownerUid),
  };
}
