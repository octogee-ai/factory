import type { Firestore } from "firebase-admin/firestore";
import { GATEWAYS_COLLECTION } from "@octogee/shared/types/fleet-controller";
import {
  GLM_GATEWAYS_COLLECTION,
  builderComputerInstanceName,
  resolveGatewayRuntime,
  homeCheckpointOutstanding,
  type GatewayVmHomeState,
  type GatewayVmOrigin,
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
import { releaseParkedComputer, writeParkedComputer } from "./lib/parked-computer.js";
import { claimWarmPoolMember } from "./vm-warm-pool.js";
import { occupiedComputerZones, spreadZones } from "./vm-placement.js";

const STOPPED_STATUSES = new Set(["TERMINATED", "STOPPED"]);
const COWBOY_STOP_REASONS = new Set<GatewayVmStopReason>(["idle", "operator"]);

export interface ComputerLifecycleDeps {
  db: Firestore;
  vm: GatewayVmClient;
  environment: string;
  vmSpec: GatewayVmSpec;
  readDesiredStatus: (gatewayId: string) => Promise<string | null>;
  reconcileRoutes: () => Promise<void>;
  wait: (ms: number) => Promise<void>;
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
}

type ParkedVmState = GatewayVmState & { parkedCheckpoint: GatewayVmParkedCheckpoint };

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

function stateFrom(
  description: GatewayVmDescription,
  now: number,
  stopReason: GatewayVmStopReason | null,
  origin: GatewayVmOrigin | undefined,
): GatewayVmState {
  return {
    instanceName: description.name,
    zone: description.zone,
    instanceId: description.instanceId,
    internalIp: description.internalIp,
    status: description.status,
    provisioningModel: description.provisioningModel,
    ...(origin ? { origin } : {}),
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
  if (hasComputerIdentity(description, email) || STOPPED_STATUSES.has(description.status)) return null;
  return `computer ${description.name}: identity scopes are outdated; pause and resume the gateway through Admin to repair them`;
}

function needsStop(description: GatewayVmDescription): boolean {
  return !STOPPED_STATUSES.has(description.status) && description.status !== "STOPPING";
}

function sameObservation(recorded: GatewayVmState, description: GatewayVmDescription, stopReason: GatewayVmStopReason | null): boolean {
  return recorded.status === description.status
    && recorded.internalIp === description.internalIp
    && recorded.instanceId === description.instanceId
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

async function finalHomeCheckpoint(
  deps: ComputerLifecycleDeps,
  gatewayId: string,
  description: GatewayVmDescription,
  home: Partial<GatewayVmHomeState> | undefined,
  opts: ParkComputerOptions,
): Promise<GatewayVmParkedCheckpoint> {
  const timeoutMs = deps.homeCheckpointTimeoutMs ?? HOME_CHECKPOINT_TIMEOUT_MS;
  let requestedAt = typeof home?.parkRequestedAt === "number" ? home.parkRequestedAt : null;
  if (requestedAt === null) {
    requestedAt = deps.now();
    await recordVmObservation(deps, gatewayId, { vmHome: { checkpointRequestedAt: requestedAt, parkRequestedAt: requestedAt } }, "park request");
    deps.log(`[vm-gateway-runtime] ${gatewayId}: requested the final home checkpoint of ${description.name} before parking; waiting up to ${timeoutMs}ms`);
  }
  const completedAt = homeCheckpointCompletedAt(home);
  if (completedAt !== null && !homeCheckpointOutstanding({ ...home, checkpointRequestedAt: requestedAt })) return { outcome: "fresh", requestedAt, completedAt };
  if (opts.awaitHomeCheckpoint) {
    const result = await awaitHomeCheckpoint(
      {
        readHomeCheckpointCompletedAt: (id) => readHomeCheckpointCompletedAt(deps.db, id),
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
    },
  };
}

function recordedSpecInConfiguredZones(recorded: GatewayVmSpec | undefined, configured: GatewayVmSpec): GatewayVmSpec {
  if (!recorded) return configured;
  const { machineType, imageFamily, imageProject, diskSizeGb, homeDiskSizeGb, provisioningModel, serviceAccountEmail, subnetwork } = recorded;
  return {
    zones: configured.zones,
    machineType, imageFamily, ...(imageProject ? { imageProject } : {}), diskSizeGb, homeDiskSizeGb, provisioningModel, serviceAccountEmail, subnetwork,
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

export function createComputerLifecycle(deps: ComputerLifecycleDeps): ComputerLifecycle {
  const glm = (gatewayId: string) => deps.db.collection(GLM_GATEWAYS_COLLECTION).doc(gatewayId);

  async function recordVm(gatewayId: string, vm: GatewayVmState | null, what: string): Promise<boolean> {
    return recordVmObservation(deps, gatewayId, { vm }, what);
  }

  async function assertComputerUnbound(gatewayId: string, description: GatewayVmDescription): Promise<void> {
    if (!description.instanceId) return;
    const snap = await deps.db.collection(GLM_GATEWAYS_COLLECTION).where("vm.instanceId", "==", description.instanceId).get();
    const holders = snap.docs.map((doc) => doc.id).filter((id) => id !== gatewayId);
    if (holders.length > 0) {
      throw new Error(`computer ${description.name} is still recorded by gateway ${holders.join(", ")}; waiting for its retirement to finish`);
    }
  }

  async function startComputer(gatewayId: string, description: GatewayVmDescription, verb: "started" | "restarted"): Promise<GatewayVmDescription> {
    const started = await deps.vm.start(description.name, description.zone);
    const after = (await deps.vm.describe(description.name, description.zone)) ?? description;
    deps.log(`[vm-gateway-runtime] ${gatewayId}: ${verb} ${description.name} -> ${after.status}${started.fellBackToStandard ? " (on-demand fallback)" : ""}`);
    return after;
  }

  async function acquireComputer(
    gatewayId: string,
    ownerUid: string,
    input: CreateGatewayVmInput,
  ): Promise<{ description: GatewayVmDescription; origin: GatewayVmOrigin }> {
    const spec: GatewayVmSpec = input;
    const claimed = await claimWarmPoolMember({ vm: deps.vm, vmSpec: spec, environment: deps.environment, gatewayId, binding: bindingOf(input), log: deps.log });
    if (claimed) {
      deps.log(`[vm-gateway-runtime] ${gatewayId}: claimed warm-pool member ${claimed.name} as ${ownerUid}'s computer (${claimed.provisioningModel ?? "unknown"})`);
      return { description: claimed, origin: "warm-pool" };
    }
    const zones = spreadZones(input.zones, await occupiedComputerZones(deps.vm, deps.environment));
    const created = await deps.vm.create({ ...input, zones });
    deps.log(`[vm-gateway-runtime] ${gatewayId}: ${created.alreadyExisted ? "adopted" : "created"} cold ${input.instanceName} in ${created.description.zone} (${created.provisioningModel})`);
    return { description: created.description, origin: "cold" };
  }

  async function reconcileComputerBinding(gatewayId: string, ownerUid: string, input: CreateGatewayVmInput, description: GatewayVmDescription): Promise<GatewayVmDescription> {
    if (description.gatewayId !== gatewayId) {
      await assertComputerUnbound(gatewayId, description);
      if (!STOPPED_STATUSES.has(description.status)) {
        await deps.vm.stop(description.name, description.zone);
        description = (await deps.vm.describe(description.name, description.zone)) ?? description;
        deps.log(`[vm-gateway-runtime] ${gatewayId}: stopped ${description.name} to rebind it from ${description.gatewayId ?? "no gateway"}`);
      }
      await reconcileComputerIdentity(description, input.serviceAccountEmail);
      await deps.vm.bind(description.name, description.zone, bindingOf(input));
      deps.log(`[vm-gateway-runtime] ${gatewayId}: bound ${description.name} to ${gatewayId} (was ${description.gatewayId ?? "unbound"})`);
      await releaseParkedComputer(deps.db, ownerUid);
      description = (await deps.vm.describe(description.name, description.zone)) ?? description;
    } else {
      await reconcileComputerIdentity(description, input.serviceAccountEmail);
      if (["gateway-image", "octogee-api-url"].some((key) => description.metadata[key] !== input.metadata[key])) {
        await deps.vm.bind(description.name, description.zone, bindingOf(input));
        deps.log(`[vm-gateway-runtime] ${gatewayId}: refreshed bootstrap metadata for ${description.name}`);
      }
    }
    return description;
  }

  async function reconcileComputerIdentity(description: GatewayVmDescription, email: string): Promise<void> {
    if (hasComputerIdentity(description, email)) return;
    const error = computerIdentityPrerequisiteError(description, email);
    if (error) throw new Error(error);
    await deps.vm.setServiceAccount(description.name, description.zone, email);
    deps.log(`[vm-gateway-runtime] ${description.name}: reconciled parked computer identity before activation`);
  }

  async function ensureVm(gatewayId: string, image: string, ownerUid: string | undefined, bridge: string): Promise<GatewayVmState> {
    if (!ownerUid) throw new Error(`gateway ${gatewayId}: a gce-vm Builder gateway needs an owner`);
    const { data, vm: existing } = await readVmRecord(deps.db, gatewayId);
    const spec = recordedSpecInConfiguredZones(data?.vmSpec as GatewayVmSpec | undefined, deps.vmSpec);
    const input = builderComputerInstanceInput({ gatewayId, ownerUid, spec, environment: deps.environment, image, bridgeIp: bridge });
    let origin = existing?.origin;
    let description = existing ? await deps.vm.describe(existing.instanceName, existing.zone) : null;
    if (!description) description = await deps.vm.findByLabels(ownerComputerLabels(deps.environment, ownerUid));
    if (!description) ({ description, origin } = await acquireComputer(gatewayId, ownerUid, input));
    if (description.status === "STOPPING") {
      throw new Error(`computer ${description.name} is still stopping; retrying on the next converge`);
    }
    description = await reconcileComputerBinding(gatewayId, ownerUid, input, description);
    if (STOPPED_STATUSES.has(description.status)) {
      description = await startComputer(gatewayId, description, "started");
    }
    const state = stateFrom(description, deps.now(), null, origin);
    await glm(gatewayId).set({ runtime: "gce-vm", vmSpec: spec, vm: state }, { merge: true });
    return state;
  }

  async function parkComputer(gatewayId: string, opts: ParkComputerOptions = {}): Promise<GatewayVmState | null> {
    const { data, vm } = await readVmRecord(deps.db, gatewayId);
    if (!vm) return null;
    const description = await stoppableComputer(gatewayId, vm);
    if (!description) return null;
    const parked = await stopForIdle(gatewayId, vm, description, readVmHome(data), opts);
    await recordParkedComputer(deps, gatewayId, parkedComputerOwner(data, description), parked);
    return parked;
  }

  async function pauseComputer(gatewayId: string): Promise<void> {
    const { vm } = await readVmRecord(deps.db, gatewayId);
    if (!vm) return;
    const description = await stoppableComputer(gatewayId, vm);
    await recordVm(gatewayId, description ? await stopComputer(gatewayId, description, vm.origin, "operator") : null, "pause");
  }

  async function stopForIdle(
    gatewayId: string,
    vm: GatewayVmState,
    description: GatewayVmDescription,
    home: Partial<GatewayVmHomeState> | undefined,
    opts: ParkComputerOptions,
  ): Promise<ParkedVmState> {
    const checkpoint = needsStop(description)
      ? await finalHomeCheckpoint(deps, gatewayId, description, home, opts)
      : parkedCheckpointFrom(home);
    const state = await stopComputer(gatewayId, description, vm.origin, "idle", ` (checkpoint ${checkpoint.outcome})`);
    return { ...state, parkedCheckpoint: checkpoint };
  }

  async function stoppableComputer(gatewayId: string, vm: GatewayVmState): Promise<GatewayVmDescription | null> {
    const description = await deps.vm.describe(vm.instanceName, vm.zone);
    if (!description) {
      deps.log(`[vm-gateway-runtime] ${gatewayId}: ${vm.instanceName} is already absent from Compute`);
      return null;
    }
    if (boundElsewhere(description, gatewayId)) {
      deps.log(`[vm-gateway-runtime] ${gatewayId}: leaving ${description.name} running: bound to ${description.gatewayId}`);
      return null;
    }
    return description;
  }

  async function stopComputer(
    gatewayId: string,
    described: GatewayVmDescription,
    origin: GatewayVmOrigin | undefined,
    reason: GatewayVmStopReason,
    note = "",
  ): Promise<GatewayVmState> {
    let description = described;
    if (needsStop(description)) {
      await deps.vm.stop(description.name, description.zone);
      description = (await deps.vm.describe(description.name, description.zone)) ?? description;
    }
    deps.log(`[vm-gateway-runtime] ${gatewayId}: stopped ${description.name} for ${reason} -> ${description.status}; home kept on its boot disk${note}`);
    return stateFrom(description, deps.now(), reason, origin);
  }

  async function recoverUnreachable(gatewayId: string): Promise<void> {
    const { data, vm } = await readVmRecord(deps.db, gatewayId);
    if (resolveGatewayRuntime(data?.runtime) !== "gce-vm" || !vm) return;
    if (vm.stopReason && COWBOY_STOP_REASONS.has(vm.stopReason)) return;
    if ((await deps.readDesiredStatus(gatewayId)) !== "running") return;
    const description = await deps.vm.describe(vm.instanceName, vm.zone);
    if (!description) {
      deps.log(`[vm-gateway-runtime] ⚠ ${gatewayId}: ${vm.instanceName} is absent from Compute while the gateway expects it`);
      return;
    }
    if (boundElsewhere(description, gatewayId)) {
      deps.log(`[vm-gateway-runtime] ⚠ ${gatewayId}: ${description.name} is bound to ${description.gatewayId}; not restarting it for ${gatewayId}`);
      return;
    }
    if (STOPPED_STATUSES.has(description.status)) {
      await restartPreempted(gatewayId, description, vm.origin);
      return;
    }
    if (description.status === "STOPPING") {
      if (sameObservation(vm, description, "preempted")) return;
      await recordVm(gatewayId, stateFrom(description, deps.now(), "preempted", vm.origin), "preempted");
      deps.log(`[vm-gateway-runtime] ${gatewayId}: ${description.name} is being stopped by Compute; restarting once it is TERMINATED`);
      return;
    }
    if (description.status === "SUSPENDED") {
      deps.log(`[vm-gateway-runtime] ⚠ ${gatewayId}: ${description.name} is SUSPENDED outside Cowboy; not resuming it`);
      return;
    }
    await recordRunningAgain(gatewayId, vm, description);
  }

  async function restartPreempted(gatewayId: string, description: GatewayVmDescription, origin: GatewayVmOrigin | undefined): Promise<void> {
    if (!(await recordVm(gatewayId, stateFrom(description, deps.now(), "preempted", origin), "preempted"))) return;
    deps.log(`[vm-gateway-runtime] ${gatewayId}: ${description.name} was preempted (${description.status}); restarting`);
    const after = await startComputer(gatewayId, description, "restarted");
    await recordVm(gatewayId, stateFrom(after, deps.now(), null, origin), "restart");
    await deps.reconcileRoutes();
  }

  async function recordRunningAgain(gatewayId: string, vm: GatewayVmState, description: GatewayVmDescription): Promise<void> {
    if (sameObservation(vm, description, null)) return;
    if (!(await recordVm(gatewayId, stateFrom(description, deps.now(), null, vm.origin), "running"))) return;
    await deps.reconcileRoutes();
    deps.log(`[vm-gateway-runtime] ${gatewayId}: ${description.name} is ${description.status} again at ${description.internalIp ?? "no-ip"}`);
  }

  async function deleteComputer(ownerUid: string): Promise<boolean> {
    const description = await deps.vm.findByLabels(ownerComputerLabels(deps.environment, ownerUid));
    if (!description) {
      deps.log(`[vm-gateway-runtime] ${ownerUid} has no computer to delete`);
      return false;
    }
    await deps.vm.delete(description.name, description.zone);
    deps.log(`[vm-gateway-runtime] deleted computer ${description.name} in ${description.zone} (was ${description.status}, bound to ${description.gatewayId ?? "no gateway"})`);
    return true;
  }

  return {
    readDeploymentPrerequisiteError: (gatewayId) => readComputerDeploymentPrerequisiteError(deps, gatewayId),
    ensureVm, parkComputer, pauseComputer, recoverUnreachable, deleteComputer,
  };
}
