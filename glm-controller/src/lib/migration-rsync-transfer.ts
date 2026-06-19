import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  FieldValue,
  type DocumentReference,
  type Firestore,
} from "firebase-admin/firestore";
import { GLM_MIGRATION_TRANSFER_TASKS_COLLECTION } from "../../../shared/types/glm.js";
import {
  type ActivationManifestExportResponse,
  type ExportPathsResponse,
  type ImportResponse,
  MIGRATION_TRANSFER_TIMEOUT_MS,
  SIGNATURE_HEADER,
} from "../../../shared/types/fleet-controller.js";
import type { MigrationSyncMode } from "../../../scripts/lib/fleet-migration.js";
import type { MigrationClient } from "../../../scripts/lib/fleet-migration-client.js";
import { signFleetRequest } from "../../../scripts/lib/fleet-signature.js";
import {
  MIGRATION_ACTIVATION_DIR,
  MIGRATION_ACTIVATION_FILE,
} from "../../../scripts/lib/migration-activation-manifest.js";

const GATEWAY_CONTAINER = "gateway";
const TARGET_OPENCLAW_DIR = "/home/node/.openclaw";
const DEFAULT_LEASE_MS = MIGRATION_TRANSFER_TIMEOUT_MS + 60_000;
const DEFAULT_WORKER_ID = `glm-${process.pid}`;

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
  resolveGatewayUrl: (gatewayId: string) => string;
  runCommand?: CommandRunner;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  workerId?: string;
  leaseMs?: number;
  log?: (msg: string) => void;
}

export function createSubprocessCommandRunner(): CommandRunner {
  return (command, args, opts = {}) =>
    new Promise<CommandResult>((resolve, reject) => {
      const proc = spawn(command, args, {
        env: opts.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const timeout = opts.timeoutMs
        ? setTimeout(() => {
            if (settled) return;
            proc.kill("SIGTERM");
            stderr += `\n${command} timed out after ${opts.timeoutMs}ms`;
          }, opts.timeoutMs)
        : null;

      proc.stdout?.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      proc.stderr?.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      proc.on("error", (err) => {
        settled = true;
        if (timeout) clearTimeout(timeout);
        reject(err);
      });
      proc.on("close", (code, signal) => {
        settled = true;
        if (timeout) clearTimeout(timeout);
        if (signal !== null) {
          resolve({ stdout, stderr: `${stderr}\n${command} terminated by ${signal}`, code: 128 });
          return;
        }
        resolve({ stdout, stderr, code: code ?? 1 });
      });
    });
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
    gatewayId: string;
    path: string;
    migrationId: string;
    body: Record<string, unknown>;
  },
): Promise<Resp> {
  const rawBody = JSON.stringify(opts.body);
  const signature = signFleetRequest(deps.privateKey, opts.migrationId, rawBody);
  const url = `${deps.resolveGatewayUrl(opts.gatewayId)}${opts.path}`;
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
    const doc: MigrationTransferTaskDoc = {
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
      conditions?: Array<{ type?: string; status?: string }>;
    };
  }>;
}

async function resolveRunningGatewayPod(params: {
  namespace: string;
  gatewayId: string;
  runCommand: CommandRunner;
}): Promise<string> {
  const selector = `app=octogee-gateway,gateway-instance=${params.gatewayId}`;
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
      `kubectl get pods gateway=${params.gatewayId} failed: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  const parsed = JSON.parse(result.stdout) as PodList;
  const running = (parsed.items ?? []).filter((item) => {
    if (!item.metadata?.name || item.metadata.deletionTimestamp) return false;
    if (item.status?.phase !== "Running") return false;
    return (item.status.conditions ?? []).some(
      (c) => c.type === "Ready" && c.status === "True",
    );
  });
  if (running.length !== 1) {
    throw new Error(
      `expected exactly one running pod for gateway=${params.gatewayId}; found ${running.length}`,
    );
  }
  return running[0].metadata!.name!;
}

function trimTrailingSlash(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
}

function posixRel(value: string): string {
  let start = 0;
  while (start < value.length && value.charCodeAt(start) === 47) start += 1;
  return value.slice(start).split("\\").join("/");
}

function remoteSourceArg(pod: string, source: { cwd: string; path: string }): string {
  return `${pod}:${trimTrailingSlash(source.cwd)}/./${posixRel(source.path)}`;
}

function localSourceArg(stageDir: string, relPath: string): string {
  return `${trimTrailingSlash(stageDir)}/./${posixRel(relPath)}`;
}

async function writeKrsyncScript(dir: string): Promise<string> {
  const scriptPath = path.join(dir, "krsync.sh");
  await fs.writeFile(
    scriptPath,
    [
      "#!/bin/sh",
      "set -eu",
      "pod=\"$1\"",
      "shift",
      "kubectl_bin=\"${KUBECTL_BIN:-kubectl}\"",
      "exec \"$kubectl_bin\" -n \"${KRSYNC_NAMESPACE:?}\" exec -i \"$pod\" -c \"${KRSYNC_CONTAINER:-gateway}\" -- \"$@\"",
      "",
    ].join("\n"),
    "utf-8",
  );
  await fs.chmod(scriptPath, 0o700);
  return scriptPath;
}

async function runChecked(
  runCommand: CommandRunner,
  command: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number; label: string },
): Promise<void> {
  const result = await runCommand(command, args, opts);
  if (result.code !== 0) {
    throw new Error(
      `${opts.label} failed (code=${result.code}): ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
}

async function rsyncGatewayState(params: {
  namespace: string;
  runCommand: CommandRunner;
  timeoutMs: number;
  sourcePod: string;
  targetPod: string;
  sources: Array<{ cwd: string; path: string }>;
  activationManifest?: Record<string, unknown> | null;
}): Promise<void> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-rsync-transfer-"));
  try {
    const stageDir = path.join(tmpDir, "stage");
    await fs.mkdir(stageDir, { recursive: true });
    const krsync = await writeKrsyncScript(tmpDir);
    const env = {
      ...process.env,
      KRSYNC_NAMESPACE: params.namespace,
      KRSYNC_CONTAINER: GATEWAY_CONTAINER,
    };

    await runChecked(
      params.runCommand,
      "rsync",
      [
        "-a",
        "--relative",
        "--ignore-missing-args",
        "-e",
        krsync,
        ...params.sources.map((source) => remoteSourceArg(params.sourcePod, source)),
        `${stageDir}/`,
      ],
      { env, timeoutMs: params.timeoutMs, label: "rsync pull" },
    );

    const localRelPaths = params.sources.map((source) => posixRel(source.path));
    if (params.activationManifest) {
      const rel = path.posix.join(
        MIGRATION_ACTIVATION_DIR,
        String(params.activationManifest.slug ?? ""),
        MIGRATION_ACTIVATION_FILE,
      );
      if (!params.activationManifest.slug) {
        throw new Error("activation manifest missing slug");
      }
      const full = path.join(stageDir, rel);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, `${JSON.stringify(params.activationManifest)}\n`, "utf-8");
      localRelPaths.push(rel);
    }

    await runChecked(
      params.runCommand,
      "rsync",
      [
        "-a",
        "--delete",
        "--relative",
        "--ignore-missing-args",
        "-e",
        krsync,
        ...localRelPaths.map((rel) => localSourceArg(stageDir, rel)),
        `${params.targetPod}:${TARGET_OPENCLAW_DIR}/`,
      ],
      { env, timeoutMs: params.timeoutMs, label: "rsync push" },
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
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

  const control = <Resp>(
    gatewayId: string,
    pathSuffix: string,
    migrationId: string,
    body: Record<string, unknown>,
  ) =>
    postSignedJson<Resp>(
      {
        fetchImpl,
        privateKey: deps.privateKey,
        resolveGatewayUrl: deps.resolveGatewayUrl,
      },
      {
        gatewayId,
        path: `${pathSuffix}/${gatewayId}`,
        migrationId,
        body,
      },
    );

  return async (input) => {
    const mode = input.mode ?? "pre";
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

    try {
      await control<ImportResponse>(
        input.toGatewayId,
        "/prepare-import",
        input.migrationId,
        { migrationId: input.migrationId, slug: input.slug, mode },
      );
      const sourcePaths = await control<ExportPathsResponse>(
        input.fromGatewayId,
        "/export-paths",
        input.migrationId,
        { migrationId: input.migrationId, slug: input.slug, mode },
      );
      const activation = input.includeActivationManifest && mode !== "keys"
        ? await control<ActivationManifestExportResponse>(
            input.fromGatewayId,
            "/export-activation-manifest",
            input.migrationId,
            { migrationId: input.migrationId, slug: input.slug },
          )
        : null;

      const [sourcePod, targetPod] = await Promise.all([
        resolveRunningGatewayPod({
          namespace: deps.namespace,
          gatewayId: input.fromGatewayId,
          runCommand,
        }),
        resolveRunningGatewayPod({
          namespace: deps.namespace,
          gatewayId: input.toGatewayId,
          runCommand,
        }),
      ]);
      log(
        `[migration-rsync] task=${claimed.taskId} attempt=${claimed.attempt} mode=${mode} ${input.fromGatewayId}/${sourcePod} → ${input.toGatewayId}/${targetPod} paths=${sourcePaths.sources.length}`,
      );
      await rsyncGatewayState({
        namespace: deps.namespace,
        runCommand,
        timeoutMs: leaseMs,
        sourcePod,
        targetPod,
        sources: sourcePaths.sources,
        activationManifest: activation?.manifest ?? null,
      });

      if (mode !== "keys") {
        await control<ImportResponse>(
          input.toGatewayId,
          "/activate-import",
          input.migrationId,
          { migrationId: input.migrationId, slug: input.slug },
        );
      }
      await markTaskSucceeded(claimed.ref, now);
      log(
        `[migration-rsync] ✅ task=${claimed.taskId} mode=${mode} migrationId=${input.migrationId} slug=${input.slug}`,
      );
      return { migrationId: input.migrationId, slug: input.slug, imported: true };
    } catch (err) {
      await markTaskFailed(claimed.ref, now, err).catch((markErr) => {
        log(
          `[migration-rsync] ⚠ failed to mark task=${claimed.taskId} failed: ${markErr instanceof Error ? markErr.message : String(markErr)}`,
        );
      });
      throw err;
    }
  };
}
