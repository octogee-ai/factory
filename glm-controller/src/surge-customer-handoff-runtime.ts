import { randomBytes, randomUUID } from "node:crypto";
import {
  type FlushGatewayResponse,
  type MigrationConfigTransferMode,
  MIGRATION_QUIESCE_TIMEOUT_MS,
  SIGNATURE_HEADER,
  type PrepareRsyncImportResponse,
} from "@octogee/shared/types/fleet-controller";
import { gatewayScopedJobId, signFleetRequest } from "@octogee/core/fleet-signature";
import { isValidUsername } from "@octogee/shared/types/identity";
import { describeFleetStateRejection, requestFleetState } from "./fleet-state-client.js";
import { parseFleetStateResponse, type GatewayFleetState } from "./gateway-heartbeat-poller.js";
import {
  SurgeGatewayScopedSignatureCapabilityMissingError,
  SurgeOpenClawProcessEndpointMissingError,
  type SurgeCustomerHandoffDeps,
  type SurgeFleetSignatureCapability,
  type SurgePod,
  type SurgePodHealth,
  type SurgePodSnapshot,
  type SurgePrelaunchState,
} from "./surge-customer-handoff.js";

interface KubectlResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type SurgeKubectl = (args: string[]) => Promise<KubectlResult>;

interface PodList {
  items?: Array<{
    metadata?: {
      uid?: string;
      name?: string;
      deletionTimestamp?: string;
    };
    status?: {
      phase?: string;
      podIP?: string;
      conditions?: Array<{ type?: string; status?: string }>;
    };
  }>;
}

class SurgePodControlError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
    readonly body: unknown | null,
  ) {
    super(message);
  }
}

class SurgePodFleetStateError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export function parseSurgePodSnapshot(raw: string): SurgePodSnapshot {
  const parsed = JSON.parse(raw) as PodList;
  const observedPodUids: string[] = [];
  const pods: SurgePod[] = [];
  for (const item of parsed.items ?? []) {
    const { uid, name, deletionTimestamp } = item.metadata ?? {};
    const { phase, podIP, conditions } = item.status ?? {};
    if (uid) observedPodUids.push(uid);
    if (phase !== "Running" || !uid || !name || !podIP) continue;
    pods.push({
      uid,
      name,
      podIP,
      ready: (conditions ?? []).some((condition) =>
        condition.type === "Ready" && condition.status === "True"),
      terminating: Boolean(deletionTimestamp),
    });
  }
  return { pods, observedPodUids };
}

export async function listSurgePods(
  runKubectl: SurgeKubectl,
  namespace: string,
  gatewayId: string,
): Promise<SurgePodSnapshot> {
  const result = await runKubectl([
    "-n",
    namespace,
    "get",
    "pods",
    "-l",
    `app=octogee-gateway,gateway-instance=${gatewayId}`,
    "-o",
    "json",
  ]);
  if (result.code !== 0) {
    throw new Error(
      `kubectl get surge pods for ${gatewayId} failed: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return parseSurgePodSnapshot(result.stdout);
}

export const POD_SESSION_DIGEST_SCRIPT = [
  'import fs from "node:fs"; import path from "node:path"; import crypto from "node:crypto";',
  'import { assertConfiguredBuilderPortableStatePlanOnDisk, configuredBuilderPortableStatePlanFromConfig } from "/octogee/scripts/node_modules/@octogee/core/dist/local-coach-wired.js";',
  'const state=process.env.OPENCLAW_STATE_DIR||path.join(process.env.HOME||"/home/node",".openclaw"),slug=process.argv[1],mode=process.argv[2];',
  'const walk=(dir,prefix="")=>{if(!fs.existsSync(dir))return [];const root=fs.lstatSync(dir);if(root.isSymbolicLink()||!root.isDirectory())throw new Error(`non-regular durable state path: ${prefix||"."}`);const out=[];for(const item of fs.readdirSync(dir,{withFileTypes:true})){const relative=prefix?path.join(prefix,item.name):item.name,abs=path.join(dir,item.name),stat=fs.lstatSync(abs);if(stat.isSymbolicLink())out.push([relative,abs,"link"]);else if(stat.isDirectory())out.push(...walk(abs,relative));else if(stat.isFile())out.push([relative,abs,"file"]);else throw new Error(`non-regular durable state path: ${relative}`);}return out;};',
  'let files;if(mode==="configured-builder-system-config"){const configPath=process.env.OPENCLAW_CONFIG_PATH||path.join(state,"system_config","openclaw.json");let config;try{config=JSON.parse(fs.readFileSync(configPath,"utf8"));}catch(error){throw new Error(`cannot read configured Builder config: ${error instanceof Error?error.message:String(error)}`);}const plan=configuredBuilderPortableStatePlanFromConfig(config,state);assertConfiguredBuilderPortableStatePlanOnDisk(state,plan);files=plan.paths.flatMap((item)=>{const absolute=path.join(state,item.relativePath);if(!fs.existsSync(absolute))return [];const stat=fs.lstatSync(absolute);if(item.kind==="directory"){if(!stat.isDirectory())throw new Error(`configured Builder durable state directory is not a directory: ${item.relativePath}`);return walk(absolute,item.relativePath);}if(!stat.isFile())throw new Error(`configured Builder durable state file is not a file: ${item.relativePath}`);return [[item.relativePath,absolute,"file"]];}).filter(([relative])=>relative!==path.join("customers",slug,".system",".migrating-in"));}else{const root=path.join(state,"agents",`octogee-${slug}-coach`,"sessions");files=walk(root,path.join("agents",`octogee-${slug}-coach`,`sessions`));}',
  'files.sort(([left],[right])=>left.localeCompare(right));const hash=crypto.createHash("sha256");let totalBytes=0;',
  'for(const [relative,absolute,kind] of files){const contents=kind==="link"?Buffer.from(`symlink:${fs.readlinkSync(absolute)}`):fs.readFileSync(absolute);totalBytes+=contents.byteLength;hash.update(relative.split(path.sep).join("/"));hash.update("\\0");hash.update(contents);hash.update("\\0");}',
  'process.stdout.write(JSON.stringify({fileCount:files.length,totalBytes,sha256:hash.digest("hex")}));',
].join("");

interface SessionDigest {
  fileCount: number;
  totalBytes: number;
  sha256: string;
}

function parseSessionDigest(value: unknown, context: string): SessionDigest {
  const digest = value as Partial<SessionDigest> | null;
  if (
    !digest ||
    !Number.isSafeInteger(digest.fileCount) ||
    (digest.fileCount as number) < 0 ||
    !Number.isSafeInteger(digest.totalBytes) ||
    (digest.totalBytes as number) < 0 ||
    typeof digest.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(digest.sha256)
  ) {
    throw new Error(`${context}: invalid durable session digest`);
  }
  return {
    fileCount: digest.fileCount as number,
    totalBytes: digest.totalBytes as number,
    sha256: digest.sha256,
  };
}

export async function readPodDurableSessionDigest(
  runKubectl: SurgeKubectl,
  namespace: string,
  pod: SurgePod,
  slug: string,
  configTransferMode: MigrationConfigTransferMode = "activation-manifest",
): Promise<{ fileCount: number; totalBytes: number; sha256: string }> {
  if (!isValidUsername(slug)) throw new Error(`invalid customer slug for session digest: ${slug}`);
  const result = await runKubectl([
    "-n",
    namespace,
    "exec",
    `pod/${pod.name}`,
    "-c",
    "gateway",
    "--",
    "node",
    "--input-type=module",
    "-e",
    POD_SESSION_DIGEST_SCRIPT,
    slug,
    configTransferMode,
  ]);
  if (result.code !== 0) {
    throw new Error(
      `kubectl session digest pod=${pod.name} slug=${slug} failed: ` +
      `${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(`kubectl session digest pod=${pod.name} slug=${slug}: invalid JSON`);
  }
  return parseSessionDigest(parsed, `pod=${pod.name} slug=${slug}`);
}

const FLEET_STATE_READ_TIMEOUT_MS = 5_000;

function podBaseUrl(pod: SurgePod): string {
  const host = pod.podIP.includes(":") ? `[${pod.podIP}]` : pod.podIP;
  return `http://${host}:3003`;
}

async function responseJson(response: Response, context: string): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!response.ok) {
    let body: unknown | null = null;
    let code: string | null = null;
    try {
      body = JSON.parse(text);
      if (
        body !== null &&
        typeof body === "object" &&
        typeof (body as { code?: unknown }).code === "string"
      ) {
        code = (body as { code: string }).code;
      }
    } catch {}
    throw new SurgePodControlError(
      `${context}: ${response.status} ${text}`,
      response.status,
      code,
      body,
    );
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`${context}: invalid JSON response`);
  }
}

const SURGE_POD_CONTROL_TIMEOUT_MS = 330_000;
const SURGE_OPENCLAW_RESUME_TIMEOUT_MS = 720_000;

async function postSigned(
  opts: {
    fetch: typeof globalThis.fetch;
    privateKey: string;
    pod: SurgePod;
    gatewayId: string;
    path: string;
    operationId: string;
    body: Record<string, unknown>;
    timeoutMs?: number;
  },
): Promise<Record<string, unknown>> {
  const rawBody = JSON.stringify(opts.body);
  const response = await opts.fetch(
    `${podBaseUrl(opts.pod)}/${opts.path}/${encodeURIComponent(opts.gatewayId)}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [SIGNATURE_HEADER]: signFleetRequest(
          opts.privateKey,
          gatewayScopedJobId(opts.operationId, opts.gatewayId),
          rawBody,
        ),
      },
      body: rawBody,
      signal: AbortSignal.timeout(opts.timeoutMs ?? SURGE_POD_CONTROL_TIMEOUT_MS),
    },
  );
  return responseJson(response, `${opts.path} pod=${opts.pod.name}`);
}

async function readPodFleetState(
  opts: {
    fetch: typeof globalThis.fetch;
    privateKey: string;
    pod: SurgePod;
    gatewayId: string;
  },
): Promise<GatewayFleetState | null> {
  const response = await requestFleetState({
    baseUrl: podBaseUrl(opts.pod),
    gatewayId: opts.gatewayId,
    privateKey: opts.privateKey,
    timeoutMs: FLEET_STATE_READ_TIMEOUT_MS,
    fetchImpl: opts.fetch,
    newRequestId: randomUUID,
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new SurgePodFleetStateError(
      `fleet state pod=${opts.pod.name}: ${response.status} — ` +
      describeFleetStateRejection(response.status),
      response.status,
    );
  }
  const state = parseFleetStateResponse(await response.json());
  if (!state) throw new Error(`invalid fleet state response from pod=${opts.pod.name}`);
  return state;
}

export interface SurgePodTransportOptions {
  privateKey: string;
  fetch?: typeof globalThis.fetch;
  randomKey?: () => string;
  allowLegacyConfiguredBuilderConvergence?: boolean;
  log: (message: string) => void;
}

export type SurgePodTransport = Pick<
  SurgeCustomerHandoffDeps,
  | "readPodHealth"
  | "quiesce"
  | "stopSourceOpenClaw"
  | "resumeSourceOpenClaw"
  | "holdTargetOpenClaw"
  | "unreserveTargetOpenClaw"
  | "flush"
  | "transfer"
  | "discardTargetCustomer"
  | "releaseTarget"
>;

const SURGE_PRELAUNCH_STATES: readonly SurgePrelaunchState[] = [
  "none",
  "held",
  "hydrated",
  "starting",
  "serving",
];

// A pod that predates the process gate omits the field; anything else must be
// a known state or the whole health read is invalid.
function parsePrelaunchState(value: unknown): SurgePrelaunchState | null {
  if (value === undefined) return "none";
  return (SURGE_PRELAUNCH_STATES as readonly unknown[]).includes(value)
    ? value as SurgePrelaunchState
    : null;
}

interface SurgePodHealthReaderOptions {
  fetch: typeof globalThis.fetch;
  privateKey: string;
  rejectedSignaturePods: ReadonlyMap<string, string>;
  reportLegacySignaturePod: (pod: SurgePod, version: string) => string;
  reportRejectedSignaturePod: (pod: SurgePod, status: number) => string;
  log: (message: string) => void;
}

async function readSurgeHealthResponses(
  fetchImpl: typeof globalThis.fetch,
  pod: SurgePod,
): Promise<{ health: Record<string, unknown>; ready: Record<string, unknown> }> {
  const [healthResponse, readyResponse] = await Promise.all([
    fetchImpl(`${podBaseUrl(pod)}/health`, { signal: AbortSignal.timeout(5_000) }),
    fetchImpl(`${podBaseUrl(pod)}/surge-ready`, { signal: AbortSignal.timeout(5_000) }),
  ]);
  return {
    health: await responseJson(healthResponse, `health pod=${pod.name}`),
    ready: await readyResponse.json() as Record<string, unknown>,
  };
}

async function resolveSurgeFleetState(input: {
  fetch: typeof globalThis.fetch;
  privateKey: string;
  pod: SurgePod;
  gatewayId: string;
  health: Record<string, unknown>;
}): Promise<{
  state: GatewayFleetState | null;
  fleetSignatureCapability: SurgeFleetSignatureCapability;
}> {
  const legacyState = parseFleetStateResponse(input.health);
  if (legacyState) {
    return { state: legacyState, fleetSignatureCapability: "legacy" };
  }
  return {
    state: await readPodFleetState(input),
    fleetSignatureCapability: "gateway-scoped",
  };
}

function parseSurgePodHealth(input: {
  pod: SurgePod;
  health: Record<string, unknown>;
  ready: Record<string, unknown>;
  state: GatewayFleetState | null;
  fleetSignatureCapability: SurgeFleetSignatureCapability;
  reportLegacySignaturePod: (pod: SurgePod, version: string) => string;
}): SurgePodHealth {
  const prelaunchState = parsePrelaunchState(input.ready.prelaunchState);
  if (
    (input.health.status !== "booting" && input.health.status !== "ready") ||
    typeof input.state?.version !== "string" ||
    typeof input.ready.handoffReleased !== "boolean" ||
    typeof input.ready.openclawUp !== "boolean" ||
    prelaunchState === null
  ) {
    throw new Error(`invalid surge health response from pod=${input.pod.name}`);
  }
  if (input.fleetSignatureCapability === "legacy") {
    input.reportLegacySignaturePod(input.pod, input.state.version);
  }
  return {
    status: input.ready.openclawUp ? "ready" : "booting",
    version: input.state.version,
    fleetSignatureCapability: input.fleetSignatureCapability,
    handoffReleased: input.ready.handoffReleased,
    prelaunchState,
    mountedCustomers: [...new Set(input.state.customers)],
  };
}

async function readSurgePodHealth(
  opts: SurgePodHealthReaderOptions,
  pod: SurgePod,
  gatewayId: string,
): Promise<SurgePodHealth | null> {
  if (opts.rejectedSignaturePods.has(pod.uid)) return null;
  try {
    const { health, ready } = await readSurgeHealthResponses(opts.fetch, pod);
    const { state, fleetSignatureCapability } = await resolveSurgeFleetState({
      fetch: opts.fetch,
      privateKey: opts.privateKey,
      pod,
      gatewayId,
      health,
    });
    return parseSurgePodHealth({
      pod,
      health,
      ready,
      state,
      fleetSignatureCapability,
      reportLegacySignaturePod: opts.reportLegacySignaturePod,
    });
  } catch (error) {
    if (
      error instanceof SurgePodFleetStateError &&
      (error.status === 401 || error.status === 403)
    ) {
      opts.reportRejectedSignaturePod(pod, error.status);
      return null;
    }
    opts.log(
      `[surge-handoff] pod=${pod.name} health unavailable: ` +
      `${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

type SurgeControlCall = (
  pod: SurgePod,
  gatewayId: string,
  path: string,
  operationId: string,
  body: Record<string, unknown>,
  timeoutMs?: number,
) => Promise<Record<string, unknown>>;

async function controlSurgeOpenClawProcess(
  control: SurgeControlCall,
  input: {
    pod: SurgePod;
    gatewayId: string;
    path: "hold-surge-openclaw" | "resume-surge-openclaw" | "unreserve-surge-openclaw";
    operationId: string;
    slug: string;
    targetPodUid: string;
    capability: string;
    timeoutMs?: number;
  },
): Promise<void> {
  try {
    await control(
      input.pod,
      input.gatewayId,
      input.path,
      input.operationId,
      {
        migrationId: input.operationId,
        slug: input.slug,
        targetPodUid: input.targetPodUid,
      },
      input.timeoutMs,
    );
  } catch (error) {
    if (error instanceof SurgePodControlError && error.status === 404) {
      throw new SurgeOpenClawProcessEndpointMissingError(
        `pod ${input.pod.name} lacks the required surge OpenClaw ${input.capability} endpoint`,
        { cause: error },
      );
    }
    throw error;
  }
}

interface SurgeTransferRuntime {
  control: SurgeControlCall;
  randomKey: () => string;
  log: (message: string) => void;
  allowLegacyConfiguredBuilderConvergence: boolean;
}

type SurgeTransferInput = Parameters<SurgeCustomerHandoffDeps["transfer"]>[0];

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasNonNegativeDuration(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

const LEGACY_CONFIGURED_BUILDER_CONVERGENCE_STEPS = [
  ["session-quiesce", "skipped"],
  ["workspace-git", "failed"],
  ["blob-sync", "skipped"],
  ["system-config", "done"],
  ["gitea-key-release", "skipped"],
] as const;

function legacyConfiguredBuilderConvergenceResponse(
  error: unknown,
  input: Pick<SurgeTransferInput, "operationId" | "slug" | "expectedSystemConfigCommit">,
): Record<string, unknown> | null {
  if (!(error instanceof SurgePodControlError) || !input.expectedSystemConfigCommit) return null;
  const response = record(error.body);
  if (!response) return null;
  const expected = [
    error.status === 500,
    response.migrationId === input.operationId,
    response.slug === input.slug,
    response.ok === false,
    hasNonNegativeDuration(response.durationMs),
    response.systemConfigCommit === input.expectedSystemConfigCommit,
  ];
  return expected.every(Boolean) ? response : null;
}

function legacyConfiguredBuilderConvergenceSteps(
  value: unknown,
): Map<string, Record<string, unknown>> | null {
  if (!Array.isArray(value) || value.length !== LEGACY_CONFIGURED_BUILDER_CONVERGENCE_STEPS.length) {
    return null;
  }
  const steps = new Map<string, Record<string, unknown>>();
  for (const candidate of value) {
    const step = record(candidate);
    if (
      !step ||
      typeof step.name !== "string" ||
      typeof step.status !== "string" ||
      !hasNonNegativeDuration(step.durationMs) ||
      steps.has(step.name)
    ) {
      return null;
    }
    steps.set(step.name, step);
  }
  return steps.size === LEGACY_CONFIGURED_BUILDER_CONVERGENCE_STEPS.length ? steps : null;
}

function legacyConfiguredBuilderConvergenceStepsMatch(
  steps: ReadonlyMap<string, Record<string, unknown>>,
  slug: string,
): boolean {
  return LEGACY_CONFIGURED_BUILDER_CONVERGENCE_STEPS.every(([name, status]) => {
    const step = steps.get(name);
    const expectedError = name === "workspace-git"
      ? `[git-sync] durable flush failed: ${slug}: git metadata is missing`
      : undefined;
    return step?.status === status && step?.error === expectedError;
  });
}

function isLegacyConfiguredBuilderConvergenceResponse(
  error: unknown,
  input: Pick<SurgeTransferInput, "operationId" | "slug" | "expectedSystemConfigCommit">,
): boolean {
  const response = legacyConfiguredBuilderConvergenceResponse(error, input);
  if (!response) return false;
  const steps = legacyConfiguredBuilderConvergenceSteps(response.steps);
  return steps !== null && legacyConfiguredBuilderConvergenceStepsMatch(steps, input.slug);
}

async function abortTargetImport(
  runtime: SurgeTransferRuntime,
  input: SurgeTransferInput,
  mode: "keys" | "final",
): Promise<void> {
  const { gatewayId, slug, operationId, targetPod, configTransferMode } = input;
  await runtime.control(targetPod, gatewayId, "abort-rsync-import", operationId, {
    migrationId: operationId,
    slug,
    rpcPhase: "abort-rsync-import",
    mode,
    ...(mode === "final" ? { configTransferMode } : {}),
  }).catch((abortError) => {
    runtime.log(
      `[surge-handoff] abort failed pod=${targetPod.name} slug=${slug}: ` +
      `${abortError instanceof Error ? abortError.message : String(abortError)}`,
    );
  });
}

async function transferMode(
  runtime: SurgeTransferRuntime,
  input: SurgeTransferInput,
  mode: "keys" | "final",
): Promise<void> {
  const { gatewayId, slug, operationId, sourcePod, targetPod, loadStrategy, configTransferMode } = input;
  const transferKey = runtime.randomKey();
  let prepared = false;
  try {
    const prepare = await runtime.control(targetPod, gatewayId, "prepare-rsync-import", operationId, {
      migrationId: operationId,
      slug,
      rpcPhase: "prepare-rsync-import",
      mode,
      transferUser: "migration",
      transferKey,
      sourcePodIp: sourcePod.podIP,
      ...(mode === "final" ? { configTransferMode } : {}),
    }) as unknown as PrepareRsyncImportResponse;
    if (!Number.isInteger(prepare.port) || prepare.port <= 0) {
      throw new Error(`target pod ${targetPod.name} returned invalid rsync port`);
    }
    prepared = true;
    await runtime.control(sourcePod, gatewayId, "push-rsync-state", operationId, {
      migrationId: operationId,
      slug,
      rpcPhase: "push-rsync-state",
      mode,
      targetHost: targetPod.podIP,
      targetPort: prepare.port,
      transferUser: "migration",
      transferKey,
      ...(mode === "final"
        ? {
          configTransferMode,
          ...(configTransferMode === "activation-manifest" ? { includeActivationManifest: true } : {}),
        }
        : {}),
    });
    await runtime.control(targetPod, gatewayId, "finish-rsync-import", operationId, {
      migrationId: operationId,
      slug,
      rpcPhase: "finish-rsync-import",
      mode,
      ...(mode === "final" ? { loadStrategy, configTransferMode } : {}),
    });
  } catch (error) {
    if (prepared) await abortTargetImport(runtime, input, mode);
    throw error;
  }
}

async function transferCustomerState(
  runtime: SurgeTransferRuntime,
  input: SurgeTransferInput,
): Promise<void> {
  const { gatewayId, slug, operationId, targetPod, configTransferMode, expectedSystemConfigCommit } = input;
  if (configTransferMode === "configured-builder-system-config" && !expectedSystemConfigCommit) {
    throw new Error(`configured Builder transfer is missing system config commit for ${slug}`);
  }
  await transferMode(runtime, input, "keys");
  if (configTransferMode === "configured-builder-system-config") {
    try {
      await runtime.control(targetPod, gatewayId, "flush", operationId, {
        migrationId: operationId,
        slug,
        reason: "migration-converge",
        expectedSystemConfigCommit: expectedSystemConfigCommit!,
      });
    } catch (error) {
      if (
        !runtime.allowLegacyConfiguredBuilderConvergence ||
        !isLegacyConfiguredBuilderConvergenceResponse(error, input)
      ) {
        await abortTargetImport(runtime, input, "final");
        throw error;
      }
      runtime.log(
        `[surge-handoff] target config converged before import; continuing to materialize missing workspace ` +
        `pod=${targetPod.name} slug=${slug} gateway=${gatewayId} commit=${expectedSystemConfigCommit}`,
      );
    }
  }
  await transferMode(runtime, input, "final");
}

export function createSurgePodTransport(opts: SurgePodTransportOptions): SurgePodTransport {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const randomKey = opts.randomKey ?? (() => randomBytes(32).toString("hex"));
  const legacySignaturePods = new Map<string, { version: string; message: string }>();
  const rejectedSignaturePods = new Map<string, string>();

  const legacySignatureMessage = (pod: SurgePod, version: string): string =>
    `pod=${pod.name} version=${version} predates the gateway-scoped fleet signature protocol; ` +
    "roll the pod before starting a surge handoff";
  const rejectedSignatureMessage = (pod: SurgePod, status: number): string =>
    `pod=${pod.name} rejected the gateway-scoped fleet signature with HTTP ${status}; ` +
    "the pod's fleet key does not match Cowboy's signing key; repair the key or roll the pod " +
    "before starting a surge handoff";
  const reportLegacySignaturePod = (pod: SurgePod, version: string): string => {
    const message = legacySignatureMessage(pod, version);
    const previous = legacySignaturePods.get(pod.uid);
    legacySignaturePods.set(pod.uid, { version, message });
    if (!previous || previous.version !== version) opts.log(`[surge-handoff] ${message}`);
    return message;
  };
  const reportRejectedSignaturePod = (pod: SurgePod, status: number): string => {
    const message = rejectedSignatureMessage(pod, status);
    if (!rejectedSignaturePods.has(pod.uid)) opts.log(`[surge-handoff] ${message}`);
    rejectedSignaturePods.set(pod.uid, message);
    return message;
  };
  const assertGatewayScopedSignatureCapability = (pod: SurgePod): void => {
    const legacy = legacySignaturePods.get(pod.uid);
    const rejected = rejectedSignaturePods.get(pod.uid);
    if (legacy) throw new SurgeGatewayScopedSignatureCapabilityMissingError(legacy.message);
    if (rejected) throw new SurgeGatewayScopedSignatureCapabilityMissingError(rejected);
  };

  const control = async (
    pod: SurgePod,
    gatewayId: string,
    path: string,
    operationId: string,
    body: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<Record<string, unknown>> => {
    assertGatewayScopedSignatureCapability(pod);
    try {
      return await postSigned({
        fetch: fetchImpl,
        privateKey: opts.privateKey,
        pod,
        gatewayId,
        path,
        operationId,
        body,
        timeoutMs,
      });
    } catch (error) {
      if (
        error instanceof SurgePodControlError &&
        (error.status === 401 || error.status === 403)
      ) {
        throw new SurgeGatewayScopedSignatureCapabilityMissingError(
          reportRejectedSignaturePod(pod, error.status),
        );
      }
      throw error;
    }
  };

  return {
    readPodHealth: (pod, gatewayId) => readSurgePodHealth({
      fetch: fetchImpl,
      privateKey: opts.privateKey,
      rejectedSignaturePods,
      reportLegacySignaturePod,
      reportRejectedSignaturePod,
      log: opts.log,
    }, pod, gatewayId),

    async quiesce({ gatewayId, slug, operationId, sourcePod }) {
      await control(sourcePod, gatewayId, "quiesce", operationId, {
        migrationId: operationId,
        slug,
        timeoutMs: MIGRATION_QUIESCE_TIMEOUT_MS,
      });
    },

    async stopSourceOpenClaw({ gatewayId, slug, operationId, sourcePod, targetPod }) {
      await controlSurgeOpenClawProcess(control, {
        pod: sourcePod,
        gatewayId,
        path: "hold-surge-openclaw",
        operationId,
        slug,
        targetPodUid: targetPod.uid,
        capability: "hold",
      });
    },

    async resumeSourceOpenClaw({ gatewayId, slug, operationId, sourcePod, targetPod }) {
      await controlSurgeOpenClawProcess(control, {
        pod: sourcePod,
        gatewayId,
        path: "resume-surge-openclaw",
        operationId,
        slug,
        targetPodUid: targetPod.uid,
        capability: "resume",
        timeoutMs: SURGE_OPENCLAW_RESUME_TIMEOUT_MS,
      });
    },

    async holdTargetOpenClaw({ gatewayId, slug, operationId, targetPod }) {
      await controlSurgeOpenClawProcess(control, {
        pod: targetPod,
        gatewayId,
        path: "hold-surge-openclaw",
        operationId,
        slug,
        targetPodUid: targetPod.uid,
        capability: "reserve",
      });
    },

    async unreserveTargetOpenClaw({ gatewayId, slug, operationId, targetPod }) {
      await controlSurgeOpenClawProcess(control, {
        pod: targetPod,
        gatewayId,
        path: "unreserve-surge-openclaw",
        operationId,
        slug,
        targetPodUid: targetPod.uid,
        capability: "unreserve",
      });
    },

    async flush({
      gatewayId,
      slug,
      operationId,
      pod,
      reason,
      expectedSystemConfigCommit,
    }) {
      const response = await control(pod, gatewayId, "flush", operationId, {
        migrationId: operationId,
        slug,
        reason,
        ...(expectedSystemConfigCommit ? { expectedSystemConfigCommit } : {}),
      }) as unknown as FlushGatewayResponse;
      return {
        ...(typeof response.systemConfigCommit === "string"
          ? { systemConfigCommit: response.systemConfigCommit }
          : {}),
      };
    },

    transfer: (input) => transferCustomerState({
      control,
      randomKey,
      log: opts.log,
      allowLegacyConfiguredBuilderConvergence: opts.allowLegacyConfiguredBuilderConvergence === true,
    }, input),
    async discardTargetCustomer({ gatewayId, slug, operationId, targetPod }) {
      const unmount = () => control(
        targetPod,
        gatewayId,
        "unmount",
        operationId,
        {
          migrationId: operationId,
          slug,
        },
      );
      try {
        await unmount();
      } catch (error) {
        if (!(error instanceof SurgePodControlError) || error.code !== "hash-mismatch") {
          throw error;
        }
        opts.log(
          `[surge-handoff] target cleanup lost config CAS pod=${targetPod.name} slug=${slug}; retrying signed unmount once`,
        );
        await unmount();
      }
    },

    async releaseTarget({ gatewayId, operationId, pod }) {
      await control(pod, gatewayId, "complete-surge-handoff", operationId, {
        migrationId: operationId,
        targetPodUid: pod.uid,
      });
    },
  };
}
