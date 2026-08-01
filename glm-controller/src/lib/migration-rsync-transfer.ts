import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
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
import { signFleetRequest } from "@octogee/core/fleet-signature";

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
    migrationId: string;
    body: Record<string, unknown>;
  },
): Promise<Resp> {
  const rawBody = JSON.stringify(opts.body);
  const signature = signFleetRequest(deps.privateKey, opts.migrationId, rawBody);
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
  | { kind: "already-succeeded"; taskId: string }
  | { kind: "claimed"; taskId: string; ref: DocumentReference; attempt: number }
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

    if (existing?.status === "succeeded") {
      return { kind: "already-succeeded", taskId } as const;
    }
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

function podBaseUrl(podIP: string, port: string): string {
  const host = podIP.includes(":") ? `[${podIP}]` : podIP;
  return `http://${host}:${port}`;
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
    if (claimed.kind === "already-succeeded") {
      log(
        `[migration-rsync] task=${claimed.taskId} already succeeded mode=${mode} migrationId=${input.migrationId} slug=${input.slug}`,
      );
      return { migrationId: input.migrationId, slug: input.slug, imported: true };
    }

    let targetPrepareAttempted = false;
    let targetPod: { name: string; podIP: string } | undefined;
    try {
      const [sourcePod, resolvedTargetPod] = await Promise.all([
        resolveRunningGatewayPod({
          namespace: deps.namespace,
          transportId: fromTransportId,
          runCommand,
          requireReady: true,
        }),
        resolveRunningGatewayPod({
          namespace: deps.namespace,
          transportId: toTransportId,
          runCommand,
          requireReady: false,
        }),
      ]);
      targetPod = resolvedTargetPod;
      const targetBaseUrl = podBaseUrl(targetPod.podIP, deps.fleetControllerPort);
      const prepareBody: PrepareRsyncImportRequestBody = {
        migrationId: input.migrationId,
        slug: input.slug,
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
        mode,
        targetHost: targetPod.podIP,
        targetPort: prepared.port,
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
        mode,
      };
      await control<ImportResponse>({
        transportId: toTransportId,
        gatewayId: input.toGatewayId,
        pathSuffix: "/finish-rsync-import",
        migrationId: input.migrationId,
        body: finishBody as unknown as Record<string, unknown>,
        baseUrl: targetBaseUrl,
      });
      await markTaskSucceeded(claimed.ref, now);
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
          body: { migrationId: input.migrationId, slug: input.slug, mode },
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
