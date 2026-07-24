import type { DeploymentEnvironmentSettings } from "@octogee/core/deployment-environment";

export const PLATFORM_CREDENTIAL_WRITER_CONTAINERS = new Set([
  "gateway",
  "gateway-edge",
  "gateway-router",
  "glm-controller",
  "octogee-api",
  "provisioner",
]);
export const PLATFORM_MIGRATION_WRITER_READINESS_TIMEOUT_MILLISECONDS = 600_000;

export type PlatformMigrationWriterTargetId =
  | "test-central"
  | "test-west"
  | "prod-central"
  | "prod-west";

type WriterMode = "quiesce" | "restore";

export interface PlatformMigrationWriterQuiescenceArgs {
  targetId: PlatformMigrationWriterTargetId;
  migrationId: string;
  mode: WriterMode;
  apply: boolean;
  confirmation: string | null;
}

export interface KubernetesWorkload {
  kind?: unknown;
  metadata?: { name?: unknown; labels?: unknown };
  spec?: {
    replicas?: unknown;
    template?: { spec?: { containers?: unknown } };
  };
  status?: { readyReplicas?: unknown };
}

export interface KubernetesPodList {
  items?: Array<{
    metadata?: { name?: unknown };
    spec?: { containers?: Array<{ name?: unknown }> };
    status?: {
      phase?: unknown;
      conditions?: Array<{ type?: unknown; status?: unknown }>;
    };
  }>;
}

export interface WriterWorkload {
  kind: "Deployment" | "StatefulSet";
  name: string;
  replicas: number;
  containers: string[];
}

export interface PlatformMigrationWriterReceipt {
  schemaVersion: 1;
  kind: "platform-migration-writer-quiescence-receipt";
  targetId: PlatformMigrationWriterTargetId;
  partnerTargetId: PlatformMigrationWriterTargetId;
  migrationId: string;
  revision: string;
  priorMaintenance: Record<string, unknown> | null;
  writerWorkloads: WriterWorkload[];
}

export interface PlatformMigrationWriterQuiescenceWaitInput {
  receipt: PlatformMigrationWriterReceipt;
  readWorkloads(): Promise<KubernetesWorkload[]>;
  readPods(): Promise<KubernetesPodList>;
  now(): number;
  sleep(milliseconds: number): Promise<void>;
  timeoutMilliseconds: number;
  pollMilliseconds: number;
}

export type PlatformMigrationWriterReadinessWaitInput =
  PlatformMigrationWriterQuiescenceWaitInput;

export interface PlatformMigrationWriterQuiescenceDependencies {
  assertExactMergedMain(): Promise<string>;
  readWorkloads(settings: DeploymentEnvironmentSettings): Promise<KubernetesWorkload[]>;
  readMaintenance(settings: DeploymentEnvironmentSettings): Promise<Record<string, unknown> | null>;
  writeMaintenance(
    settings: DeploymentEnvironmentSettings,
    maintenance: Record<string, unknown> | null,
  ): Promise<void>;
  scaleWorkload(
    settings: DeploymentEnvironmentSettings,
    workload: Pick<WriterWorkload, "kind" | "name">,
    replicas: number,
  ): Promise<void>;
  waitForWritersQuiesced(
    settings: DeploymentEnvironmentSettings,
    receipt: PlatformMigrationWriterReceipt,
  ): Promise<void>;
  waitForWritersReady(
    settings: DeploymentEnvironmentSettings,
    receipt: PlatformMigrationWriterReceipt,
  ): Promise<void>;
  readReceipt(uri: string): Promise<PlatformMigrationWriterReceipt | null>;
  writeReceipt(uri: string, receipt: PlatformMigrationWriterReceipt): Promise<void>;
  assertRequiredMigrationReceipts(receipt: PlatformMigrationWriterReceipt): Promise<void>;
  assertPairedCentralQuiesced(receipt: PlatformMigrationWriterReceipt): Promise<void>;
  settingsForTarget(targetId: PlatformMigrationWriterTargetId): DeploymentEnvironmentSettings;
  receiptUri(receipt: Pick<PlatformMigrationWriterReceipt, "targetId" | "migrationId">): string;
}

const TARGET_IDS = new Set<PlatformMigrationWriterTargetId>([
  "test-central",
  "test-west",
  "prod-central",
  "prod-west",
]);
const REQUIRED_STATIC_WRITERS = ["gateway-router", "glm-controller", "octogee-api"];
const SAFE_MIGRATION_ID = /^[a-z0-9][a-z0-9-]{2,79}$/;
const MAINTENANCE_FIELDS = new Set(["mode", "reason", "updatedAt", "updatedBy", "managedBy"]);
const FROZEN_MAINTENANCE = {
  mode: "frozen",
  managedBy: "platform-migration-writer-quiescence",
};

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value as number;
}

function target(value: string): PlatformMigrationWriterTargetId {
  if (!TARGET_IDS.has(value as PlatformMigrationWriterTargetId)) {
    throw new Error("target must be test-central, test-west, prod-central, or prod-west");
  }
  return value as PlatformMigrationWriterTargetId;
}

function argumentValue(argv: readonly string[], name: string): string | null {
  const prefix = `--${name}=`;
  const values = argv.filter((argument) => argument.startsWith(prefix));
  if (values.length > 1) throw new Error(`argument appears more than once: --${name}=`);
  return values.length === 1 ? values[0]!.slice(prefix.length) : null;
}

export function platformMigrationWriterQuiescenceConfirmation(
  targetId: PlatformMigrationWriterTargetId,
  migrationId: string,
  mode: WriterMode,
): string {
  return `octogee/platform-migration-writer-quiescence/${targetId}/${migrationId}/${mode}`;
}

export function parsePlatformMigrationWriterQuiescenceArgs(
  argv: readonly string[],
): PlatformMigrationWriterQuiescenceArgs {
  const unknown = argv.filter((argument) =>
    argument !== "--apply" &&
    !argument.startsWith("--target=") &&
    !argument.startsWith("--migration-id=") &&
    !argument.startsWith("--mode=") &&
    !argument.startsWith("--confirm="));
  if (unknown.length > 0) throw new Error(`unknown argument(s): ${unknown.join(", ")}`);

  const targetIdValue = argumentValue(argv, "target");
  if (!targetIdValue) throw new Error("requires --target=TARGET");
  const targetId = target(targetIdValue);
  const migrationId = argumentValue(argv, "migration-id");
  if (!migrationId || !SAFE_MIGRATION_ID.test(migrationId)) {
    throw new Error("migration id must contain 3-80 lowercase letters, digits, or hyphens");
  }
  const mode = argumentValue(argv, "mode");
  if (mode !== "quiesce" && mode !== "restore") {
    throw new Error("requires --mode=quiesce|restore");
  }
  if (mode === "restore" && targetId.endsWith("-central")) {
    throw new Error("restore supports WEST targets only; CENTRAL rollback requires separate explicit authority");
  }
  const apply = argv.includes("--apply");
  const confirmation = argumentValue(argv, "confirm");
  const expected = platformMigrationWriterQuiescenceConfirmation(targetId, migrationId, mode);
  if (apply && confirmation !== expected) {
    throw new Error(`apply requires --confirm=${expected}`);
  }
  return { targetId, migrationId, mode, apply, confirmation };
}

function workloadContainers(workload: KubernetesWorkload, label: string): string[] {
  const template = record(workload.spec?.template, `${label} template`);
  const podSpec = record(template.spec, `${label} pod spec`);
  if (!Array.isArray(podSpec.containers) || podSpec.containers.length === 0) {
    throw new Error(`${label} must declare containers`);
  }
  const names = podSpec.containers.map((container, index) => {
    const value = record(container, `${label} container ${index}`).name;
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`${label} container ${index} has no name`);
    }
    return value;
  });
  if (new Set(names).size !== names.length) throw new Error(`${label} has duplicate container names`);
  return names.sort();
}

export function selectPlatformCredentialWriterWorkloads(
  workloads: readonly KubernetesWorkload[],
): WriterWorkload[] {
  const selected: WriterWorkload[] = [];
  const identities = new Set<string>();
  for (const workload of workloads) {
    const kind = workload.kind;
    const metadata = record(workload.metadata, "Kubernetes workload metadata");
    const name = metadata.name;
    if (typeof name !== "string" || name.length === 0) {
      throw new Error("Kubernetes workload has no name");
    }
    const label = `${String(kind)}/${name}`;
    const containers = workloadContainers(workload, label);
    const writesCredentials = containers.some((container) =>
      PLATFORM_CREDENTIAL_WRITER_CONTAINERS.has(container));
    if (!writesCredentials) continue;
    if (kind !== "Deployment" && kind !== "StatefulSet") {
      throw new Error(`${label} is a credential writer with unsupported kind`);
    }
    const identity = `${kind}/${name}`;
    if (identities.has(identity)) throw new Error(`ambiguous credential writer workload: ${identity}`);
    identities.add(identity);
    selected.push({
      kind,
      name,
      replicas: nonNegativeInteger(workload.spec?.replicas ?? 1, `${label} replicas`),
      containers,
    });
  }
  for (const name of REQUIRED_STATIC_WRITERS) {
    const matches = selected.filter((workload) => workload.kind === "Deployment" && workload.name === name);
    if (matches.length !== 1) throw new Error(`required credential writer Deployment/${name} is missing or ambiguous`);
  }
  return selected.sort((left, right) =>
    `${left.kind}/${left.name}`.localeCompare(`${right.kind}/${right.name}`));
}

export function activePlatformCredentialWriters(
  podList: KubernetesPodList,
): string[] {
  return (podList.items ?? [])
    .filter((pod) => pod.status?.phase === "Running")
    .filter((pod) => (pod.spec?.containers ?? []).some((container) =>
      typeof container.name === "string" && PLATFORM_CREDENTIAL_WRITER_CONTAINERS.has(container.name)))
    .map((pod) => pod.metadata?.name)
    .filter((name): name is string => typeof name === "string" && name.length > 0)
    .sort();
}

export function platformCredentialWriterPods(
  podList: KubernetesPodList,
): string[] {
  return (podList.items ?? [])
    .filter((pod) => (pod.spec?.containers ?? []).some((container) =>
      typeof container.name === "string" && PLATFORM_CREDENTIAL_WRITER_CONTAINERS.has(container.name)))
    .map((pod) => pod.metadata?.name)
    .filter((name): name is string => typeof name === "string" && name.length > 0)
    .sort();
}

function partnerTarget(targetId: PlatformMigrationWriterTargetId): PlatformMigrationWriterTargetId {
  const partners: Record<PlatformMigrationWriterTargetId, PlatformMigrationWriterTargetId> = {
    "test-central": "test-west",
    "test-west": "test-central",
    "prod-central": "prod-west",
    "prod-west": "prod-central",
  };
  return partners[targetId];
}

function completedContentService(candidate: unknown): boolean {
  const service = record(candidate, "platform content migration service");
  return (service.service === "mattermost" || service.service === "gitea") &&
    typeof service.files === "object" &&
    service.files !== null &&
    typeof service.database === "string";
}

function exactContentMigration(
  content: Record<string, unknown>,
  receipt: PlatformMigrationWriterReceipt,
  source: PlatformMigrationWriterTargetId,
  targetId: PlatformMigrationWriterTargetId,
): boolean {
  const services = content.services;
  if (!Array.isArray(services) || services.length !== 2) return false;
  const serviceNames = services.map((service) =>
    record(service, "platform content migration service").service);
  return content.schemaVersion === 1 &&
    content.migrationId === receipt.migrationId &&
    content.source === source &&
    content.target === targetId &&
    content.revision === receipt.revision &&
    typeof content.completedAt === "string" &&
    new Set(serviceNames).size === 2 &&
    services.every(completedContentService);
}

function exactFirebaseMigration(
  candidate: unknown,
  receipt: PlatformMigrationWriterReceipt,
  source: PlatformMigrationWriterTargetId,
  targetId: PlatformMigrationWriterTargetId,
): boolean {
  const firebase = record(candidate, "Firebase/Auth/Storage migration receipt");
  return firebase.schemaVersion === 1 &&
    firebase.kind === "platform-firestore-auth-west-migration-receipt" &&
    firebase.mode === "apply" &&
    firebase.verified === true &&
    firebase.migrationId === receipt.migrationId &&
    firebase.sourceTargetId === source &&
    firebase.targetTargetId === targetId &&
    firebase.gitCommit === receipt.revision;
}

export function assertRequiredPlatformMigrationReceipts(
  receipt: PlatformMigrationWriterReceipt,
  contentReceipt: unknown,
  firebaseReceipts: readonly unknown[],
): void {
  const source = receipt.targetId.endsWith("-central") ? receipt.targetId : receipt.partnerTargetId;
  const target = receipt.targetId.endsWith("-west") ? receipt.targetId : receipt.partnerTargetId;
  if ((source !== "test-central" && source !== "prod-central") ||
    (target !== "test-west" && target !== "prod-west")) {
    throw new Error("writer quiescence receipt does not describe a central-to-west migration");
  }
  const content = record(contentReceipt, "platform content migration receipt");
  if (!exactContentMigration(content, receipt, source, target)) {
    throw new Error("platform content migration receipt does not prove the exact completed migration");
  }
  const firebaseMatches = firebaseReceipts.some((candidate) =>
    exactFirebaseMigration(candidate, receipt, source, target));
  if (!firebaseMatches) {
    throw new Error("verified Firebase/Auth/Storage migration receipt does not match the exact writer quiescence revision");
  }
}

function equal(value: unknown, expected: unknown): boolean {
  return JSON.stringify(value) === JSON.stringify(expected);
}

function assertReceipt(
  receipt: PlatformMigrationWriterReceipt,
  args: PlatformMigrationWriterQuiescenceArgs,
  revision: string,
): void {
  if (receipt.schemaVersion !== 1 || receipt.kind !== "platform-migration-writer-quiescence-receipt") {
    throw new Error("writer quiescence receipt has an unsupported schema");
  }
  if (
    receipt.targetId !== args.targetId ||
    receipt.partnerTargetId !== partnerTarget(args.targetId) ||
    receipt.migrationId !== args.migrationId
  ) {
    throw new Error("writer quiescence receipt does not match target and migration id");
  }
  if (receipt.revision !== revision) {
    throw new Error("writer quiescence receipt was not created at this exact merged commit");
  }
  if (!Array.isArray(receipt.writerWorkloads) || receipt.writerWorkloads.length === 0) {
    throw new Error("writer quiescence receipt has no writer workloads");
  }
}

function assertCurrentWorkloads(
  observed: readonly WriterWorkload[],
  receipt: PlatformMigrationWriterReceipt,
  allowedReplicas: (expected: number) => readonly number[],
): void {
  if (observed.length !== receipt.writerWorkloads.length) {
    throw new Error("credential writer workload set drifted from the quiescence receipt");
  }
  for (let index = 0; index < receipt.writerWorkloads.length; index += 1) {
    const expected = receipt.writerWorkloads[index]!;
    const current = observed[index]!;
    if (
      current.kind !== expected.kind ||
      current.name !== expected.name ||
      !equal(current.containers, expected.containers) ||
      !allowedReplicas(expected.replicas).includes(current.replicas)
    ) {
      throw new Error(`credential writer workload drifted from the quiescence receipt: ${expected.kind}/${expected.name}`);
    }
  }
}

export async function waitForPlatformMigrationWriterQuiescence(
  input: PlatformMigrationWriterQuiescenceWaitInput,
): Promise<void> {
  const deadline = input.now() + input.timeoutMilliseconds;
  let lastFailure = "not checked";
  while (true) {
    try {
      const workloads = selectPlatformCredentialWriterWorkloads(await input.readWorkloads());
      assertCurrentWorkloads(workloads, input.receipt, () => [0]);
      const writers = platformCredentialWriterPods(await input.readPods());
      if (writers.length === 0) return;
      lastFailure = `credential writer pods remain: ${writers.join(", ")}`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    if (input.now() >= deadline) {
      throw new Error(`credential writers did not quiesce within ${input.timeoutMilliseconds}ms: ${lastFailure}`);
    }
    await input.sleep(input.pollMilliseconds);
  }
}

function workloadReadyReplicas(
  workloads: readonly KubernetesWorkload[],
  receipt: PlatformMigrationWriterReceipt,
): void {
  const selected = selectPlatformCredentialWriterWorkloads(workloads);
  assertCurrentWorkloads(selected, receipt, (replicas) => [replicas]);
  for (const expected of receipt.writerWorkloads) {
    const workload = workloads.find((candidate) =>
      candidate.kind === expected.kind && candidate.metadata?.name === expected.name);
    const ready = workload?.status?.readyReplicas ?? 0;
    if (ready !== expected.replicas) {
      throw new Error(`${expected.kind}/${expected.name} Ready replicas ${String(ready)} != ${expected.replicas}`);
    }
  }
}

function assertWriterPodsReady(
  podList: KubernetesPodList,
  expectedCount: number,
): void {
  const writers = (podList.items ?? []).filter((pod) =>
    (pod.spec?.containers ?? []).some((container) =>
      typeof container.name === "string" &&
      PLATFORM_CREDENTIAL_WRITER_CONTAINERS.has(container.name)));
  if (writers.length !== expectedCount) {
    throw new Error(`credential writer pod count ${writers.length} != ${expectedCount}`);
  }
  for (const pod of writers) {
    const name = typeof pod.metadata?.name === "string" ? pod.metadata.name : "unnamed";
    const ready = pod.status?.conditions?.some((condition) =>
      condition.type === "Ready" && condition.status === "True");
    if (pod.status?.phase !== "Running" || !ready) {
      throw new Error(`credential writer pod ${name} is not Running/Ready`);
    }
  }
}

export async function waitForPlatformMigrationWriterReadiness(
  input: PlatformMigrationWriterReadinessWaitInput,
): Promise<void> {
  const deadline = input.now() + input.timeoutMilliseconds;
  const expectedPods = input.receipt.writerWorkloads.reduce(
    (total, workload) => total + workload.replicas,
    0,
  );
  let lastFailure = "not checked";
  while (true) {
    try {
      workloadReadyReplicas(await input.readWorkloads(), input.receipt);
      assertWriterPodsReady(await input.readPods(), expectedPods);
      return;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    if (input.now() >= deadline) {
      throw new Error(`credential writers did not become Ready within ${input.timeoutMilliseconds}ms: ${lastFailure}`);
    }
    await input.sleep(input.pollMilliseconds);
  }
}

function frozenMaintenance(): Record<string, unknown> {
  return { managedBy: FROZEN_MAINTENANCE.managedBy, mode: FROZEN_MAINTENANCE.mode };
}

function receiptSafeMaintenance(
  maintenance: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (maintenance === null) return null;
  for (const [key, value] of Object.entries(maintenance)) {
    if (!MAINTENANCE_FIELDS.has(key)) {
      throw new Error(`GLM maintenance document has unsupported field: ${key}`);
    }
    if (typeof value !== "string" && (typeof value !== "number" || !Number.isFinite(value))) {
      throw new Error(`GLM maintenance document has non-metadata field: ${key}`);
    }
  }
  if (typeof maintenance.mode !== "string" || maintenance.mode.length === 0) {
    throw new Error("GLM maintenance document has no mode");
  }
  return Object.fromEntries(Object.entries(maintenance).sort(([left], [right]) => left.localeCompare(right)));
}

type ExecutionResult = {
  mode: WriterMode;
  receipt: string;
  targetId: PlatformMigrationWriterTargetId;
  writerWorkloads: WriterWorkload[];
};

interface QuiesceExecutionInput {
  args: PlatformMigrationWriterQuiescenceArgs;
  dependencies: PlatformMigrationWriterQuiescenceDependencies;
  settings: DeploymentEnvironmentSettings;
  observed: WriterWorkload[];
  maintenance: Record<string, unknown> | null;
  plannedReceipt: PlatformMigrationWriterReceipt;
  existing: PlatformMigrationWriterReceipt | null;
  receiptUri: string;
}

async function executeQuiesce(
  input: QuiesceExecutionInput,
): Promise<ExecutionResult> {
  const {
    args,
    dependencies,
    settings,
    observed,
    maintenance,
    plannedReceipt,
    existing,
    receiptUri,
  } = input;
  if (existing === null) {
    await dependencies.writeReceipt(receiptUri, plannedReceipt);
  } else {
    assertReceipt(existing, args, plannedReceipt.revision);
    if (!equal(existing.priorMaintenance, maintenance) && !equal(maintenance, frozenMaintenance())) {
      throw new Error("maintenance state drifted from the quiescence receipt");
    }
    assertCurrentWorkloads(observed, existing, (replicas) => [0, replicas]);
  }
  const activeReceipt = existing ?? plannedReceipt;
  if (!equal(maintenance, frozenMaintenance())) {
    if (!equal(maintenance, activeReceipt.priorMaintenance)) {
      throw new Error("maintenance state drifted before credential writer quiescence");
    }
    await dependencies.writeMaintenance(settings, frozenMaintenance());
  }
  for (const workload of observed) {
    if (workload.replicas !== 0) {
      await dependencies.scaleWorkload(settings, workload, 0);
    }
  }
  await dependencies.waitForWritersQuiesced(settings, activeReceipt);
  return {
    mode: args.mode,
    receipt: receiptUri,
    targetId: args.targetId,
    writerWorkloads: activeReceipt.writerWorkloads,
  };
}

interface RestoreExecutionInput {
  args: PlatformMigrationWriterQuiescenceArgs;
  dependencies: PlatformMigrationWriterQuiescenceDependencies;
  settings: DeploymentEnvironmentSettings;
  observed: WriterWorkload[];
  maintenance: Record<string, unknown> | null;
  existing: PlatformMigrationWriterReceipt | null;
  revision: string;
  receiptUri: string;
}

async function executeRestore(
  input: RestoreExecutionInput,
): Promise<ExecutionResult> {
  const {
    args,
    dependencies,
    settings,
    observed,
    maintenance,
    existing,
    revision,
    receiptUri,
  } = input;
  if (!args.targetId.endsWith("-west")) {
    throw new Error("restore supports WEST targets only; CENTRAL rollback requires separate explicit authority");
  }
  if (existing === null) throw new Error("restore requires an existing writer quiescence receipt");
  assertReceipt(existing, args, revision);
  await dependencies.assertRequiredMigrationReceipts(existing);
  await dependencies.assertPairedCentralQuiesced(existing);
  if (!equal(maintenance, frozenMaintenance())) {
    throw new Error("restore requires the writer-quiescence maintenance state to remain frozen");
  }
  assertCurrentWorkloads(observed, existing, () => [0]);
  await dependencies.waitForWritersQuiesced(settings, existing);
  if (!args.apply) {
    return { mode: args.mode, receipt: receiptUri, targetId: args.targetId, writerWorkloads: existing.writerWorkloads };
  }
  for (const workload of existing.writerWorkloads) {
    await dependencies.scaleWorkload(settings, workload, workload.replicas);
  }
  await dependencies.waitForWritersReady(settings, existing);
  await dependencies.writeMaintenance(settings, existing.priorMaintenance);
  return { mode: args.mode, receipt: receiptUri, targetId: args.targetId, writerWorkloads: existing.writerWorkloads };
}

export async function executePlatformMigrationWriterQuiescence(
  args: PlatformMigrationWriterQuiescenceArgs,
  dependencies: PlatformMigrationWriterQuiescenceDependencies,
): Promise<ExecutionResult> {
  const settings = dependencies.settingsForTarget(args.targetId);
  const observed = selectPlatformCredentialWriterWorkloads(await dependencies.readWorkloads(settings));
  const maintenance = receiptSafeMaintenance(await dependencies.readMaintenance(settings));
  const provisionalReceipt = {
    schemaVersion: 1 as const,
    kind: "platform-migration-writer-quiescence-receipt" as const,
    targetId: args.targetId,
    partnerTargetId: partnerTarget(args.targetId),
    migrationId: args.migrationId,
    revision: "dry-run",
    priorMaintenance: maintenance,
    writerWorkloads: observed,
  };
  const receiptUri = dependencies.receiptUri(provisionalReceipt);
  if (!args.apply && args.mode === "quiesce") {
    return { mode: args.mode, receipt: receiptUri, targetId: args.targetId, writerWorkloads: observed };
  }
  const revision = await dependencies.assertExactMergedMain();
  const plannedReceipt = { ...provisionalReceipt, revision };
  const existing = await dependencies.readReceipt(receiptUri);
  if (args.mode === "quiesce") {
    return executeQuiesce({
      args,
      dependencies,
      settings,
      observed,
      maintenance,
      plannedReceipt,
      existing,
      receiptUri,
    });
  }
  return executeRestore({
    args,
    dependencies,
    settings,
    observed,
    maintenance,
    existing,
    revision,
    receiptUri,
  });
}
