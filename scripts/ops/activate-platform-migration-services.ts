import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deploymentTargetSettings, type DeploymentEnvironmentSettings } from "@octogee/core/deployment-environment";
import {
  executePlatformMigrationActivation,
  parsePlatformMigrationActivationArgs,
  type PlatformMigrationActivationReceipt,
  type PlatformMigrationActivationService,
} from "../lib/platform-migration-activation.js";
import {
  assertMigrationReceiptBucket,
  immutableMigrationReceiptUri,
  readImmutableMigrationReceipt,
  writeImmutableMigrationReceipt,
} from "../lib/migration-receipts.js";
import {
  assertPairedCentralQuiesced,
  assertRequiredMigrationReceipts,
  assertTargetWriterQuiesced,
  platformMigrationWriterReceiptUri,
  readPlatformMigrationWriterReceipt,
} from "./quiesce-platform-migration-writers.js";

function run(command: string, args: readonly string[], input?: string): string {
  const result = spawnSync(command, args, { encoding: "utf8", input, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? "signal"}): ${result.stderr.trim() || result.stdout.trim()}`);
  return result.stdout.trim();
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactMergedMain(repoRoot: string): string {
  if (run("git", ["-C", repoRoot, "status", "--porcelain"])) throw new Error("platform migration activation apply requires a clean working tree");
  run("git", ["-C", repoRoot, "fetch", "--quiet", "origin", "main"]);
  const revision = run("git", ["-C", repoRoot, "rev-parse", "HEAD"]);
  if (revision !== run("git", ["-C", repoRoot, "rev-parse", "refs/remotes/origin/main"])) throw new Error("platform migration activation apply requires exact merged origin/main");
  return revision;
}

function kube(settings: DeploymentEnvironmentSettings, args: readonly string[]): string {
  return run("kubectl", ["--context", settings.kubeContext, "--namespace", settings.namespace, ...args]);
}

function ensureContext(settings: DeploymentEnvironmentSettings): void {
  run("gcloud", ["container", "clusters", "get-credentials", settings.clusterName, `--region=${settings.region}`, `--project=${settings.clusterProjectId}`]);
}

export function discoverActivationServices(listed: unknown): PlatformMigrationActivationService[] {
  const workloadList = record(listed, "Kubernetes workloads");
  if (!Array.isArray(workloadList.items)) throw new Error("Kubernetes workloads returned no items array");
  const selected = workloadList.items.flatMap((candidate) => {
    const item = record(candidate, "Kubernetes workload");
    const name = record(item.metadata, "Kubernetes workload metadata").name;
    const kind = item.kind;
    const service = typeof name === "string" && /(^|-)mattermost($|-)/.test(name) ? "mattermost"
      : typeof name === "string" && /(^|-)gitea($|-)/.test(name) ? "gitea" : null;
    if (!service) return [];
    if ((kind !== "Deployment" && kind !== "StatefulSet") || typeof name !== "string") throw new Error(`activation service has unsupported workload: ${String(kind)}/${String(name)}`);
    const spec = record(item.spec, "Kubernetes workload spec");
    const pod = record(record(spec.template, "Kubernetes workload template").spec, "Kubernetes workload pod spec");
    const claims = Array.isArray(pod.volumes) ? pod.volumes.filter((volume) => {
      const candidate = record(volume, "Kubernetes workload volume").persistentVolumeClaim;
      return candidate !== undefined && candidate !== null;
    }) : [];
    if (claims.length !== 1) return [];
    const status = record(item.status ?? {}, "Kubernetes workload status");
    const replicas = spec.replicas ?? 1;
    const readyReplicas = status.readyReplicas ?? 0;
    const pods = status.replicas ?? 0;
    if (!Number.isSafeInteger(replicas) || !Number.isSafeInteger(readyReplicas) || !Number.isSafeInteger(pods)) throw new Error(`activation service has invalid replica state: ${kind}/${name}`);
    return [{ service, kind, name, replicas, readyReplicas, pods } as PlatformMigrationActivationService];
  }).sort((left, right) => left.service.localeCompare(right.service));
  if (selected.length !== 2 || selected[0]?.service !== "gitea" || selected[1]?.service !== "mattermost") throw new Error("activation requires exactly one Mattermost and one Gitea workload");
  return selected;
}

function services(settings: DeploymentEnvironmentSettings): PlatformMigrationActivationService[] {
  ensureContext(settings);
  return discoverActivationServices(JSON.parse(kube(settings, ["get", "deployments,statefulsets", "-o", "json"])));
}

function activationReceiptUri(source: string, target: string, migrationId: string): string {
  return immutableMigrationReceiptUri(`platform-migration-activation/${source}-to-${target}/${migrationId}.json`);
}

function readActivationReceipt(uri: string): PlatformMigrationActivationReceipt | null {
  try {
    return readImmutableMigrationReceipt(uri, { schemaVersion: 1, kind: "platform-migration-activation-receipt" }, run).receipt as unknown as PlatformMigrationActivationReceipt;
  } catch (error) {
    if (error instanceof Error && /matched no objects|not found|does not exist/i.test(error.message)) return null;
    throw error;
  }
}

function assertWriterPair(source: "test-central" | "prod-central", target: "test-west" | "prod-west", migrationId: string, revision: string) {
  const west = readPlatformMigrationWriterReceipt(platformMigrationWriterReceiptUri({ targetId: target, migrationId }));
  const central = readPlatformMigrationWriterReceipt(platformMigrationWriterReceiptUri({ targetId: source, migrationId }));
  if (west === null || central === null || west.schemaVersion !== 1 || central.schemaVersion !== 1 || west.kind !== "platform-migration-writer-quiescence-receipt" || central.kind !== "platform-migration-writer-quiescence-receipt" || west.migrationId !== migrationId || central.migrationId !== migrationId || west.revision !== revision || central.revision !== revision) throw new Error("matching immutable CENTRAL and WEST writer quiescence receipts are required before activation");
  if (west.targetId !== target || west.partnerTargetId !== source || central.targetId !== source || central.partnerTargetId !== target) throw new Error("writer quiescence receipts do not match the exact activation pair");
  return west;
}

function commandInput(target: string): string | undefined { return target.startsWith("prod-") ? "y\n" : undefined; }
function commandYes(target: string): string[] { return target.startsWith("test-") ? ["--yes"] : []; }

async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parsePlatformMigrationActivationArgs(argv);
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const result = await executePlatformMigrationActivation(args, {
    assertReceiptStorage: async () => assertMigrationReceiptBucket(run),
    assertExactMergedMain: async () => exactMergedMain(repoRoot),
    assertMigrationPreconditions: async (activation, revision) => {
      const receipt = assertWriterPair(activation.source, activation.target, activation.migrationId, revision);
      assertRequiredMigrationReceipts(receipt, run);
      await assertPairedCentralQuiesced(receipt);
      await assertTargetWriterQuiesced(receipt);
    },
    settingsForTarget: (target) => deploymentTargetSettings(target),
    readServices: async (settings) => services(settings),
    scaleService: async (settings, service, replicas) => { kube(settings, ["scale", `${service.kind.toLowerCase()}/${service.name}`, `--replicas=${replicas}`]); },
    waitForServicesReady: async (settings, expected) => {
      for (const service of expected) kube(settings, ["rollout", "status", `${service.kind.toLowerCase()}/${service.name}`, "--timeout=10m"]);
      const current = services(settings);
      if (current.some((service) => service.replicas !== 1 || service.readyReplicas !== 1 || service.pods !== 1)) throw new Error("activated Mattermost/Gitea services are not exactly Ready");
    },
    waitForServicesStopped: async (settings, expected) => {
      for (const service of expected) kube(settings, ["rollout", "status", `${service.kind.toLowerCase()}/${service.name}`, "--timeout=10m"]);
      const current = services(settings);
      if (current.some((service) => service.replicas !== 0 || service.readyReplicas !== 0 || service.pods !== 0)) throw new Error("failed activation did not return Mattermost/Gitea to zero replicas");
    },
    rotateMattermost: async () => { run("bash", [path.join(repoRoot, "scripts/setup-mattermost.sh"), `--env=${args.target.startsWith("test-") ? "test" : "prod"}`, `--deployment-target=${args.target}`, "--rotate-platform-credentials", `--confirm-platform-migration=${args.target}`, ...commandYes(args.target)], commandInput(args.target)); },
    resetGitea: async () => { run("bash", [path.join(repoRoot, "scripts/setup-gitea.sh"), `--env=${args.target.startsWith("test-") ? "test" : "prod"}`, `--deployment-target=${args.target}`, ...commandYes(args.target)], commandInput(args.target)); },
    rematerializeSecrets: async () => { run("bash", [path.join(repoRoot, "scripts/setup-secrets.sh"), `--env=${args.target.startsWith("test-") ? "test" : "prod"}`, `--deployment-target=${args.target}`, "--phase=launch", ...commandYes(args.target)], commandInput(args.target)); },
    verifySecrets: async () => { run("bash", [path.join(repoRoot, "scripts/verify-secrets.sh"), `--env=${args.target.startsWith("test-") ? "test" : "prod"}`, `--deployment-target=${args.target}`]); },
    receiptUri: (activation) => activationReceiptUri(activation.source, activation.target, activation.migrationId),
    readReceipt: async (uri) => readActivationReceipt(uri),
    writeReceipt: async (_uri, receipt) => { writeImmutableMigrationReceipt(`platform-migration-activation/${receipt.source}-to-${receipt.target}/${receipt.migrationId}.json`, receipt as unknown as Record<string, unknown>, run); },
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function isEntrypoint(moduleUrl: string, entrypoint: string | undefined): boolean {
  if (!entrypoint) return false;
  try { return fs.realpathSync(fileURLToPath(moduleUrl)) === fs.realpathSync(entrypoint); }
  catch { return fileURLToPath(moduleUrl) === entrypoint; }
}

if (isEntrypoint(import.meta.url, process.argv[1])) main().catch((error) => {
  process.stderr.write(`[platform-migration-activation] fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
