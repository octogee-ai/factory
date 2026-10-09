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

export const GATEWAY_VM_ACTIONS = ["stop", "start", "delete", "replace"] as const;
export type GatewayVmAction = (typeof GATEWAY_VM_ACTIONS)[number];
const REPLACE_DISABLED = "State-preserving computer replacement is disabled until coverage, writer fencing, and recovery-anchor checks are implemented; VM and disks kept";

export interface GatewayVmRecord {
  runtime: unknown;
  vm: GatewayVmState | null;
}

export interface GatewayVmDeps {
  vm: GatewayVmClient;
  replaceStoppedComputer?: (gatewayId: string, operationId: string, assertAuthority: () => Promise<void>) => Promise<Record<string, unknown>>;
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
      if (!deps.replaceStoppedComputer) return { steps: [], success: false, error: REPLACE_DISABLED };
      const parked = await deps.readParkedComputer(ownerUid);
      if (!parked) return { steps: [], success: false, error: `Builder ${ownerUid} has no parked computer` };
      return replaceStopped(deps, parked.gatewayId, op, ctx);
    }
    if (!gatewayId) return { steps: [], success: false, error: "missing gatewayId in op.input" };
    if (!isAction(input.action)) {
      return { steps: [], success: false, error: `gateway-vm action must be one of ${GATEWAY_VM_ACTIONS.join(", ")}` };
    }
    const action = input.action;
    const record = await deps.readGateway(gatewayId);
    if (!record && action === "replace") return replaceStopped(deps, gatewayId, op, ctx);
    if (!record) return { steps: [], success: false, error: `gateway ${gatewayId} does not exist` };
    if (resolveGatewayRuntime(record.runtime) !== "gce-vm") {
      return { steps: [], success: false, error: `gateway ${gatewayId} runtime is ${resolveGatewayRuntime(record.runtime)}, not gce-vm` };
    }
    if (action === "replace") return replaceStopped(deps, gatewayId, op, ctx);

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

async function replaceStopped(deps: GatewayVmDeps, gatewayId: string, op: Operation, ctx: OperationContext): Promise<OperationResult> {
  if (!deps.replaceStoppedComputer) return { steps: [], success: false, error: REPLACE_DISABLED };
  const startedAt = deps.now();
  try {
    const output = await deps.replaceStoppedComputer(gatewayId, op.id, async () => {
      await ctx.assertActiveClaim?.();
      if (await ctx.cancellationRequested?.()) throw new Error("boot replacement cancelled; retained home and source computer kept");
    });
    const done = step("vm-replace-boot", "done", startedAt, deps.now());
    await ctx.reportStep(done);
    return { steps: [done], success: true, output };
  } catch (error) {
    const message = errorMessage(error);
    const failed = step("vm-replace-boot", "failed", startedAt, deps.now(), message);
    await ctx.reportStep(failed);
    return { steps: [failed], success: false, error: message };
  }
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
