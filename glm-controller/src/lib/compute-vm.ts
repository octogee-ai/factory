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
  imageProject?: string;
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
  gatewayId: string | null;
  labels: Record<string, string>;
  labelFingerprint: string | null;
  metadata: Record<string, string>;
  metadataFingerprint: string | null;
  creationTimestamp: string | null;
}

export interface ListGatewayVmsInput {
  zone: string;
  labels: Record<string, string>;
}

export type GuardedWriteOutcome = "applied" | "conflict";

export interface StartGatewayVmResult {
  fellBackToStandard: boolean;
}

export interface BindGatewayVmInput {
  labels: Record<string, string>;
  metadata: Record<string, string>;
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
  find(instanceName: string): Promise<GatewayVmDescription | null>;
  findByLabels(labels: Record<string, string>): Promise<GatewayVmDescription | null>;
  list(input: ListGatewayVmsInput): Promise<GatewayVmDescription[]>;
  bind(instanceName: string, zone: string, input: BindGatewayVmInput): Promise<void>;
  setMetadata(instanceName: string, zone: string, input: { fingerprint: string; items: Record<string, string> }): Promise<GuardedWriteOutcome>;
  setLabels(instanceName: string, zone: string, input: { fingerprint: string; labels: Record<string, string> }): Promise<GuardedWriteOutcome>;
  stop(instanceName: string, zone: string): Promise<void>;
  start(instanceName: string, zone: string): Promise<StartGatewayVmResult>;
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
const FINGERPRINT_MISMATCH_CODES = new Set(["CONDITION_NOT_MET"]);
export const GATEWAY_VM_NETWORK_TAG = "octogee-computer";
const GATEWAY_ID_METADATA_KEY = "gateway-id";
const DEFAULT_OPERATION_TIMEOUT_MS = 300_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;

interface ComputeOperation {
  name?: string;
  status?: string;
  error?: { errors?: Array<{ code?: string; message?: string }> };
}

interface ComputeMetadataItem {
  key?: string;
  value?: string;
}

interface ComputeInstance {
  id?: string;
  name?: string;
  zone?: string;
  status?: string;
  creationTimestamp?: string;
  networkInterfaces?: Array<{ networkIP?: string }>;
  scheduling?: { provisioningModel?: string };
  labels?: Record<string, string>;
  labelFingerprint?: string;
  metadata?: { fingerprint?: string; items?: ComputeMetadataItem[] };
}

interface ComputeInstanceList {
  items?: ComputeInstance[];
  nextPageToken?: string;
}

interface ComputeAggregatedInstances {
  items?: Record<string, { instances?: ComputeInstance[] }>;
}

function statusOf(err: unknown): number | undefined {
  const e = err as { response?: { status?: number }; code?: number | string } | null;
  const code = e?.response?.status ?? e?.code;
  return typeof code === "number" ? code : undefined;
}

function isProvisioningModel(value: unknown): value is GatewayVmProvisioningModel {
  return value === "SPOT" || value === "STANDARD";
}

function isSpotExhausted(err: unknown): boolean {
  return err instanceof ComputeOperationError && err.codes.some((code) => SPOT_EXHAUSTED_CODES.has(code));
}

function schedulingFor(provisioningModel: GatewayVmProvisioningModel): Record<string, unknown> {
  return provisioningModel === "SPOT"
    ? { provisioningModel: "SPOT", instanceTerminationAction: "STOP", automaticRestart: false, onHostMaintenance: "TERMINATE" }
    : { provisioningModel: "STANDARD", automaticRestart: true, onHostMaintenance: "MIGRATE" };
}

function metadataItems(metadata: Record<string, string>): Array<{ key: string; value: string }> {
  return Object.entries(metadata).map(([key, value]) => ({ key, value }));
}

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function labelFilter(labels: Record<string, string>): string {
  return Object.entries(labels).map(([key, value]) => `(labels.${key} = ${JSON.stringify(value)})`).join(" AND ");
}

function metadataRecord(items: ComputeMetadataItem[] | undefined): Record<string, string> {
  const metadata: Record<string, string> = {};
  for (const item of items ?? []) {
    if (typeof item.key === "string" && item.key.length > 0) metadata[item.key] = item.value ?? "";
  }
  return metadata;
}

function zoneOf(instance: ComputeInstance, fallback: string): string {
  const segment = instance.zone?.split("/").at(-1);
  return segment && segment.length > 0 ? segment : fallback;
}

function carriesLabels(labels: Record<string, string>): (instance: ComputeInstance) => boolean {
  return (instance) => Object.entries(labels).every(([key, value]) => instance.labels?.[key] === value);
}

function ambiguousByName(instanceName: string, matches: ComputeInstance[]): string {
  return `find ${instanceName}: ${matches.length} instances named ${instanceName} (${matches.map((m) => zoneOf(m, "?")).join(", ")})`;
}

function ambiguousByLabels(filter: string, matches: ComputeInstance[]): string {
  const where = matches.map((m) => [m.name ?? "?", "in", zoneOf(m, "?")].join(" ")).join(", ");
  return `find ${filter}: ${matches.length} instances match (${where})`;
}

function describeInstance(instance: ComputeInstance, instanceName: string, zone: string): GatewayVmDescription {
  const model = instance.scheduling?.provisioningModel;
  const metadata = metadataRecord(instance.metadata?.items);
  return {
    name: instance.name ?? instanceName,
    zone,
    status: instance.status ?? "UNKNOWN",
    instanceId: nonEmpty(instance.id),
    internalIp: instance.networkInterfaces?.[0]?.networkIP ?? null,
    provisioningModel: isProvisioningModel(model) ? model : null,
    gatewayId: nonEmpty(metadata[GATEWAY_ID_METADATA_KEY]),
    labels: { ...(instance.labels ?? {}) },
    labelFingerprint: nonEmpty(instance.labelFingerprint),
    metadata,
    metadataFingerprint: nonEmpty(instance.metadata?.fingerprint),
    creationTimestamp: nonEmpty(instance.creationTimestamp),
  };
}

export function instanceInsertBody(projectId: string, input: CreateGatewayVmInput, provisioningModel: GatewayVmProvisioningModel): Record<string, unknown> {
  return {
    name: input.instanceName,
    machineType: `zones/${input.zone}/machineTypes/${input.machineType}`,
    disks: [
      {
        boot: true,
        autoDelete: true,
        initializeParams: {
          sourceImage: `projects/${input.imageProject ?? projectId}/global/images/family/${input.imageFamily}`,
          diskSizeGb: String(input.diskSizeGb),
          diskType: `zones/${input.zone}/diskTypes/pd-ssd`,
        },
      },
    ],
    networkInterfaces: [{ subnetwork: input.subnetwork }],
    serviceAccounts: [
      { email: input.serviceAccountEmail, scopes: ["https://www.googleapis.com/auth/cloud-platform"] },
    ],
    scheduling: schedulingFor(provisioningModel),
    shieldedInstanceConfig: { enableSecureBoot: false, enableVtpm: true, enableIntegrityMonitoring: true },
    tags: { items: [GATEWAY_VM_NETWORK_TAG] },
    labels: input.labels,
    metadata: { items: metadataItems(input.metadata) },
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

  async function readInstance(instanceName: string, zone: string): Promise<ComputeInstance | null> {
    try {
      const res = await deps.request({ url: `${base}/zones/${zone}/instances/${instanceName}`, method: "GET" });
      return (res.data ?? {}) as ComputeInstance;
    } catch (err) {
      if (statusOf(err) === 404) return null;
      throw err;
    }
  }

  async function describe(instanceName: string, zone: string): Promise<GatewayVmDescription | null> {
    const instance = await readInstance(instanceName, zone);
    return instance ? describeInstance(instance, instanceName, zone) : null;
  }

  async function aggregatedFind(
    filter: string,
    keep: (instance: ComputeInstance) => boolean,
    ambiguity: (matches: ComputeInstance[]) => string,
  ): Promise<GatewayVmDescription | null> {
    const res = await deps.request({ url: `${base}/aggregated/instances?filter=${encodeURIComponent(filter)}`, method: "GET" });
    const items = ((res.data ?? {}) as ComputeAggregatedInstances).items ?? {};
    const matches = Object.values(items).flatMap((scope) => scope.instances ?? []).filter(keep);
    if (matches.length > 1) throw new Error(ambiguity(matches));
    return matches.length === 1 ? describeInstance(matches[0], matches[0].name ?? "unknown", zoneOf(matches[0], "")) : null;
  }

  function find(instanceName: string): Promise<GatewayVmDescription | null> {
    return aggregatedFind(`name = "${instanceName}"`, (instance) => instance.name === instanceName, (matches) => ambiguousByName(instanceName, matches));
  }

  function findByLabels(labels: Record<string, string>): Promise<GatewayVmDescription | null> {
    const filter = labelFilter(labels);
    return aggregatedFind(filter, carriesLabels(labels), (matches) => ambiguousByLabels(filter, matches));
  }

  async function list(input: ListGatewayVmsInput): Promise<GatewayVmDescription[]> {
    const members: GatewayVmDescription[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({ filter: labelFilter(input.labels) });
      if (pageToken) params.set("pageToken", pageToken);
      const res = await deps.request({ url: `${base}/zones/${input.zone}/instances?${params.toString()}`, method: "GET" });
      const page = (res.data ?? {}) as ComputeInstanceList;
      for (const item of page.items ?? []) members.push(describeInstance(item, item.name ?? "unknown", input.zone));
      pageToken = nonEmpty(page.nextPageToken) ?? undefined;
    } while (pageToken);
    return members;
  }

  async function guardedWrite(instanceName: string, zone: string, verb: "setMetadata" | "setLabels", body: Record<string, unknown>): Promise<GuardedWriteOutcome> {
    let res: { status: number; data?: unknown };
    try {
      res = await deps.request({ url: `${base}/zones/${zone}/instances/${instanceName}/${verb}`, method: "POST", body });
    } catch (err) {
      if (statusOf(err) === 412) return "conflict";
      throw err;
    }
    if (res.status === 412) return "conflict";
    try {
      await waitForOperation(zone, (res.data ?? {}) as ComputeOperation, `${verb} ${instanceName}`);
    } catch (err) {
      if (err instanceof ComputeOperationError && err.codes.some((code) => FINGERPRINT_MISMATCH_CODES.has(code))) return "conflict";
      throw err;
    }
    return "applied";
  }

  async function bind(instanceName: string, zone: string, input: BindGatewayVmInput): Promise<void> {
    const instance = await readInstance(instanceName, zone);
    if (!instance) throw new Error(`bind ${instanceName}: instance is absent`);
    if (!instance.labelFingerprint || !instance.metadata?.fingerprint) {
      throw new Error(`bind ${instanceName}: compute returned no label/metadata fingerprint`);
    }
    const labelsRes = await deps.request({
      url: `${base}/zones/${zone}/instances/${instanceName}/setLabels`,
      method: "POST",
      body: { labelFingerprint: instance.labelFingerprint, labels: input.labels },
    });
    await waitForOperation(zone, (labelsRes.data ?? {}) as ComputeOperation, `setLabels ${instanceName}`);
    const merged = new Map<string, string>();
    for (const item of instance.metadata.items ?? []) {
      if (typeof item.key === "string" && typeof item.value === "string") merged.set(item.key, item.value);
    }
    for (const [key, value] of Object.entries(input.metadata)) merged.set(key, value);
    const metadataRes = await deps.request({
      url: `${base}/zones/${zone}/instances/${instanceName}/setMetadata`,
      method: "POST",
      body: { fingerprint: instance.metadata.fingerprint, items: [...merged].map(([key, value]) => ({ key, value })) },
    });
    await waitForOperation(zone, (metadataRes.data ?? {}) as ComputeOperation, `setMetadata ${instanceName}`);
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
      if (!(isSpotExhausted(err) && provisioningModel === "SPOT")) throw err;
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

  async function start(instanceName: string, zone: string): Promise<StartGatewayVmResult> {
    try {
      await lifecycle("start", instanceName, zone);
      return { fellBackToStandard: false };
    } catch (err) {
      if (!isSpotExhausted(err)) throw err;
    }
    deps.log(`[gateway-vm] ${instanceName}: spot capacity exhausted in ${zone}; restarting on-demand`);
    const res = await deps.request({
      url: `${base}/zones/${zone}/instances/${instanceName}/setScheduling`,
      method: "POST",
      body: schedulingFor("STANDARD"),
    });
    await waitForOperation(zone, (res.data ?? {}) as ComputeOperation, `setScheduling ${instanceName}`);
    await lifecycle("start", instanceName, zone);
    return { fellBackToStandard: true };
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
    find,
    findByLabels,
    list,
    bind,
    setMetadata: (name, zone, input) => guardedWrite(name, zone, "setMetadata", { fingerprint: input.fingerprint, items: metadataItems(input.items) }),
    setLabels: (name, zone, input) => guardedWrite(name, zone, "setLabels", { labelFingerprint: input.fingerprint, labels: input.labels }),
    stop: (instanceName, zone) => lifecycle("stop", instanceName, zone),
    start,
    delete: remove,
  };
}
