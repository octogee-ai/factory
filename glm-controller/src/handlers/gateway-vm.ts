import {
  gatewayVmInstanceName,
  resolveGatewayRuntime,
  type GatewayVmSpec,
  type GatewayVmState,
  type Operation,
  type OperationStep,
} from "@octogee/shared/types/glm";
import type { OperationContext, OperationHandler, OperationResult } from "../operation-router.js";
import type { GatewayVmClient, GatewayVmDescription } from "../lib/compute-vm.js";

export const GATEWAY_VM_ACTIONS = ["create", "stop", "start", "delete"] as const;
export type GatewayVmAction = (typeof GATEWAY_VM_ACTIONS)[number];

export interface GatewayVmRecord {
  runtime: unknown;
  vmSpec: GatewayVmSpec | null;
  vm: GatewayVmState | null;
  ownerUid: string | null;
}

export interface GatewayVmDeps {
  vm: GatewayVmClient;
  readGateway: (gatewayId: string) => Promise<GatewayVmRecord | null>;
  writeVmState: (gatewayId: string, vm: GatewayVmState | null) => Promise<void>;
  environment: string;
  now: () => number;
  log: (msg: string) => void;
}

interface GatewayVmInput {
  gatewayId?: unknown;
  action?: unknown;
}

function isAction(value: unknown): value is GatewayVmAction {
  return typeof value === "string" && (GATEWAY_VM_ACTIONS as readonly string[]).includes(value);
}

function isVmSpec(value: unknown): value is GatewayVmSpec {
  const spec = value as Partial<GatewayVmSpec> | null;
  return !!spec
    && typeof spec.zone === "string" && spec.zone.length > 0
    && typeof spec.machineType === "string" && spec.machineType.length > 0
    && typeof spec.imageFamily === "string" && spec.imageFamily.length > 0
    && typeof spec.diskSizeGb === "number" && spec.diskSizeGb > 0
    && (spec.provisioningModel === "SPOT" || spec.provisioningModel === "STANDARD")
    && typeof spec.serviceAccountEmail === "string" && spec.serviceAccountEmail.length > 0
    && typeof spec.subnetwork === "string" && spec.subnetwork.length > 0;
}

function stateFrom(description: GatewayVmDescription, now: number): GatewayVmState {
  return {
    instanceName: description.name,
    zone: description.zone,
    instanceId: description.instanceId,
    internalIp: description.internalIp,
    status: description.status,
    provisioningModel: description.provisioningModel,
    updatedAt: now,
  };
}

function step(name: string, status: OperationStep["status"], startedAt: number, now: number, error?: string): OperationStep {
  return { name, status, startedAt, completedAt: now, ...(error ? { error } : {}) };
}

export function createGatewayVmHandler(deps: GatewayVmDeps): OperationHandler {
  return async (op: Operation, ctx: OperationContext): Promise<OperationResult> => {
    const input = op.input as GatewayVmInput;
    const gatewayId = typeof input.gatewayId === "string" && input.gatewayId.length > 0 ? input.gatewayId : undefined;
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

    const startedAt = deps.now();
    const stepName = `vm-${action}`;
    try {
      const output = await run(deps, gatewayId, action, record);
      const done = step(stepName, "done", startedAt, deps.now());
      await ctx.reportStep(done);
      return { steps: [done], success: true, output };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const failed = step(stepName, "failed", startedAt, deps.now(), message);
      await ctx.reportStep(failed);
      return { steps: [failed], success: false, error: message };
    }
  };
}

async function createVm(deps: GatewayVmDeps, gatewayId: string, record: GatewayVmRecord): Promise<Record<string, unknown>> {
  if (!isVmSpec(record.vmSpec)) throw new Error(`gateway ${gatewayId} has no valid vmSpec`);
  const spec = record.vmSpec;
  const instanceName = gatewayVmInstanceName(gatewayId);
  const result = await deps.vm.create({
    instanceName,
    zone: spec.zone,
    machineType: spec.machineType,
    imageFamily: spec.imageFamily,
    ...(spec.imageProject ? { imageProject: spec.imageProject } : {}),
    diskSizeGb: spec.diskSizeGb,
    provisioningModel: spec.provisioningModel,
    serviceAccountEmail: spec.serviceAccountEmail,
    subnetwork: spec.subnetwork,
    labels: {
      "octogee-gateway-id": gatewayId.toLowerCase(),
      "octogee-environment": deps.environment,
      purpose: "octogee-computer",
      ...(record.ownerUid ? { "octogee-owner-uid": record.ownerUid.toLowerCase() } : {}),
    },
    metadata: { "gateway-id": gatewayId, "octogee-environment": deps.environment },
  });
  const state = stateFrom(result.description, deps.now());
  try {
    await deps.writeVmState(gatewayId, state);
  } catch (err) {
    if (!result.alreadyExisted) {
      await deps.vm.delete(instanceName, spec.zone);
      deps.log(`[gateway-vm] ${gatewayId}: gateway record refused the VM state; deleted the fresh ${instanceName} rather than orphan it`);
    }
    throw err;
  }
  deps.log(
    `[gateway-vm] ${gatewayId}: ${result.alreadyExisted ? "reused" : "created"} ${instanceName} ` +
      `(${result.provisioningModel}${result.fellBackToStandard ? ", spot fallback" : ""}) at ${state.internalIp ?? "no-ip"}`,
  );
  return { instanceName, provisioningModel: result.provisioningModel, fellBackToStandard: result.fellBackToStandard, internalIp: state.internalIp };
}

async function run(
  deps: GatewayVmDeps,
  gatewayId: string,
  action: GatewayVmAction,
  record: GatewayVmRecord,
): Promise<Record<string, unknown>> {
  if (action === "create") return createVm(deps, gatewayId, record);

  const vm = record.vm;
  if (!vm) throw new Error(`gateway ${gatewayId} has no VM to ${action}`);
  if (action === "delete") {
    const deleted = await deps.vm.delete(vm.instanceName, vm.zone);
    await deps.writeVmState(gatewayId, null);
    deps.log(`[gateway-vm] ${gatewayId}: ${deleted ? "deleted" : "already absent"} ${vm.instanceName}`);
    return { instanceName: vm.instanceName, deleted };
  }
  if (action === "stop") await deps.vm.stop(vm.instanceName, vm.zone);
  else await deps.vm.start(vm.instanceName, vm.zone);
  const description = await deps.vm.describe(vm.instanceName, vm.zone);
  if (!description) throw new Error(`gateway ${gatewayId}: ${vm.instanceName} vanished during ${action}`);
  const state = stateFrom(description, deps.now());
  await deps.writeVmState(gatewayId, state);
  deps.log(`[gateway-vm] ${gatewayId}: ${action} ${vm.instanceName} -> ${state.status}`);
  return { instanceName: vm.instanceName, status: state.status, internalIp: state.internalIp };
}
