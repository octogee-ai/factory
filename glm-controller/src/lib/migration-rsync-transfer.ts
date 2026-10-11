import { Agent } from "undici";
import { spawn } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { createHash, randomBytes } from "node:crypto";
import type { GatewayVmAddress } from "./gateway-address.js";
import {
  FieldValue,
  type DocumentReference,
  type Firestore,
} from "firebase-admin/firestore";
import { GLM_MIGRATION_TRANSFER_TASKS_COLLECTION, isDisposableHomeCheckpoint } from "@octogee/shared/types/glm";
import {
  type FinishRsyncImportRequestBody,
  type ImportResponse,
  type NativeAgentContextTransfer,
  type NativeSharedAgentContextStage,
  type NativeSharedAgentContextRecovery,
  MIGRATION_TRANSFER_TIMEOUT_MS,
  MIGRATION_IMPORT_FINISH_TIMEOUT_MS,
  MIGRATION_TRANSFER_LEASE_MS,
  type PrepareRsyncImportRequestBody,
  type PrepareRsyncImportResponse,
  type PushRsyncStateRequestBody,
  SIGNATURE_HEADER,
} from "@octogee/shared/types/fleet-controller";
import type { MigrationSyncMode } from "@octogee/core/fleet-migration";
import type { MigrationClient } from "@octogee/core/fleet-migration-client";
import { gatewayScopedJobId, signFleetRequest } from "@octogee/core/fleet-signature";

const DEFAULT_LEASE_MS = MIGRATION_TRANSFER_LEASE_MS;
const controlDispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
const DEFAULT_WORKER_ID = `glm-${process.pid}`;
const MIGRATION_TRANSFER_USER = "migration";

export type MigrationTransferTaskStatus =
  | "running"
  | "succeeded"
  | "failed";

export interface MigrationTransferTaskDoc {
  kind: "gateway-rsync-transfer";
  migrationId: string;
  slug: string;
  mode: MigrationSyncMode;
  sourceGatewayId: string;
  targetGatewayId: string;
  status: MigrationTransferTaskStatus;
  attempt: number;
  leaseOwner?: string;
  leaseExpiresAt?: number;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  error?: string;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type CommandRunner = (
  command: string,
  args: string[],
  opts?: { env?: NodeJS.ProcessEnv; timeoutMs?: number },
) => Promise<CommandResult>;

import type { RetainedSourceTransfer } from './retained-source-transfer.js';

export interface RSyncMigrationTransferDeps {
  retainedSource?: RetainedSourceTransfer;
  db: Firestore;
  namespace: string;
  privateKey: string;
  fleetControllerPort: string;
  resolveGatewayUrl: (gatewayId: string) => string;
  resolveGatewayVm?: (transportId: string) => Promise<GatewayVmAddress | null>;
  wait?: (ms: number) => Promise<void>;
  runCommand?: CommandRunner;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  workerId?: string;
  leaseMs?: number;
  log?: (msg: string) => void;
}

// Extracted to module scope so the per-event `() => resolve(...)` arrows sit
// at a shallow nesting depth (the inline Promise executor put them 5 levels
// deep). Behaviour is identical — settle() still de-dupes the first outcome.
function runSubprocess(
  command: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number },
  resolve: (result: CommandResult) => void,
  reject: (err: Error) => void,
): void {
  const proc = spawn(command, args, {
    env: opts.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let settled = false;
  let timeout: NodeJS.Timeout | null = null;
  const settle = (action: () => void): void => {
    if (settled) return;
    settled = true;
    if (timeout) clearTimeout(timeout);
    action();
  };
  if (opts.timeoutMs) {
    timeout = setTimeout(() => {
      stderr += `\n${command} timed out after ${opts.timeoutMs}ms`;
      proc.kill("SIGTERM");
      settle(() => resolve({ stdout, stderr, code: 124 }));
    }, opts.timeoutMs);
  }

  proc.stdout?.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  proc.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  proc.on("error", (err) => {
    settle(() => reject(err));
  });
  proc.on("close", (code, signal) => {
    if (signal != null) {
      settle(() =>
        resolve({ stdout, stderr: `${stderr}\n${command} terminated by ${signal}`, code: 128 }),
      );
      return;
    }
    settle(() => resolve({ stdout, stderr, code: code ?? 1 }));
  });
}

export function createSubprocessCommandRunner(): CommandRunner {
  return (command, args, opts = {}) =>
    new Promise<CommandResult>((resolve, reject) => runSubprocess(command, args, opts, resolve, reject));
}

export function migrationTransferTaskId(input: {
  migrationId: string;
  mode?: MigrationSyncMode;
}): string {
  const mode = input.mode ?? "pre";
  return `${sanitizeDocId(input.migrationId)}__${mode}`;
}

function sanitizeDocId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

const VM_READY_TIMEOUT_MS = 60_000;
const VM_READY_POLL_MS = 2_000;

async function waitForTargetVmReady(
  fetchImpl: typeof globalThis.fetch,
  wait: (ms: number) => Promise<void>,
  now: () => number,
  target: { name: string; baseUrl: string },
): Promise<void> {
  const deadline = now() + VM_READY_TIMEOUT_MS;
  let lastStatus = "unreachable";
  while (now() < deadline) {
    try {
      const res = await fetchImpl(`${target.baseUrl}/surge-ready`);
      if (res.ok) return;
      lastStatus = `HTTP ${res.status}`;
    } catch (err) {
      lastStatus = err instanceof Error ? err.message : String(err);
    }
    await wait(VM_READY_POLL_MS);
  }
  throw new Error(`migration target ${target.name} did not become Ready: ${lastStatus}`);
}

async function waitForTargetPodReady(
  runCommand: CommandRunner,
  namespace: string,
  podName: string,
): Promise<void> {
  const result = await runCommand("kubectl", [
    "-n", namespace, "wait", "--for=condition=Ready", `pod/${podName}`, "--timeout=60s",
  ], { timeoutMs: 65_000 });
  if (result.code !== 0) {
    throw new Error(`migration target ${podName} did not become Ready: ${result.stderr || result.stdout}`);
  }
}

async function postSignedJson<Resp>(
  deps: {
    fetchImpl: typeof globalThis.fetch;
    privateKey: string;
    resolveGatewayUrl: (gatewayId: string) => string;
  },
  opts: {
    transportId: string;
    baseUrl?: string;
    path: string;
    gatewayId: string;
    migrationId: string;
    body: Record<string, unknown>;
  },
): Promise<Resp> {
  const rawBody = JSON.stringify(opts.body);
  const signature = signFleetRequest(deps.privateKey, gatewayScopedJobId(opts.migrationId, opts.gatewayId), rawBody);
  const url = `${opts.baseUrl ?? deps.resolveGatewayUrl(opts.transportId)}${opts.path}`;
  const timeoutMs = opts.path.startsWith("/finish-rsync-import/")
    ? MIGRATION_IMPORT_FINISH_TIMEOUT_MS : MIGRATION_TRANSFER_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`${opts.path} timed out after ${timeoutMs}ms`)), timeoutMs);
  const init: RequestInit & { dispatcher?: Agent } = {
    method: "POST", headers: { "content-type": "application/json", [SIGNATURE_HEADER]: signature },
    body: rawBody, signal: controller.signal,
    ...(deps.fetchImpl === globalThis.fetch ? { dispatcher: controlDispatcher } : {}),
  };
  try {
    const res = await deps.fetchImpl(url, init);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${opts.path}: ${res.status} ${text}`);
    }
    return await res.json() as Resp;
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function buildClaimedTaskDoc(
  input: Parameters<MigrationClient["transferState"]>[0],
  existing: Partial<MigrationTransferTaskDoc> | undefined,
  deps: { workerId: string; leaseMs: number },
  now: number,
  attempt: number,
): MigrationTransferTaskDoc {
  return {
    kind: "gateway-rsync-transfer",
    migrationId: input.migrationId,
    slug: input.slug,
    mode: input.mode ?? "pre",
    sourceGatewayId: input.fromGatewayId,
    targetGatewayId: input.toGatewayId,
    status: "running",
    attempt,
    leaseOwner: deps.workerId,
    leaseExpiresAt: now + deps.leaseMs,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    startedAt: existing?.startedAt ?? now,
  };
}

async function claimTask(
  deps: Required<Pick<RSyncMigrationTransferDeps, "db" | "now" | "workerId" | "leaseMs">>,
  input: Parameters<MigrationClient["transferState"]>[0],
): Promise<
  { kind: "claimed"; taskId: string; ref: DocumentReference; attempt: number }
> {
  const taskId = migrationTransferTaskId(input);
  const ref = deps.db
    .collection(GLM_MIGRATION_TRANSFER_TASKS_COLLECTION)
    .doc(taskId);
  const now = deps.now();

  return deps.db.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    const existing = snap.exists
      ? (snap.data() as Partial<MigrationTransferTaskDoc> | undefined)
      : undefined;

    if (
      existing?.status === "running" &&
      typeof existing.leaseExpiresAt === "number" &&
      existing.leaseExpiresAt > now
    ) {
      throw new Error(
        `transfer task ${taskId} is already running (leaseOwner=${existing.leaseOwner ?? "unknown"})`,
      );
    }

    const attempt = (existing?.attempt ?? 0) + 1;
    const doc = buildClaimedTaskDoc(input, existing, deps, now, attempt);
    txn.set(ref, doc, { merge: true });
    return { kind: "claimed", taskId, ref, attempt } as const;
  });
}

async function markTaskSucceeded(
  ref: DocumentReference,
  now: () => number,
): Promise<void> {
  await ref.set(
    {
      status: "succeeded",
      completedAt: now(),
      updatedAt: now(),
      leaseOwner: FieldValue.delete(),
      leaseExpiresAt: FieldValue.delete(),
      error: FieldValue.delete(),
    },
    { merge: true },
  );
}

async function markTaskFailed(
  ref: DocumentReference,
  now: () => number,
  err: unknown,
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  await ref.set(
    {
      status: "failed",
      error: message,
      updatedAt: now(),
      leaseOwner: FieldValue.delete(),
      leaseExpiresAt: FieldValue.delete(),
    },
    { merge: true },
  );
}

interface PodList {
  items?: Array<{
    metadata?: { name?: string; deletionTimestamp?: string };
    status?: {
      phase?: string;
      podIP?: string;
      conditions?: Array<{ type?: string; status?: string }>;
    };
  }>;
}

async function resolveRunningGatewayPod(params: {
  namespace: string;
  transportId: string;
  runCommand: CommandRunner;
  requireReady: boolean;
}): Promise<{ name: string; podIP: string }> {
  const selector = `app=octogee-gateway,gateway-instance=${params.transportId}`;
  const result = await params.runCommand("kubectl", [
    "-n",
    params.namespace,
    "get",
    "pods",
    "-l",
    selector,
    "-o",
    "json",
  ]);
  if (result.code !== 0) {
    throw new Error(
      `kubectl get pods transport=${params.transportId} failed: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  const parsed = JSON.parse(result.stdout) as PodList;
  const running = (parsed.items ?? []).filter((item) => {
    if (!item.metadata?.name || !item.status?.podIP || item.metadata.deletionTimestamp) return false;
    if (item.status?.phase !== "Running") return false;
    return true;
  });
  const ready = running.filter((item) => (item.status?.conditions ?? []).some(
    (condition) => condition.type === "Ready" && condition.status === "True",
  ));
  const selectionRequiresReady = params.requireReady || running.length > 1;
  const candidates = selectionRequiresReady ? ready : running;
  if (candidates.length !== 1) {
    const state = selectionRequiresReady ? "ready" : "running";
    throw Object.assign(
      new Error(
        `expected exactly one ${state} pod for transport=${params.transportId}; found ${candidates.length}`,
      ),
      { retryable: true },
    );
  }
  const item = candidates[0];
  return { name: item.metadata!.name!, podIP: item.status!.podIP! };
}

interface GatewayEndpoint {
  name: string;
  podIP: string;
  vm: boolean;
}

async function resolveGatewayEndpoint(params: {
  namespace: string;
  transportId: string;
  runCommand: CommandRunner;
  requireReady: boolean;
  resolveGatewayVm?: (transportId: string) => Promise<GatewayVmAddress | null>;
}): Promise<GatewayEndpoint> {
  const vm = params.resolveGatewayVm ? await params.resolveGatewayVm(params.transportId) : null;
  if (vm) return { name: vm.instanceName, podIP: vm.internalIp, vm: true };
  const pod = await resolveRunningGatewayPod(params);
  return { ...pod, vm: false };
}

function podBaseUrl(podIP: string, port: string): string {
  const host = podIP.includes(":") ? `[${podIP}]` : podIP;
  return `http://${host}:${port}`;
}

export async function resolveMigrationRecoveryUrl(params: {
  namespace: string;
  gatewayId: string;
  port: string;
  runCommand: CommandRunner;
  resolveGatewayVm: (gatewayId: string) => Promise<GatewayVmAddress | null>;
}): Promise<string> {
  const target = await resolveGatewayEndpoint({
    namespace: params.namespace,
    transportId: params.gatewayId,
    runCommand: params.runCommand,
    requireReady: false,
    resolveGatewayVm: params.resolveGatewayVm,
  });
  return podBaseUrl(target.podIP, params.port);
}

function requireTargetCertificate(prepared: PrepareRsyncImportResponse, target: string): string {
  if (typeof prepared.certificatePem !== "string" || prepared.certificatePem.length === 0) {
    throw new Error(`target ${target} did not return a migration TLS certificate`);
  }
  return prepared.certificatePem;
}

export async function abortRetainedSourceImport(
  deps: RSyncMigrationTransferDeps,
  input: {migrationId:string;slug:string;toGatewayId:string},
): Promise<void> {
  const retained=deps.retainedSource;
  if (!retained) throw new Error('retained source cleanup unavailable');
  const observed=await retained.observe();
  if (!observed || observed.targetCleanup==='complete' || (observed.status==='failed' && observed.targetCleanup===undefined)) return;
  if (observed.status!=='failed' && observed.status!=='transferred') throw new Error('source transfer observation pending');
  const target=await resolveGatewayEndpoint({namespace:deps.namespace,transportId:input.toGatewayId,runCommand:deps.runCommand ?? createSubprocessCommandRunner(),requireReady:false,resolveGatewayVm:deps.resolveGatewayVm});
  const record=await retained.settledTarget(target);
  if (!record) return;
  const response=await postSignedJson<ImportResponse>({fetchImpl:deps.fetch ?? globalThis.fetch,privateKey:deps.privateKey,resolveGatewayUrl:deps.resolveGatewayUrl},{transportId:input.toGatewayId,gatewayId:input.toGatewayId,migrationId:input.migrationId,path:`/abort-rsync-import/${input.toGatewayId}`,baseUrl:podBaseUrl(target.podIP,deps.fleetControllerPort),body:{migrationId:input.migrationId,slug:input.slug,mode:'final',rpcPhase:'abort-rsync-import'}});
  if (response.migrationId!==input.migrationId || response.slug!==input.slug || response.imported!==false) throw new Error('retained source cleanup acknowledgement mismatch');
  await retained.acknowledgeCleanup(record);
}

function agentContextField(policy?: NativeAgentContextTransfer): { agentContext?: NativeAgentContextTransfer } {
  return policy ? { agentContext: policy } : {};
}

function assertStagedTransferInput(input: Parameters<MigrationClient["transferState"]>[0]): void {
  if (input.stageOnly && (input.mode !== "final" || input.agentContext?.mode !== "restore-shared" || input.includeActivationManifest !== false)) {
    throw new Error("staged transfer requires archived Shared agent context without activation manifest");
  }
}

function stagedSharedAgentContext(
  input: Parameters<MigrationClient["transferState"]>[0],
  target: GatewayEndpoint,
  prepared: PrepareRsyncImportResponse,
  pushed: ImportResponse,
): ImportResponse {
  if (input.agentContext?.mode !== "restore-shared" || target.vm || pushed.imported !== true ||
      pushed.migrationId !== input.migrationId || pushed.slug !== input.slug) {
    throw new Error("Shared agent context stage did not confirm the matching source transfer");
  }
  return {
    migrationId: input.migrationId, slug: input.slug, imported: false,
    sharedAgentContextStage: {
      migrationId: input.migrationId, slug: input.slug, toGatewayId: input.toGatewayId,
      targetName: target.name, targetIp: target.podIP, targetVm: target.vm,
      targetCertificateSha256: createHash("sha256").update(requireTargetCertificate(prepared, target.name)).digest("hex"),
      archive: input.agentContext.archive,
    },
  };
}

type AgentContextRestoreInput = Parameters<MigrationClient["finishAgentContextRestore"]>[0];

function assertAgentContextRestoreStage(input: AgentContextRestoreInput): void {
  const { stage } = input;
  if (stage.migrationId !== input.migrationId || stage.slug !== input.slug || stage.toGatewayId !== input.toGatewayId ||
      !isDeepStrictEqual(stage.archive, input.agentContext.archive) || !/^[a-f0-9]{64}$/.test(stage.targetCertificateSha256)) {
    throw new Error("Shared agent context stage scope changed");
  }
  const checkpoint = input.sharedAgentContextRecovery?.checkpoint;
  if (input.sharedAgentContextRecovery && (!isDisposableHomeCheckpoint(checkpoint) || checkpoint.coverage !== "builder-home-v2" ||
      ![2, 3].includes(checkpoint.writerProtocol ?? 0) || checkpoint.instanceId !== stage.archive.custody.instanceId)) {
    throw new Error("Shared agent context checkpoint scope changed");
  }
}

function assertSharedRestoreEndpoint(target: GatewayEndpoint, stage: NativeSharedAgentContextStage,
  recovery: NativeSharedAgentContextRecovery | undefined): void {
  if (target.vm || stage.targetVm || (!recovery && (target.name !== stage.targetName || target.podIP !== stage.targetIp))) {
    throw new Error("Shared agent context stage target changed");
  }
}

export function createRsyncAgentContextRestoreFinish(deps: RSyncMigrationTransferDeps): MigrationClient["finishAgentContextRestore"] {
  const runCommand = deps.runCommand ?? createSubprocessCommandRunner();
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  return async input => {
    const { stage } = input;
    assertAgentContextRestoreStage(input);
    const recovery = input.sharedAgentContextRecovery;
    const target = await resolveGatewayEndpoint({ namespace: deps.namespace, transportId: input.toGatewayId,
      runCommand, requireReady: false, resolveGatewayVm: deps.resolveGatewayVm });
    assertSharedRestoreEndpoint(target, stage, recovery);
    const baseUrl = podBaseUrl(target.podIP, deps.fleetControllerPort);
    const finished = await postSignedJson<ImportResponse>({ fetchImpl, privateKey: deps.privateKey, resolveGatewayUrl: deps.resolveGatewayUrl }, {
      transportId: input.toGatewayId, gatewayId: input.toGatewayId, migrationId: input.migrationId,
      path: `/finish-rsync-import/${input.toGatewayId}`, baseUrl,
      body: { migrationId: input.migrationId, slug: input.slug, rpcPhase: "finish-rsync-import", mode: "final",
        agentContext: input.agentContext, targetCertificateSha256: stage.targetCertificateSha256,
        ...(recovery ? { sharedAgentContextRecovery: recovery } : {}) },
    });
    if (finished.imported !== true || finished.migrationId !== input.migrationId || finished.slug !== input.slug) {
      throw new Error("Shared agent context restore did not confirm the matching import");
    }
    await waitForTargetPodReady(runCommand, deps.namespace, target.name);
    return finished;
  };
}

export function createRsyncMigrationTransfer(
  deps: RSyncMigrationTransferDeps,
): MigrationClient["transferState"] {
  const runCommand = deps.runCommand ?? createSubprocessCommandRunner();
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? (() => Date.now());
  const workerId = deps.workerId ?? DEFAULT_WORKER_ID;
  const leaseMs = deps.leaseMs ?? DEFAULT_LEASE_MS;
  const log = deps.log ?? (() => undefined);
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const control = <Resp>(opts: {
    transportId: string;
    gatewayId: string;
    pathSuffix: string;
    migrationId: string;
    body: Record<string, unknown>;
    baseUrl?: string;
  }) =>
    postSignedJson<Resp>(
      {
        fetchImpl,
        privateKey: deps.privateKey,
        resolveGatewayUrl: deps.resolveGatewayUrl,
      },
      {
        transportId: opts.transportId,
        baseUrl: opts.baseUrl,
        path: `${opts.pathSuffix}/${opts.gatewayId}`,
        gatewayId: opts.gatewayId,
        migrationId: opts.migrationId,
        body: opts.body,
      },
    );

  async function transferRetained(input: Parameters<MigrationClient["transferState"]>[0]): Promise<ImportResponse> {
    const retainedSource = deps.retainedSource;
    if (!retainedSource) throw new Error("retained source transport unavailable");
    const mode = "final";
    const toTransportId = input.toTransportId ?? input.toGatewayId;
      const target = await resolveGatewayEndpoint({namespace:deps.namespace,transportId:toTransportId,runCommand,requireReady:false,resolveGatewayVm:deps.resolveGatewayVm});
      const record = await retainedSource.execute({target,prepare: async sourcePodIp => {
        const transferKey = randomBytes(32).toString("hex");
        const prepared = await control<PrepareRsyncImportResponse>({transportId:toTransportId,gatewayId:input.toGatewayId,pathSuffix:"/prepare-rsync-import",migrationId:input.migrationId,body:{migrationId:input.migrationId,slug:input.slug,rpcPhase:"prepare-rsync-import",mode,agentContext:input.agentContext,transferUser:MIGRATION_TRANSFER_USER,transferKey,sourcePodIp},baseUrl:podBaseUrl(target.podIP,deps.fleetControllerPort)});
        return {migrationId:input.migrationId,slug:input.slug,rpcPhase:"push-rsync-state",mode:"final",agentContext:input.agentContext,targetHost:target.podIP,targetPort:prepared.port,targetCertificatePem:requireTargetCertificate(prepared,target.name),transferUser:MIGRATION_TRANSFER_USER,transferKey,includeActivationManifest:input.includeActivationManifest};
      }});
      if (record.targetGatewayId !== input.toGatewayId || record.targetName !== target.name || record.targetIp !== target.podIP || record.targetVm !== target.vm) throw new Error("retained transfer target changed");
      const baseUrl = podBaseUrl(record.targetIp,deps.fleetControllerPort);
      await retainedSource.settledTarget(target);
      await retainedSource.assertActiveClaim();
      const finished = await control<ImportResponse>({transportId:toTransportId,gatewayId:input.toGatewayId,pathSuffix:"/finish-rsync-import",migrationId:input.migrationId,body:{migrationId:input.migrationId,slug:input.slug,rpcPhase:"finish-rsync-import",mode,agentContext:input.agentContext},baseUrl});
      if (target.vm) await waitForTargetVmReady(fetchImpl,wait,now,{name:target.name,baseUrl});
      else await waitForTargetPodReady(runCommand,deps.namespace,target.name);
      return finished;
  }

  return async (input) => {
    const mode = input.mode ?? "pre";
    assertStagedTransferInput(input);
    const fromTransportId = input.fromTransportId ?? input.fromGatewayId;
    const toTransportId = input.toTransportId ?? input.toGatewayId;
    if (deps.retainedSource && mode === "final") return transferRetained(input);
    const transferKey = randomBytes(32).toString("hex");
    const claimed = await claimTask(
      {
        db: deps.db,
        now,
        workerId,
        leaseMs,
      },
      { ...input, mode },
    );

    let targetPrepareAttempted = false;
    let targetPod: GatewayEndpoint | undefined;
    try {
      const [sourcePod, resolvedTargetPod] = await Promise.all([
        resolveGatewayEndpoint({
          namespace: deps.namespace,
          transportId: fromTransportId,
          runCommand,
          requireReady: true,
          resolveGatewayVm: deps.resolveGatewayVm,
        }),
        resolveGatewayEndpoint({
          namespace: deps.namespace,
          transportId: toTransportId,
          runCommand,
          requireReady: false,
          resolveGatewayVm: deps.resolveGatewayVm,
        }),
      ]);
      targetPod = resolvedTargetPod;
      const targetBaseUrl = podBaseUrl(targetPod.podIP, deps.fleetControllerPort);
      const prepareBody: PrepareRsyncImportRequestBody = {
        migrationId: input.migrationId,
        slug: input.slug,
        rpcPhase: "prepare-rsync-import",
        mode,
        ...agentContextField(input.agentContext),
        transferUser: MIGRATION_TRANSFER_USER,
        transferKey,
        sourcePodIp: sourcePod.podIP,
      };
      targetPrepareAttempted = true;
      const prepared = await control<PrepareRsyncImportResponse>({
        transportId: toTransportId,
        gatewayId: input.toGatewayId,
        pathSuffix: "/prepare-rsync-import",
        migrationId: input.migrationId,
        body: prepareBody as unknown as Record<string, unknown>,
        baseUrl: targetBaseUrl,
      });
      log(
        `[migration-rsync] task=${claimed.taskId} attempt=${claimed.attempt} mode=${mode} ${input.fromGatewayId}/${sourcePod.name} → ${input.toGatewayId}/${targetPod.name} target=${targetPod.podIP}:${prepared.port}`,
      );
      const pushBody: PushRsyncStateRequestBody = {
        migrationId: input.migrationId,
        slug: input.slug,
        rpcPhase: "push-rsync-state",
        mode,
        ...agentContextField(input.agentContext),
        targetHost: targetPod.podIP,
        targetPort: prepared.port,
        targetCertificatePem: requireTargetCertificate(prepared, targetPod.name),
        transferUser: MIGRATION_TRANSFER_USER,
        transferKey,
        includeActivationManifest: input.includeActivationManifest,
      };
      const pushed = await control<ImportResponse>({
        transportId: fromTransportId,
        gatewayId: input.fromGatewayId,
        pathSuffix: "/push-rsync-state",
        migrationId: input.migrationId,
        body: pushBody as unknown as Record<string, unknown>,
      });
      if (input.stageOnly) {
        const staged = stagedSharedAgentContext(input, targetPod, prepared, pushed);
        await markTaskSucceeded(claimed.ref, now);
        log(`[migration-rsync] staged Shared agent context task=${claimed.taskId} migrationId=${input.migrationId} slug=${input.slug}`);
        return staged;
      }
      const finishBody: FinishRsyncImportRequestBody = {
        migrationId: input.migrationId,
        slug: input.slug,
        rpcPhase: "finish-rsync-import",
        mode,
        ...agentContextField(input.agentContext),
      };
      const finished = await control<ImportResponse>({
        transportId: toTransportId,
        gatewayId: input.toGatewayId,
        pathSuffix: "/finish-rsync-import",
        migrationId: input.migrationId,
        body: finishBody as unknown as Record<string, unknown>,
        baseUrl: targetBaseUrl,
      });
      if (mode === "final") {
        if (targetPod.vm) {
          await waitForTargetVmReady(fetchImpl, wait, now, { name: targetPod.name, baseUrl: targetBaseUrl });
        } else {
          await waitForTargetPodReady(runCommand, deps.namespace, targetPod.name);
        }
      }
      await markTaskSucceeded(claimed.ref, now);
      // The target committed the import and told us which post-commit step it could
      // not confirm. Aborting here would unmount work that landed and send the retry
      // back into the same reload, so the state stands and the reconcile converges it.
      if (finished.verificationPending) {
        log(
          `[migration-rsync] ⚠ task=${claimed.taskId} migrationId=${input.migrationId} ` +
          `slug=${input.slug} imported with verification pending: ${finished.verificationPending}`,
        );
      }
      log(
        `[migration-rsync] ✅ task=${claimed.taskId} mode=${mode} migrationId=${input.migrationId} slug=${input.slug}`,
      );
      return finished;
    } catch (err) {
      if (targetPrepareAttempted && targetPod) {
        await control<ImportResponse>({
          transportId: toTransportId,
          gatewayId: input.toGatewayId,
          pathSuffix: "/abort-rsync-import",
          migrationId: input.migrationId,
          body: {
            migrationId: input.migrationId,
            slug: input.slug,
            rpcPhase: "abort-rsync-import",
            mode,
          },
          baseUrl: podBaseUrl(targetPod.podIP, deps.fleetControllerPort),
        }).catch((abortErr) => {
          log(
            `[migration-rsync] ⚠ abort failed mode=${mode} migrationId=${input.migrationId} slug=${input.slug}: ${abortErr instanceof Error ? abortErr.message : String(abortErr)}`,
          );
        });
      }
      await markTaskFailed(claimed.ref, now, err).catch((markErr) => {
        log(
          `[migration-rsync] ⚠ failed to mark task=${claimed.taskId} failed: ${markErr instanceof Error ? markErr.message : String(markErr)}`,
        );
      });
      throw err;
    }
  };
}
