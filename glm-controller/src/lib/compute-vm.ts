import type { GatewayVmProvisioningModel } from "@octogee/shared/types/glm";

export interface ComputeRequest {
  (opts: { url: string; method: string; body?: unknown }): Promise<{ status: number; data?: unknown }>;
}

export interface GatewayVmClientDeps {
  request: ComputeRequest;
  projectId: string;
  log: (msg: string) => void;
  wait: (ms: number) => Promise<void>;
  now: () => number;
  operationTimeoutMs?: number;
  pollIntervalMs?: number;
}

export interface CreateGatewayVmInput {
  instanceName: string;
  zone: string;
  machineType: string;
  imageFamily: string;
  diskSizeGb: number;
  provisioningModel: GatewayVmProvisioningModel;
  serviceAccountEmail: string;
  subnetwork: string;
  labels: Record<string, string>;
  metadata: Record<string, string>;
}

export interface GatewayVmDescription {
  name: string;
  zone: string;
  status: string;
  instanceId: string | null;
  internalIp: string | null;
  provisioningModel: GatewayVmProvisioningModel | null;
}

export interface CreateGatewayVmResult {
  description: GatewayVmDescription;
  provisioningModel: GatewayVmProvisioningModel;
  fellBackToStandard: boolean;
  alreadyExisted: boolean;
}

export interface GatewayVmClient {
  create(input: CreateGatewayVmInput): Promise<CreateGatewayVmResult>;
  describe(instanceName: string, zone: string): Promise<GatewayVmDescription | null>;
  stop(instanceName: string, zone: string): Promise<void>;
  start(instanceName: string, zone: string): Promise<void>;
  delete(instanceName: string, zone: string): Promise<boolean>;
}

export class ComputeOperationError extends Error {
  constructor(
    message: string,
    readonly codes: readonly string[],
  ) {
    super(message);
    this.name = "ComputeOperationError";
  }
}

const SPOT_EXHAUSTED_CODES = new Set([
  "ZONE_RESOURCE_POOL_EXHAUSTED",
  "ZONE_RESOURCE_POOL_EXHAUSTED_WITH_DETAILS",
]);
const DEFAULT_OPERATION_TIMEOUT_MS = 300_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;

interface ComputeOperation {
  name?: string;
  status?: string;
  error?: { errors?: Array<{ code?: string; message?: string }> };
}

interface ComputeInstance {
  id?: string;
  name?: string;
  status?: string;
  networkInterfaces?: Array<{ networkIP?: string }>;
  scheduling?: { provisioningModel?: string };
}

function statusOf(err: unknown): number | undefined {
  const e = err as { response?: { status?: number }; code?: number | string } | null;
  const code = e?.response?.status ?? e?.code;
  return typeof code === "number" ? code : undefined;
}

function isProvisioningModel(value: unknown): value is GatewayVmProvisioningModel {
  return value === "SPOT" || value === "STANDARD";
}

export function instanceInsertBody(projectId: string, input: CreateGatewayVmInput, provisioningModel: GatewayVmProvisioningModel): Record<string, unknown> {
  const spot = provisioningModel === "SPOT";
  return {
    name: input.instanceName,
    machineType: `zones/${input.zone}/machineTypes/${input.machineType}`,
    disks: [
      {
        boot: true,
        autoDelete: true,
        initializeParams: {
          sourceImage: `projects/${projectId}/global/images/family/${input.imageFamily}`,
          diskSizeGb: String(input.diskSizeGb),
          diskType: `zones/${input.zone}/diskTypes/pd-ssd`,
        },
      },
    ],
    networkInterfaces: [{ subnetwork: input.subnetwork }],
    serviceAccounts: [
      { email: input.serviceAccountEmail, scopes: ["https://www.googleapis.com/auth/cloud-platform"] },
    ],
    scheduling: spot
      ? { provisioningModel: "SPOT", instanceTerminationAction: "STOP", automaticRestart: false, onHostMaintenance: "TERMINATE" }
      : { provisioningModel: "STANDARD", automaticRestart: true, onHostMaintenance: "MIGRATE" },
    shieldedInstanceConfig: { enableSecureBoot: false, enableVtpm: true, enableIntegrityMonitoring: true },
    labels: input.labels,
    metadata: {
      items: Object.entries(input.metadata).map(([key, value]) => ({ key, value })),
    },
  };
}

export function createGatewayVmClient(deps: GatewayVmClientDeps): GatewayVmClient {
  const base = `https://compute.googleapis.com/compute/v1/projects/${deps.projectId}`;
  const operationTimeoutMs = deps.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  async function waitForOperation(zone: string, operation: ComputeOperation, what: string): Promise<void> {
    const name = operation.name;
    if (!name) throw new Error(`${what}: compute returned an operation without a name`);
    const deadline = deps.now() + operationTimeoutMs;
    let current = operation;
    while (current.status !== "DONE") {
      if (deps.now() >= deadline) {
        throw new Error(`${what}: operation ${name} did not finish within ${operationTimeoutMs}ms`);
      }
      await deps.wait(pollIntervalMs);
      const res = await deps.request({ url: `${base}/zones/${zone}/operations/${name}`, method: "GET" });
      current = (res.data ?? {}) as ComputeOperation;
    }
    const errors = current.error?.errors ?? [];
    if (errors.length > 0) {
      const codes = errors.map((e) => e.code ?? "UNKNOWN");
      const detail = errors.map((e) => [e.code ?? "UNKNOWN", e.message ?? ""].join(": ")).join("; ");
      throw new ComputeOperationError(`${what}: ${detail}`, codes);
    }
  }

  async function describe(instanceName: string, zone: string): Promise<GatewayVmDescription | null> {
    let data: ComputeInstance;
    try {
      const res = await deps.request({ url: `${base}/zones/${zone}/instances/${instanceName}`, method: "GET" });
      data = (res.data ?? {}) as ComputeInstance;
    } catch (err) {
      if (statusOf(err) === 404) return null;
      throw err;
    }
    const model = data.scheduling?.provisioningModel;
    return {
      name: data.name ?? instanceName,
      zone,
      status: data.status ?? "UNKNOWN",
      instanceId: typeof data.id === "string" && data.id.length > 0 ? data.id : null,
      internalIp: data.networkInterfaces?.[0]?.networkIP ?? null,
      provisioningModel: isProvisioningModel(model) ? model : null,
    };
  }

  async function insert(input: CreateGatewayVmInput, provisioningModel: GatewayVmProvisioningModel): Promise<"created" | "exists"> {
    let res: { status: number; data?: unknown };
    try {
      res = await deps.request({
        url: `${base}/zones/${input.zone}/instances`,
        method: "POST",
        body: instanceInsertBody(deps.projectId, input, provisioningModel),
      });
    } catch (err) {
      if (statusOf(err) === 409) return "exists";
      throw err;
    }
    if (res.status === 409) return "exists";
    await waitForOperation(input.zone, (res.data ?? {}) as ComputeOperation, `insert ${input.instanceName}`);
    return "created";
  }

  async function create(input: CreateGatewayVmInput): Promise<CreateGatewayVmResult> {
    let provisioningModel = input.provisioningModel;
    let fellBackToStandard = false;
    let outcome: "created" | "exists";
    try {
      outcome = await insert(input, provisioningModel);
    } catch (err) {
      const exhausted = err instanceof ComputeOperationError && err.codes.some((code) => SPOT_EXHAUSTED_CODES.has(code));
      if (!(exhausted && provisioningModel === "SPOT")) throw err;
      deps.log(`[gateway-vm] ${input.instanceName}: spot capacity exhausted in ${input.zone}; retrying on-demand`);
      provisioningModel = "STANDARD";
      fellBackToStandard = true;
      outcome = await insert(input, provisioningModel);
    }
    const description = await describe(input.instanceName, input.zone);
    if (!description) throw new Error(`insert ${input.instanceName}: instance vanished after ${outcome}`);
    if (outcome === "exists") {
      deps.log(`[gateway-vm] ${input.instanceName}: already exists (${description.status}); reusing`);
    }
    return {
      description,
      provisioningModel: description.provisioningModel ?? provisioningModel,
      fellBackToStandard,
      alreadyExisted: outcome === "exists",
    };
  }

  async function lifecycle(action: "stop" | "start", instanceName: string, zone: string): Promise<void> {
    const res = await deps.request({ url: `${base}/zones/${zone}/instances/${instanceName}/${action}`, method: "POST" });
    await waitForOperation(zone, (res.data ?? {}) as ComputeOperation, `${action} ${instanceName}`);
  }

  async function remove(instanceName: string, zone: string): Promise<boolean> {
    let res: { status: number; data?: unknown };
    try {
      res = await deps.request({ url: `${base}/zones/${zone}/instances/${instanceName}`, method: "DELETE" });
    } catch (err) {
      if (statusOf(err) === 404) {
        deps.log(`[gateway-vm] ${instanceName}: already absent`);
        return false;
      }
      throw err;
    }
    await waitForOperation(zone, (res.data ?? {}) as ComputeOperation, `delete ${instanceName}`);
    return true;
  }

  return {
    create,
    describe,
    stop: (instanceName, zone) => lifecycle("stop", instanceName, zone),
    start: (instanceName, zone) => lifecycle("start", instanceName, zone),
    delete: remove,
  };
}
