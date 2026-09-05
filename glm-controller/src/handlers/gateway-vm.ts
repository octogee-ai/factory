import {
  resolveGatewayRuntime,
  type BuilderParkedComputer,
  type GatewayVmState,
  type GatewayVmStopReason,
  type Operation,
  type OperationStep,
} from "@octogee/shared/types/glm";
import type { OperationContext, OperationHandler, OperationResult } from "../operation-router.js";
import type { GatewayVmClient, GatewayVmDescription } from "../lib/compute-vm.js";
import { HOME_CHECKPOINT_TIMEOUT_MS, awaitHomeCheckpoint } from "../lib/home-checkpoint.js";

export const GATEWAY_VM_ACTIONS = ["stop", "start", "delete", "replace"] as const;
export type GatewayVmAction = (typeof GATEWAY_VM_ACTIONS)[number];
const STOPPED_STATUSES = new Set(["TERMINATED", "STOPPED"]);

export interface GatewayVmRecord {
  runtime: unknown;
  vm: GatewayVmState | null;
}

export interface GatewayVmDeps {
  vm: GatewayVmClient;
  readGateway: (gatewayId: string) => Promise<GatewayVmRecord | null>;
  writeVmState: (gatewayId: string, vm: GatewayVmState | null) => Promise<void>;
  requestHomeCheckpoint: (gatewayId: string, requestedAt: number) => Promise<void>;
  clearHomeCheckpointRequest: (gatewayId: string) => Promise<void>;
  readHomeCheckpointCompletedAt: (gatewayId: string) => Promise<number | null>;
  clearVmForReplacement: (gatewayId: string) => Promise<void>;
  readParkedComputer: (ownerUid: string) => Promise<BuilderParkedComputer | null>;
  clearParkedComputer: (ownerUid: string) => Promise<void>;
  wait: (ms: number) => Promise<void>;
  now: () => number;
  log: (msg: string) => void;
  replaceCheckpointTimeoutMs?: number;
  replaceCheckpointPollMs?: number;
}

interface GatewayVmInput {
  gatewayId?: unknown;
  ownerUid?: unknown;
  action?: unknown;
}

function isAction(value: unknown): value is GatewayVmAction {
  return typeof value === "string" && (GATEWAY_VM_ACTIONS as readonly string[]).includes(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stateFrom(description: GatewayVmDescription, now: number, stopReason: GatewayVmStopReason | null): GatewayVmState {
  return {
    instanceName: description.name,
    zone: description.zone,
    instanceId: description.instanceId,
    internalIp: description.internalIp,
    status: description.status,
    provisioningModel: description.provisioningModel,
    stopReason,
    updatedAt: now,
  };
}

function step(name: string, status: OperationStep["status"], startedAt: number, now: number, error?: string): OperationStep {
  return { name, status, startedAt, completedAt: now, ...(error ? { error } : {}) };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createGatewayVmHandler(deps: GatewayVmDeps): OperationHandler {
  return async (op: Operation, ctx: OperationContext): Promise<OperationResult> => {
    const input = op.input as GatewayVmInput;
    const gatewayId = nonEmptyString(input.gatewayId);
    const ownerUid = nonEmptyString(input.ownerUid);
    if (!gatewayId && ownerUid) {
      if (input.action !== "replace") return { steps: [], success: false, error: "gateway-vm ownerUid form supports only replace" };
      return replaceParkedVm(deps, ownerUid, ctx);
    }
    if (!gatewayId) return { steps: [], success: false, error: "missing gatewayId in op.input" };
    if (!isAction(input.action)) {
      return { steps: [], success: false, error: `gateway-vm action must be one of ${GATEWAY_VM_ACTIONS.join(", ")}` };
    }
    const action = input.action;
    const record = await deps.readGateway(gatewayId);
    if (!record) return { steps: [], success: false, error: `gateway ${gatewayId} does not exist` };
    if (resolveGatewayRuntime(record.runtime) !== "gce-vm") {
      return { steps: [], success: false, error: `gateway ${gatewayId} runtime is ${resolveGatewayRuntime(record.runtime)}, not gce-vm` };
    }
    if (action === "replace") return replaceVm(deps, gatewayId, record, ctx);

    const startedAt = deps.now();
    const stepName = `vm-${action}`;
    try {
      const output = await run(deps, gatewayId, action, record);
      const done = step(stepName, "done", startedAt, deps.now());
      await ctx.reportStep(done);
      return { steps: [done], success: true, output };
    } catch (err) {
      const message = errorMessage(err);
      const failed = step(stepName, "failed", startedAt, deps.now(), message);
      await ctx.reportStep(failed);
      return { steps: [failed], success: false, error: message };
    }
  };
}

async function run(
  deps: GatewayVmDeps,
  gatewayId: string,
  action: Exclude<GatewayVmAction, "replace">,
  record: GatewayVmRecord,
): Promise<Record<string, unknown>> {
  const vm = record.vm;
  if (!vm) throw new Error(`gateway ${gatewayId} has no VM to ${action}`);
  if (action === "delete") {
    const deleted = await deps.vm.delete(vm.instanceName, vm.zone);
    await deps.writeVmState(gatewayId, null);
    deps.log(`[gateway-vm] ${gatewayId}: ${deleted ? "deleted" : "already absent"} ${vm.instanceName}`);
    return { instanceName: vm.instanceName, deleted };
  }
  let fellBackToStandard = false;
  if (action === "stop") await deps.vm.stop(vm.instanceName, vm.zone);
  else fellBackToStandard = (await deps.vm.start(vm.instanceName, vm.zone)).fellBackToStandard;
  const description = await deps.vm.describe(vm.instanceName, vm.zone);
  if (!description) throw new Error(`gateway ${gatewayId}: ${vm.instanceName} vanished during ${action}`);
  const state = stateFrom(description, deps.now(), action === "stop" ? "operator" : null);
  await deps.writeVmState(gatewayId, state);
  deps.log(`[gateway-vm] ${gatewayId}: ${action} ${vm.instanceName} -> ${state.status}${fellBackToStandard ? " (on-demand fallback)" : ""}`);
  return { instanceName: vm.instanceName, status: state.status, internalIp: state.internalIp, fellBackToStandard };
}

async function awaitFinalHomeCheckpoint(deps: GatewayVmDeps, gatewayId: string, ctx: OperationContext, requestedAt: number): Promise<number> {
  const timeoutMs = deps.replaceCheckpointTimeoutMs ?? HOME_CHECKPOINT_TIMEOUT_MS;
  await deps.requestHomeCheckpoint(gatewayId, requestedAt);
  const result = await awaitHomeCheckpoint(
    { readHomeCheckpointCompletedAt: deps.readHomeCheckpointCompletedAt, wait: deps.wait, now: deps.now, timeoutMs, pollMs: deps.replaceCheckpointPollMs },
    { gatewayId, requestedAt, cancellationRequested: ctx.cancellationRequested },
  );
  if (result.outcome === "completed") return result.completedAt;
  if (result.outcome === "cancelled") throw new Error(`gateway ${gatewayId}: replace cancelled while waiting for the final home checkpoint`);
  throw new Error(`gateway ${gatewayId}: the VM agent did not complete the requested home checkpoint within ${timeoutMs}ms; VM kept`);
}

async function startForFinalCheckpoint(deps: GatewayVmDeps, gatewayId: string, stopped: GatewayVmDescription): Promise<void> {
  const started = await deps.vm.start(stopped.name, stopped.zone);
  const description = await deps.vm.describe(stopped.name, stopped.zone);
  if (!description) throw new Error(`gateway ${gatewayId}: ${stopped.name} vanished while starting for its final home checkpoint`);
  await deps.writeVmState(gatewayId, stateFrom(description, deps.now(), null));
  deps.log(`[gateway-vm] ${gatewayId}: started ${stopped.name} (was ${stopped.status}) for its final home checkpoint -> ${description.status}${started.fellBackToStandard ? " (on-demand fallback)" : ""}`);
}

function reportedPhases(deps: GatewayVmDeps, ctx: OperationContext, steps: OperationStep[]) {
  return async <T>(name: string, work: () => Promise<T>): Promise<T> => {
    const startedAt = deps.now();
    try {
      const value = await work();
      const done = step(name, "done", startedAt, deps.now());
      steps.push(done);
      await ctx.reportStep(done);
      return value;
    } catch (err) {
      const failed = step(name, "failed", startedAt, deps.now(), errorMessage(err));
      steps.push(failed);
      await ctx.reportStep(failed);
      throw err;
    }
  };
}

async function replaceVm(deps: GatewayVmDeps, gatewayId: string, record: GatewayVmRecord, ctx: OperationContext): Promise<OperationResult> {
  const vm = record.vm;
  if (!vm) return { steps: [], success: false, error: `gateway ${gatewayId} has no VM to replace` };
  const steps: OperationStep[] = [];
  const phase = reportedPhases(deps, ctx, steps);
  let checkpointRequested = false;
  try {
    const description = await deps.vm.describe(vm.instanceName, vm.zone);
    if (!description) throw new Error(`gateway ${gatewayId}: ${vm.instanceName} is absent from Compute; nothing to replace`);
    if (description.status === "STOPPING") throw new Error(`gateway ${gatewayId}: ${vm.instanceName} is still stopping; retry once it is TERMINATED`);
    if (STOPPED_STATUSES.has(description.status)) {
      await phase("vm-replace-start", () => startForFinalCheckpoint(deps, gatewayId, description));
    }
    checkpointRequested = true;
    const checkpointCompletedAt = await phase("vm-replace-checkpoint", () => awaitFinalHomeCheckpoint(deps, gatewayId, ctx, deps.now()));
    const deleted = await phase("vm-replace-delete", async () => {
      const removed = await deps.vm.delete(vm.instanceName, vm.zone);
      await deps.clearVmForReplacement(gatewayId);
      deps.log(`[gateway-vm] ${gatewayId}: ${removed ? "deleted" : "already absent"} ${vm.instanceName} after home checkpoint at ${checkpointCompletedAt}; converge recreates it`);
      return removed;
    });
    return { steps, success: true, output: { instanceName: vm.instanceName, deleted, checkpointCompletedAt } };
  } catch (err) {
    if (checkpointRequested) await deps.clearHomeCheckpointRequest(gatewayId);
    return { steps, success: false, error: errorMessage(err) };
  }
}

async function replaceParkedVm(deps: GatewayVmDeps, ownerUid: string, ctx: OperationContext): Promise<OperationResult> {
  const parked = await deps.readParkedComputer(ownerUid);
  if (!parked) return { steps: [], success: false, error: `Builder ${ownerUid} has no parked computer; a live computer is replaced through its gateway` };
  const steps: OperationStep[] = [];
  const phase = reportedPhases(deps, ctx, steps);
  try {
    const output = await phase("vm-replace-parked", () => deleteParkedComputer(deps, ownerUid, parked));
    return { steps, success: true, output };
  } catch (err) {
    return { steps, success: false, error: errorMessage(err) };
  }
}

async function deleteParkedComputer(deps: GatewayVmDeps, ownerUid: string, parked: BuilderParkedComputer): Promise<Record<string, unknown>> {
  const { instanceName, zone, checkpoint } = parked;
  if (checkpoint.outcome !== "fresh") {
    throw new Error(
      `Builder ${ownerUid}: ${instanceName} park checkpoint is stale (last checkpoint ${checkpoint.completedAt ?? "never"}); ` +
        "a final checkpoint needs a live gateway: activate the Builder and replace through that gateway",
    );
  }
  const description = await deps.vm.describe(instanceName, zone);
  if (!description) {
    await deps.clearParkedComputer(ownerUid);
    deps.log(`[gateway-vm] ${ownerUid}: parked ${instanceName} is already absent from Compute; cleared the parked record`);
    return { instanceName, deleted: false, checkpointCompletedAt: checkpoint.completedAt };
  }
  const labelledOwner = description.labels["octogee-owner-uid"];
  if (labelledOwner !== ownerUid.toLowerCase()) {
    throw new Error(`Builder ${ownerUid}: ${instanceName} is labelled for ${labelledOwner ?? "no owner"}, not ${ownerUid}; refusing to delete it`);
  }
  if (description.gatewayId && (await deps.readGateway(description.gatewayId))) {
    throw new Error(`Builder ${ownerUid}: ${instanceName} is bound to live gateway ${description.gatewayId}; replace it through that gateway`);
  }
  if (!STOPPED_STATUSES.has(description.status)) {
    throw new Error(`Builder ${ownerUid}: expected the parked computer to be stopped, found ${description.status}`);
  }
  const deleted = await deps.vm.delete(instanceName, zone);
  await deps.clearParkedComputer(ownerUid);
  deps.log(`[gateway-vm] ${ownerUid}: ${deleted ? "deleted" : "already absent"} parked ${instanceName} (park checkpoint at ${checkpoint.completedAt}); the next activation cold-creates and restores`);
  return { instanceName, deleted, checkpointCompletedAt: checkpoint.completedAt };
}
