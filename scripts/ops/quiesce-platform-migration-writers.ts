import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applicationDefault, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import {
  deploymentTargetSettings,
  type DeploymentEnvironmentSettings,
} from "@octogee/core/deployment-environment";
import {
  executePlatformMigrationWriterQuiescence,
  assertRequiredPlatformMigrationReceipts,
  parsePlatformMigrationWriterQuiescenceArgs,
  PLATFORM_MIGRATION_WRITER_READINESS_TIMEOUT_MILLISECONDS,
  waitForPlatformMigrationWriterQuiescence,
  waitForPlatformMigrationWriterReadiness,
  assertPlatformMigrationScheduledWritersQuiesced,
  assertPlatformMigrationScheduledWritersReady,
  platformMigrationScheduledAttemptDeadlineMilliseconds,
  waitForPlatformMigrationScheduledAttemptDrain,
  type KubernetesCronJob,
  type KubernetesCronJobJob,
  type KubernetesPodList,
  type KubernetesWorkload,
  type PlatformMigrationScheduledWriter,
  type PlatformMigrationWriterQuiescenceDependencies,
  type PlatformMigrationWriterReceipt,
} from "../lib/platform-migration-writer-quiescence.js";
import {
  MIGRATION_RECEIPT_BUCKET,
  MigrationReceiptCollisionError,
  assertMigrationReceiptBucket,
  immutableMigrationReceiptUri,
  readImmutableMigrationReceipt,
  writeImmutableMigrationReceipt,
  type CommandRunner,
} from "../lib/migration-receipts.js";

const RECEIPT_PREFIX = "platform-migration-writer-quiescence";
const CONTENT_RECEIPT_PREFIX = "platform-content-migration";
const FIREBASE_RECEIPT_PREFIX = "platform-firestore-auth-west-migration";
const ACTIVATION_RECEIPT_PREFIX = "platform-migration-activation";
const MAINTENANCE_DOCUMENT = "config/glmMaintenance";
const QUIESCE_TIMEOUT_MILLISECONDS = 120_000;
const QUIESCE_POLL_MILLISECONDS = 1_000;
const FROZEN_MAINTENANCE_MODE = "frozen";
const QUIESCENCE_MANAGER = "platform-migration-writer-quiescence";

type JsonRecord = Record<string, unknown>;

function run(command: string, args: readonly string[], input?: string): string {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  if (result.error) throw new Error(`${command} could not start: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`${command} failed (${result.status ?? "signal"}): ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return result.stdout.trim();
}

function record(value: unknown, label: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function parseRecord(value: string, label: string): JsonRecord {
  try {
    return record(JSON.parse(value), label);
  } catch (error) {
    if (error instanceof Error && error.message.endsWith("must be an object")) throw error;
    throw new Error(`${label} was not valid JSON`);
  }
}

function isMissingObject(error: unknown): boolean {
  return error instanceof Error && /matched no objects|not found|does not exist/i.test(error.message);
}

function assertExactMergedMain(repoRoot: string): string {
  if (run("git", ["-C", repoRoot, "status", "--porcelain"])) {
    throw new Error("writer quiescence apply requires a clean working tree");
  }
  run("git", ["-C", repoRoot, "fetch", "--quiet", "origin", "main"]);
  const head = run("git", ["-C", repoRoot, "rev-parse", "HEAD"]);
  const originMain = run("git", ["-C", repoRoot, "rev-parse", "refs/remotes/origin/main"]);
  if (head !== originMain) {
    throw new Error("writer quiescence apply requires exact merged origin/main");
  }
  return head;
}

function ensureKubeContext(settings: DeploymentEnvironmentSettings): void {
  run("gcloud", [
    "container",
    "clusters",
    "get-credentials",
    settings.clusterName,
    `--region=${settings.region}`,
    `--project=${settings.clusterProjectId}`,
  ]);
}

function kubectl(settings: DeploymentEnvironmentSettings, args: readonly string[]): string {
  return run("kubectl", [
    "--context", settings.kubeContext,
    "--namespace", settings.namespace,
    ...args,
  ]);
}

function workloads(settings: DeploymentEnvironmentSettings): KubernetesWorkload[] {
  ensureKubeContext(settings);
  const listing = parseRecord(kubectl(settings, ["get", "deployments,statefulsets", "-o", "json"]), "Kubernetes workloads");
  if (!Array.isArray(listing.items)) throw new Error("Kubernetes workloads returned no items array");
  return listing.items as KubernetesWorkload[];
}

function pods(settings: DeploymentEnvironmentSettings): KubernetesPodList {
  return JSON.parse(kubectl(settings, ["get", "pods", "-o", "json"])) as KubernetesPodList;
}

function cronJobs(settings: DeploymentEnvironmentSettings): KubernetesCronJob[] {
  const listing = parseRecord(kubectl(settings, ["get", "cronjobs", "-o", "json"]), "Kubernetes CronJobs");
  if (!Array.isArray(listing.items)) throw new Error("Kubernetes CronJobs returned no items array");
  return listing.items as KubernetesCronJob[];
}

function cronJobJobs(settings: DeploymentEnvironmentSettings): KubernetesCronJobJob[] {
  const listing = parseRecord(kubectl(settings, ["get", "jobs", "-o", "json"]), "Kubernetes Jobs");
  if (!Array.isArray(listing.items)) throw new Error("Kubernetes Jobs returned no items array");
  return listing.items as KubernetesCronJobJob[];
}

export function parsePlatformMigrationScheduledWritersListing(
  output: string,
): PlatformMigrationScheduledWriter[] {
  let listing: unknown;
  try {
    listing = JSON.parse(output);
  } catch {
    throw new Error("Cloud Scheduler jobs were not valid JSON");
  }
  if (!Array.isArray(listing)) throw new Error("Cloud Scheduler jobs returned no array");
  return listing.map((candidate, index) => {
    const job = record(candidate, `Cloud Scheduler job ${index}`);
    if (
      typeof job.name !== "string" ||
      job.name.length === 0 ||
      typeof job.state !== "string" ||
      typeof job.attemptDeadline !== "string"
    ) {
      throw new Error(`Cloud Scheduler job ${index} is malformed`);
    }
    const name = job.name.split("/").at(-1);
    if (!name) throw new Error(`Cloud Scheduler job ${index} has no terminal name`);
    const retryConfig = job.retryConfig === undefined || job.retryConfig === null
      ? undefined
      : record(job.retryConfig, `Cloud Scheduler job ${index} retryConfig`);
    return {
      name,
      state: job.state,
      attemptDeadline: job.attemptDeadline,
      retryConfig,
      targetType: job.httpTarget === undefined ? "UNSUPPORTED" : "HTTP",
    };
  });
}

function scheduledWriters(settings: DeploymentEnvironmentSettings): PlatformMigrationScheduledWriter[] {
  return parsePlatformMigrationScheduledWritersListing(run("gcloud", [
    "scheduler",
    "jobs",
    "list",
    `--project=${settings.firebaseProjectId}`,
    `--location=${settings.region}`,
    "--format=json(name,state,attemptDeadline,retryConfig,httpTarget)",
  ]));
}

function pauseScheduledWriter(settings: DeploymentEnvironmentSettings, writer: Pick<PlatformMigrationScheduledWriter, "name">): void {
  run("gcloud", [
    "scheduler",
    "jobs",
    "pause",
    writer.name,
    `--project=${settings.firebaseProjectId}`,
    `--location=${settings.region}`,
  ]);
}

function resumeScheduledWriter(settings: DeploymentEnvironmentSettings, writer: Pick<PlatformMigrationScheduledWriter, "name">): void {
  run("gcloud", [
    "scheduler",
    "jobs",
    "resume",
    writer.name,
    `--project=${settings.firebaseProjectId}`,
    `--location=${settings.region}`,
  ]);
}

function setCronJobSuspended(
  settings: DeploymentEnvironmentSettings,
  cronJob: { name: string },
  suspended: boolean,
): void {
  kubectl(settings, [
    "patch",
    "cronjob",
    cronJob.name,
    "--type=merge",
    `--patch=${JSON.stringify({ spec: { suspend: suspended } })}`,
  ]);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForScheduledWriters(
  settings: DeploymentEnvironmentSettings,
  receipt: PlatformMigrationWriterReceipt,
  ready: boolean,
): Promise<void> {
  const deadline = Date.now() + (ready ? PLATFORM_MIGRATION_WRITER_READINESS_TIMEOUT_MILLISECONDS : QUIESCE_TIMEOUT_MILLISECONDS);
  let lastFailure = "not checked";
  while (true) {
    try {
      if (ready) {
        assertPlatformMigrationScheduledWritersReady(
          settings,
          receipt,
          scheduledWriters(settings),
          cronJobs(settings),
        );
      } else {
        assertPlatformMigrationScheduledWritersQuiesced(
          settings,
          receipt,
          scheduledWriters(settings),
          cronJobs(settings),
          cronJobJobs(settings),
        );
      }
      return;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    if (Date.now() >= deadline) {
      const phase = ready ? "become ready" : "quiesce";
      throw new Error(`scheduled writers did not ${phase} within ${ready ? PLATFORM_MIGRATION_WRITER_READINESS_TIMEOUT_MILLISECONDS : QUIESCE_TIMEOUT_MILLISECONDS}ms: ${lastFailure}`);
    }
    await sleep(QUIESCE_POLL_MILLISECONDS);
  }
}

function firestore(settings: DeploymentEnvironmentSettings) {
  const appName = `platform-migration-writer-quiescence-${settings.targetId}`;
  const app = getApps().find((candidate) => candidate.name === appName) ?? initializeApp(
    { credential: applicationDefault(), projectId: settings.firebaseProjectId },
    appName,
  );
  return getFirestore(app);
}

export function platformMigrationWriterReceiptUri(
  receipt: Pick<PlatformMigrationWriterReceipt, "targetId" | "migrationId">,
): string {
  return immutableMigrationReceiptUri(
    `${RECEIPT_PREFIX}/${receipt.migrationId}/${receipt.targetId}.json`,
  );
}

export function readPlatformMigrationWriterReceipt(
  uri: string,
  runner: CommandRunner = run,
): PlatformMigrationWriterReceipt | null {
  try {
    return readImmutableMigrationReceipt(uri, {
      schemaVersion: 1,
      kind: "platform-migration-writer-quiescence-receipt",
    }, runner).receipt as unknown as PlatformMigrationWriterReceipt;
  } catch (error) {
    if (isMissingObject(error)) return null;
    throw error;
  }
}

export function writePlatformMigrationWriterReceipt(
  uri: string,
  receipt: PlatformMigrationWriterReceipt,
  runner: CommandRunner = run,
): void {
  const expectedUri = platformMigrationWriterReceiptUri(receipt);
  if (uri !== expectedUri) {
    throw new Error("writer quiescence receipt URI does not match its target and migration");
  }
  try {
    writeImmutableMigrationReceipt(
      `${RECEIPT_PREFIX}/${receipt.migrationId}/${receipt.targetId}.json`,
      { ...receipt },
      runner,
    );
  } catch (error) {
    if (error instanceof MigrationReceiptCollisionError) {
      throw new Error("writer quiescence receipt already exists and is immutable", {
        cause: error,
      });
    }
    throw error;
  }
}

function migrationEndpoints(receipt: PlatformMigrationWriterReceipt): {
  source: "test-central" | "prod-central";
  target: "test-west" | "prod-west";
} {
  const endpoints = [receipt.targetId, receipt.partnerTargetId] as const;
  const source = endpoints.find((target) => target.endsWith("-central"));
  const target = endpoints.find((target) => target.endsWith("-west"));
  if ((source !== "test-central" && source !== "prod-central") ||
    (target !== "test-west" && target !== "prod-west")) {
    throw new Error("writer quiescence receipt does not describe a central-to-west migration");
  }
  return { source, target };
}

export function assertRequiredMigrationReceipts(
  receipt: PlatformMigrationWriterReceipt,
  runner: CommandRunner = run,
): void {
  const { source, target } = migrationEndpoints(receipt);
  const contentUri = immutableMigrationReceiptUri(
    `${CONTENT_RECEIPT_PREFIX}/${source}-to-${target}/${receipt.migrationId}.json`,
  );
  const content = readImmutableMigrationReceipt(contentUri, {
    schemaVersion: 1,
    kind: "platform-content-migration-receipt",
    migrationId: receipt.migrationId,
    source,
    target,
    revision: receipt.revision,
    verified: true,
  }, runner).receipt;
  const pattern =
    `${MIGRATION_RECEIPT_BUCKET}/receipts/${FIREBASE_RECEIPT_PREFIX}/` +
    `${receipt.migrationId}-${source}-${target}-*-complete.json`;
  const candidates = runner("gcloud", ["storage", "ls", pattern])
    .split("\n")
    .filter(Boolean)
    .sort();
  if (candidates.length === 0) throw new Error("verified Firebase/Auth/Storage migration receipt is required before restore");
  const firebase = candidates.map((uri) =>
    readImmutableMigrationReceipt(uri, {
      schemaVersion: 1,
      kind: "platform-firestore-auth-west-migration-receipt",
      mode: "apply",
      migrationId: receipt.migrationId,
      sourceTargetId: source,
      targetTargetId: target,
      gitCommit: receipt.revision,
      verified: true,
    }, runner).receipt);
  assertRequiredPlatformMigrationReceipts(receipt, content, firebase);
}

export function assertMigrationActivation(receipt: PlatformMigrationWriterReceipt, runner: CommandRunner = run): void {
  const { source, target } = migrationEndpoints(receipt);
  const uri = immutableMigrationReceiptUri(`${ACTIVATION_RECEIPT_PREFIX}/${source}-to-${target}/${receipt.migrationId}.json`);
  const activation = readImmutableMigrationReceipt(uri, {
    schemaVersion: 1,
    kind: "platform-migration-activation-receipt",
    migrationId: receipt.migrationId,
    source,
    target,
    revision: receipt.revision,
    credentials: "migration-only-mattermost-and-target-gitea",
    secrets: "rematerialized-and-verified",
    verified: true,
  }, runner).receipt;
  const services = record(activation, "platform migration activation receipt").services;
  if (!Array.isArray(services) || services.length !== 2 || new Set(services.map((service) => record(service, "activation service").service)).size !== 2) {
    throw new Error("activation receipt does not prove both restored services");
  }
}

export async function assertPairedCentralQuiesced(receipt: PlatformMigrationWriterReceipt): Promise<void> {
  const { source } = migrationEndpoints(receipt);
  const centralReceipt = readPlatformMigrationWriterReceipt(
    platformMigrationWriterReceiptUri({
      targetId: source,
      migrationId: receipt.migrationId,
    }),
  );
  if (
    centralReceipt === null ||
    centralReceipt.schemaVersion !== 1 ||
    centralReceipt.kind !== "platform-migration-writer-quiescence-receipt" ||
    centralReceipt.targetId !== source ||
    centralReceipt.partnerTargetId !== receipt.targetId ||
    centralReceipt.migrationId !== receipt.migrationId ||
    centralReceipt.revision !== receipt.revision
  ) {
    throw new Error("paired CENTRAL writer quiescence receipt does not match the WEST restore receipt");
  }
  const settings = deploymentTargetSettings(source);
  const maintenance = await dependenciesForPairedMaintenance(settings);
  if (maintenance?.mode !== FROZEN_MAINTENANCE_MODE || maintenance.managedBy !== QUIESCENCE_MANAGER) {
    throw new Error("paired CENTRAL writer quiescence maintenance state is not frozen");
  }
  await waitForPlatformMigrationWriterQuiescence({
    receipt: centralReceipt,
    readWorkloads: async () => workloads(settings),
    readPods: async () => pods(settings),
    now: () => Date.now(),
    sleep,
    timeoutMilliseconds: 0,
    pollMilliseconds: QUIESCE_POLL_MILLISECONDS,
  });
  await waitForScheduledWriters(settings, centralReceipt, false);
}

export async function assertTargetWriterQuiesced(receipt: PlatformMigrationWriterReceipt): Promise<void> {
  const settings = deploymentTargetSettings(receipt.targetId);
  const maintenance = await dependenciesForPairedMaintenance(settings);
  if (maintenance?.mode !== FROZEN_MAINTENANCE_MODE || maintenance.managedBy !== QUIESCENCE_MANAGER) {
    throw new Error("target writer quiescence maintenance state is not frozen");
  }
  await waitForPlatformMigrationWriterQuiescence({
    receipt,
    readWorkloads: async () => workloads(settings),
    readPods: async () => pods(settings),
    now: () => Date.now(),
    sleep,
    timeoutMilliseconds: 0,
    pollMilliseconds: QUIESCE_POLL_MILLISECONDS,
  });
  await waitForScheduledWriters(settings, receipt, false);
}

async function dependenciesForPairedMaintenance(
  settings: DeploymentEnvironmentSettings,
): Promise<JsonRecord | null> {
  const snapshot = await firestore(settings).doc(MAINTENANCE_DOCUMENT).get();
  return snapshot.exists ? record(snapshot.data(), "paired CENTRAL GLM maintenance document") : null;
}

function dependencies(repoRoot: string): PlatformMigrationWriterQuiescenceDependencies {
  return {
    assertReceiptStorage: async () => assertMigrationReceiptBucket(run),
    assertExactMergedMain: async () => assertExactMergedMain(repoRoot),
    readWorkloads: async (settings) => workloads(settings),
    readMaintenance: async (settings) => {
      const snapshot = await firestore(settings).doc(MAINTENANCE_DOCUMENT).get();
      return snapshot.exists ? record(snapshot.data(), "GLM maintenance document") : null;
    },
    writeMaintenance: async (settings, maintenance) => {
      const reference = firestore(settings).doc(MAINTENANCE_DOCUMENT);
      if (maintenance === null) {
        await reference.delete();
      } else {
        await reference.set(maintenance);
      }
    },
    scaleWorkload: async (settings, workload, replicas) => {
      kubectl(settings, ["scale", `${workload.kind.toLowerCase()}/${workload.name}`, `--replicas=${replicas}`]);
    },
    readScheduledWriters: async (settings) => scheduledWriters(settings),
    pauseScheduledWriter: async (settings, writer) => pauseScheduledWriter(settings, writer),
    resumeScheduledWriter: async (settings, writer) => resumeScheduledWriter(settings, writer),
    readCronJobs: async (settings) => cronJobs(settings),
    readCronJobJobs: async (settings) => cronJobJobs(settings),
    setCronJobSuspended: async (settings, cronJob, suspended) => setCronJobSuspended(settings, cronJob, suspended),
    waitForWritersQuiesced: async (settings, receipt) => {
      await waitForPlatformMigrationWriterQuiescence({
        receipt,
        readWorkloads: async () => workloads(settings),
        readPods: async () => pods(settings),
        now: () => Date.now(),
        sleep,
        timeoutMilliseconds: QUIESCE_TIMEOUT_MILLISECONDS,
        pollMilliseconds: QUIESCE_POLL_MILLISECONDS,
      });
    },
    waitForWritersReady: async (settings, receipt) => {
      await waitForPlatformMigrationWriterReadiness({
        receipt,
        readWorkloads: async () => workloads(settings),
        readPods: async () => pods(settings),
        now: () => Date.now(),
        sleep,
        timeoutMilliseconds: PLATFORM_MIGRATION_WRITER_READINESS_TIMEOUT_MILLISECONDS,
        pollMilliseconds: QUIESCE_POLL_MILLISECONDS,
      });
    },
    waitForScheduledWritersQuiesced: async (settings, receipt) => waitForScheduledWriters(settings, receipt, false),
    waitForScheduledWriterAttemptsDrained: async (_settings, receipt) => {
      await waitForPlatformMigrationScheduledAttemptDrain({
        attemptDeadlineMilliseconds: platformMigrationScheduledAttemptDeadlineMilliseconds(receipt),
        now: () => Date.now(),
        sleep,
      });
    },
    waitForScheduledWritersReady: async (settings, receipt) => waitForScheduledWriters(settings, receipt, true),
    readReceipt: async (uri) => readPlatformMigrationWriterReceipt(uri),
    writeReceipt: async (uri, receipt) =>
      writePlatformMigrationWriterReceipt(uri, receipt),
    assertRequiredMigrationReceipts: async (receipt) => assertRequiredMigrationReceipts(receipt),
    assertMigrationActivation: async (receipt) => assertMigrationActivation(receipt),
    assertPairedCentralQuiesced: async (receipt) => assertPairedCentralQuiesced(receipt),
    settingsForTarget: (targetId) => deploymentTargetSettings(targetId),
    receiptUri: platformMigrationWriterReceiptUri,
  };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parsePlatformMigrationWriterQuiescenceArgs(argv);
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const result = await executePlatformMigrationWriterQuiescence(args, dependencies(repoRoot));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function isEntrypoint(moduleUrl: string, entrypoint: string | undefined): boolean {
  if (!entrypoint) return false;
  try {
    return fs.realpathSync(fileURLToPath(moduleUrl)) === fs.realpathSync(entrypoint);
  } catch {
    return fileURLToPath(moduleUrl) === entrypoint;
  }
}

if (isEntrypoint(import.meta.url, process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`[platform-migration-writer-quiescence] fatal: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
