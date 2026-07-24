import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
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
  type KubernetesPodList,
  type KubernetesWorkload,
  type PlatformMigrationWriterQuiescenceDependencies,
  type PlatformMigrationWriterReceipt,
} from "../lib/platform-migration-writer-quiescence.js";

const CONTROL_BUCKET = "gs://octogee-terraform-state";
const RECEIPT_PREFIX = "receipts/platform-migration-writer-quiescence";
const CONTENT_RECEIPT_PREFIX = "receipts/platform-content-migration";
const FIREBASE_RECEIPT_PREFIX = "receipts/platform-firestore-auth-west-migration";
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

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function firestore(settings: DeploymentEnvironmentSettings) {
  const appName = `platform-migration-writer-quiescence-${settings.targetId}`;
  const app = getApps().find((candidate) => candidate.name === appName) ?? initializeApp(
    { credential: applicationDefault(), projectId: settings.firebaseProjectId },
    appName,
  );
  return getFirestore(app);
}

function receiptUri(receipt: Pick<PlatformMigrationWriterReceipt, "targetId" | "migrationId">): string {
  return `${CONTROL_BUCKET}/${RECEIPT_PREFIX}/${receipt.migrationId}/${receipt.targetId}.json`;
}

function readReceipt(uri: string): PlatformMigrationWriterReceipt | null {
  try {
    return parseRecord(run("gcloud", ["storage", "cat", uri]), "writer quiescence receipt") as unknown as PlatformMigrationWriterReceipt;
  } catch (error) {
    if (isMissingObject(error)) return null;
    throw error;
  }
}

function writeReceipt(uri: string, receipt: PlatformMigrationWriterReceipt): void {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-writer-quiescence."));
  const file = path.join(directory, "receipt.json");
  try {
    fs.writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    try {
      run("gcloud", ["storage", "cp", "--if-generation-match=0", file, uri]);
    } catch (error) {
      if (error instanceof Error && /conditionNotMet|precondition|generation/i.test(error.message)) {
        throw new Error("writer quiescence receipt already exists and is immutable");
      }
      throw error;
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
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

function assertRequiredMigrationReceipts(receipt: PlatformMigrationWriterReceipt): void {
  const { source, target } = migrationEndpoints(receipt);
  const contentUri = `${CONTROL_BUCKET}/${CONTENT_RECEIPT_PREFIX}/${source}-to-${target}/${receipt.migrationId}.json`;
  const content = parseRecord(run("gcloud", ["storage", "cat", contentUri]), "platform content migration receipt");
  const pattern = `${CONTROL_BUCKET}/${FIREBASE_RECEIPT_PREFIX}/${receipt.migrationId}-${source}-${target}-*-complete.json`;
  const candidates = run("gcloud", ["storage", "ls", pattern]).split("\n").filter(Boolean).sort();
  if (candidates.length === 0) throw new Error("verified Firebase/Auth/Storage migration receipt is required before restore");
  const firebase = candidates.map((uri) =>
    parseRecord(run("gcloud", ["storage", "cat", uri]), "Firebase/Auth/Storage migration receipt"));
  assertRequiredPlatformMigrationReceipts(receipt, content, firebase);
}

async function assertPairedCentralQuiesced(receipt: PlatformMigrationWriterReceipt): Promise<void> {
  const { source } = migrationEndpoints(receipt);
  const centralReceipt = readReceipt(receiptUri({ targetId: source, migrationId: receipt.migrationId }));
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
}

async function dependenciesForPairedMaintenance(
  settings: DeploymentEnvironmentSettings,
): Promise<JsonRecord | null> {
  const snapshot = await firestore(settings).doc(MAINTENANCE_DOCUMENT).get();
  return snapshot.exists ? record(snapshot.data(), "paired CENTRAL GLM maintenance document") : null;
}

function dependencies(repoRoot: string): PlatformMigrationWriterQuiescenceDependencies {
  return {
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
    readReceipt: async (uri) => readReceipt(uri),
    writeReceipt: async (uri, receipt) => writeReceipt(uri, receipt),
    assertRequiredMigrationReceipts: async (receipt) => assertRequiredMigrationReceipts(receipt),
    assertPairedCentralQuiesced: async (receipt) => assertPairedCentralQuiesced(receipt),
    settingsForTarget: (targetId) => deploymentTargetSettings(targetId),
    receiptUri,
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
