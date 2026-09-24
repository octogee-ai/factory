import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { GatewayVmAddress } from "./gateway-address.js";
import {
  FieldValue,
  type DocumentReference,
  type Firestore,
} from "firebase-admin/firestore";
import { GLM_MIGRATION_TRANSFER_TASKS_COLLECTION } from "@octogee/shared/types/glm";
import {
  type FinishRsyncImportRequestBody,
  type ImportResponse,
  MIGRATION_TRANSFER_TIMEOUT_MS,
  type PrepareRsyncImportRequestBody,
  type PrepareRsyncImportResponse,
  type PushRsyncStateRequestBody,
  SIGNATURE_HEADER,
} from "@octogee/shared/types/fleet-controller";
import type { MigrationSyncMode } from "@octogee/core/fleet-migration";
import type { MigrationClient } from "@octogee/core/fleet-migration-client";
import { gatewayScopedJobId, signFleetRequest } from "@octogee/core/fleet-signature";

const DEFAULT_LEASE_MS = MIGRATION_TRANSFER_TIMEOUT_MS + 60_000;
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

export interface RSyncMigrationTransferDeps {
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

function postSignedJson<Resp>(
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
  const signature = signFleetRequest(
    deps.privateKey,
    gatewayScopedJobId(opts.migrationId, opts.gatewayId),
    rawBody,
  );
  const url = `${opts.baseUrl ?? deps.resolveGatewayUrl(opts.transportId)}${opts.path}`;
  return deps.fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [SIGNATURE_HEADER]: signature,
    },
    body: rawBody,
  }).then(async (res) => {
    if (!res.ok) {
      const text = await res.text().catch(() => "<no body>");
      throw new Error(`${opts.path}: ${res.status} ${text}`);
    }
    return (await res.json()) as Resp;
  });
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

function requireTargetCertificate(prepared: PrepareRsyncImportResponse, target: string): string {
  if (typeof prepared.certificatePem !== "string" || prepared.certificatePem.length === 0) {
    throw new Error(`target ${target} did not return a migration TLS certificate`);
  }
  return prepared.certificatePem;
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

  return async (input) => {
    const mode = input.mode ?? "pre";
    const fromTransportId = input.fromTransportId ?? input.fromGatewayId;
    const toTransportId = input.toTransportId ?? input.toGatewayId;
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
        targetHost: targetPod.podIP,
        targetPort: prepared.port,
        targetCertificatePem: requireTargetCertificate(prepared, targetPod.name),
        transferUser: MIGRATION_TRANSFER_USER,
        transferKey,
        includeActivationManifest: input.includeActivationManifest,
      };
      await control<ImportResponse>({
        transportId: fromTransportId,
        gatewayId: input.fromGatewayId,
        pathSuffix: "/push-rsync-state",
        migrationId: input.migrationId,
        body: pushBody as unknown as Record<string, unknown>,
      });
      const finishBody: FinishRsyncImportRequestBody = {
        migrationId: input.migrationId,
        slug: input.slug,
        rpcPhase: "finish-rsync-import",
        mode,
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
      return { migrationId: input.migrationId, slug: input.slug, imported: true };
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
