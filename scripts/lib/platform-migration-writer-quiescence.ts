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
export const PLATFORM_MIGRATION_SCHEDULER_ATTEMPT_DEADLINE_MILLISECONDS = 180_000;
export const PLATFORM_MIGRATION_SCHEDULED_WRITER_FUNCTIONS = [
  "cleanupFeedRetention",
  "reapExpiredAgentImports",
  "processGatewayAccessLifecycle",
] as const;
export const PLATFORM_MIGRATION_CRONJOB_WRITERS = [
  "trial-expiry",
  "notification-digest-daily",
  "notification-digest-weekly",
  "credit-auto-top-up",
] as const;

export function platformMigrationScheduledWriterNames(region: string): string[] {
  if (!/^[a-z]+-[a-z]+\d$/.test(region)) throw new Error(`invalid Scheduler region: ${region}`);
  return PLATFORM_MIGRATION_SCHEDULED_WRITER_FUNCTIONS
    .map((functionName) => `firebase-schedule-${functionName}-${region}`)
    .sort();
}

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

export interface PlatformMigrationScheduledWriter {
  name: string;
  state: string;
  attemptDeadline: string;
  retryConfig?: {
    retryCount?: unknown;
    maxRetryDuration?: unknown;
  };
  targetType: string;
}

export interface KubernetesCronJob {
  metadata?: { name?: unknown };
  spec?: { suspend?: unknown };
}

export interface KubernetesCronJobJob {
  metadata?: {
    name?: unknown;
    ownerReferences?: Array<{ kind?: unknown; name?: unknown }>;
  };
  status?: {
    active?: unknown;
    succeeded?: unknown;
    failed?: unknown;
    conditions?: Array<{ type?: unknown; status?: unknown }>;
  };
}

export interface ScheduledWriterReceipt {
  projectId: string;
  region: string;
  jobs: Array<{
    name: string;
    priorState: "ENABLED" | "PAUSED";
    quiescedState: "PAUSED";
    targetType: "HTTP";
    attemptDeadlineMilliseconds: number;
    retryConfig: {
      retryCount: 0;
      maxRetryDurationMilliseconds: 0;
    };
  }>;
}

export interface CronJobReceipt {
  name: string;
  priorSuspended: boolean;
  quiescedSuspended: true;
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
  scheduledWriters?: ScheduledWriterReceipt;
  cronJobs?: CronJobReceipt[];
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
  assertReceiptStorage(): Promise<void>;
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
  readScheduledWriters(settings: DeploymentEnvironmentSettings): Promise<PlatformMigrationScheduledWriter[]>;
  pauseScheduledWriter(
    settings: DeploymentEnvironmentSettings,
    writer: Pick<PlatformMigrationScheduledWriter, "name">,
  ): Promise<void>;
  resumeScheduledWriter(
    settings: DeploymentEnvironmentSettings,
    writer: Pick<PlatformMigrationScheduledWriter, "name">,
  ): Promise<void>;
  readCronJobs(settings: DeploymentEnvironmentSettings): Promise<KubernetesCronJob[]>;
  readCronJobJobs(settings: DeploymentEnvironmentSettings): Promise<KubernetesCronJobJob[]>;
  setCronJobSuspended(
    settings: DeploymentEnvironmentSettings,
    cronJob: Pick<CronJobReceipt, "name">,
    suspended: boolean,
  ): Promise<void>;
  waitForScheduledWritersQuiesced(
    settings: DeploymentEnvironmentSettings,
    receipt: PlatformMigrationWriterReceipt,
  ): Promise<void>;
  waitForScheduledWriterAttemptsDrained(
    settings: DeploymentEnvironmentSettings,
    receipt: PlatformMigrationWriterReceipt,
  ): Promise<void>;
  waitForScheduledWritersReady(
    settings: DeploymentEnvironmentSettings,
    receipt: PlatformMigrationWriterReceipt,
  ): Promise<void>;
  waitForWritersQuiesced(
    settings: DeploymentEnvironmentSettings,
    receipt: PlatformMigrationWriterReceipt,
  ): Promise<void>;
  waitForWritersReady(
    settings: DeploymentEnvironmentSettings,
    receipt: PlatformMigrationWriterReceipt,
  ): Promise<void>;
  validateGiteaTokenConsumers(settings: DeploymentEnvironmentSettings): Promise<void>;
  readReceipt(uri: string): Promise<PlatformMigrationWriterReceipt | null>;
  writeReceipt(uri: string, receipt: PlatformMigrationWriterReceipt): Promise<void>;
  assertRequiredMigrationReceipts(receipt: PlatformMigrationWriterReceipt): Promise<void>;
  assertMigrationActivation(receipt: PlatformMigrationWriterReceipt): Promise<void>;
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

function schedulerState(value: unknown, label: string): "ENABLED" | "PAUSED" {
  if (value === "ENABLED" || value === "PAUSED") return value;
  throw new Error(`${label} must be ENABLED or PAUSED`);
}

function durationMilliseconds(value: unknown, label: string): number {
  if (typeof value !== "string") throw new Error(`${label} must be a duration`);
  const match = /^(\d+)(?:\.(\d{1,9}))?s$/.exec(value);
  if (!match) throw new Error(`${label} must be a seconds duration`);
  const wholeMilliseconds = Number(match[1]) * 1_000;
  const fractionalMilliseconds = Number(`0.${match[2] ?? "0"}`) * 1_000;
  const milliseconds = Math.ceil(wholeMilliseconds + fractionalMilliseconds);
  if (!Number.isSafeInteger(milliseconds)) throw new Error(`${label} exceeds a safe duration`);
  return milliseconds;
}

function zeroRetryConfig(
  retryConfig: PlatformMigrationScheduledWriter["retryConfig"],
  label: string,
): { retryCount: 0; maxRetryDurationMilliseconds: 0 } {
  const retryCount = retryConfig?.retryCount ?? 0;
  if (retryCount !== 0) throw new Error(`${label} has nonzero Scheduler retryCount`);
  const maxRetryDurationMilliseconds = retryConfig?.maxRetryDuration === undefined
    ? 0
    : durationMilliseconds(retryConfig.maxRetryDuration, `${label} maxRetryDuration`);
  if (maxRetryDurationMilliseconds !== 0) {
    throw new Error(`${label} has nonzero or unbounded Scheduler retry duration`);
  }
  return { retryCount: 0, maxRetryDurationMilliseconds: 0 };
}

function expectedScheduledWriterNames(settings: DeploymentEnvironmentSettings): string[] {
  return platformMigrationScheduledWriterNames(settings.region);
}

export function selectPlatformMigrationScheduledWriters(
  settings: DeploymentEnvironmentSettings,
  jobs: readonly PlatformMigrationScheduledWriter[],
): PlatformMigrationScheduledWriter[] {
  const expected = new Set(expectedScheduledWriterNames(settings));
  const discovered = new Map<string, PlatformMigrationScheduledWriter>();
  for (const job of jobs) {
    if (typeof job.name !== "string" || job.name.length === 0) {
      throw new Error("Cloud Scheduler writer job has no name");
    }
    const state = schedulerState(job.state, `Cloud Scheduler job ${job.name} state`);
    if (!expected.has(job.name)) {
      if (state === "ENABLED") throw new Error(`unknown enabled scheduled writer: ${job.name}`);
      continue;
    }
    if (job.targetType !== "HTTP") throw new Error(`Cloud Scheduler job ${job.name} is not an HTTP target`);
    const attemptDeadlineMilliseconds = durationMilliseconds(
      job.attemptDeadline,
      `Cloud Scheduler job ${job.name} attemptDeadline`,
    );
    if (attemptDeadlineMilliseconds !== PLATFORM_MIGRATION_SCHEDULER_ATTEMPT_DEADLINE_MILLISECONDS) {
      throw new Error(`Cloud Scheduler job ${job.name} attemptDeadline is outside the reviewed 180s contract`);
    }
    zeroRetryConfig(job.retryConfig, `Cloud Scheduler job ${job.name}`);
    if (discovered.has(job.name)) throw new Error(`ambiguous Cloud Scheduler job: ${job.name}`);
    discovered.set(job.name, {
      name: job.name,
      state,
      attemptDeadline: job.attemptDeadline,
      retryConfig: job.retryConfig,
      targetType: job.targetType,
    });
  }
  for (const name of expected) {
    if (!discovered.has(name)) throw new Error(`required scheduled writer is missing: ${name}`);
  }
  return [...expected].map((name) => discovered.get(name)!);
}

export function selectPlatformMigrationCronJobs(
  cronJobs: readonly KubernetesCronJob[],
): Array<{ name: string; suspended: boolean }> {
  const expected = new Set<string>(PLATFORM_MIGRATION_CRONJOB_WRITERS);
  const discovered = new Map<string, { name: string; suspended: boolean }>();
  for (const cronJob of cronJobs) {
    const name = cronJob.metadata?.name;
    if (typeof name !== "string" || name.length === 0) throw new Error("Kubernetes CronJob has no name");
    if (typeof cronJob.spec?.suspend !== "boolean" && cronJob.spec?.suspend !== undefined) {
      throw new Error(`Kubernetes CronJob ${name} suspend must be boolean`);
    }
    const suspended = cronJob.spec?.suspend === true;
    if (discovered.has(name)) throw new Error(`ambiguous Kubernetes CronJob: ${name}`);
    discovered.set(name, { name, suspended });
    if (!expected.has(name) && !suspended) throw new Error(`unknown active Kubernetes CronJob: ${name}`);
  }
  for (const name of expected) {
    if (!discovered.has(name)) throw new Error(`required Kubernetes CronJob is missing: ${name}`);
  }
  return [...expected].sort().map((name) => discovered.get(name)!);
}

function validScheduledWriterReceiptJob(
  job: ScheduledWriterReceipt["jobs"][number] | undefined,
  expectedName: string,
): boolean {
  return job !== undefined &&
    job.name === expectedName &&
    (job.priorState === "ENABLED" || job.priorState === "PAUSED") &&
    job.quiescedState === "PAUSED" &&
    job.targetType === "HTTP" &&
    job.attemptDeadlineMilliseconds === PLATFORM_MIGRATION_SCHEDULER_ATTEMPT_DEADLINE_MILLISECONDS &&
    job.retryConfig?.retryCount === 0 &&
    job.retryConfig?.maxRetryDurationMilliseconds === 0;
}

function scheduledWriterReceipt(receipt: PlatformMigrationWriterReceipt): ScheduledWriterReceipt {
  const scheduled = receipt.scheduledWriters;
  if (!scheduled || typeof scheduled.projectId !== "string" || typeof scheduled.region !== "string") {
    throw new Error("writer quiescence receipt has no scheduled writer contract");
  }
  if (!Array.isArray(scheduled.jobs) || scheduled.jobs.length !== PLATFORM_MIGRATION_SCHEDULED_WRITER_FUNCTIONS.length) {
    throw new Error("writer quiescence receipt has an invalid scheduled writer set");
  }
  const expected = platformMigrationScheduledWriterNames(scheduled.region);
  if (!expected.every((name, index) => validScheduledWriterReceiptJob(scheduled.jobs[index], name))) {
    throw new Error("writer quiescence receipt has an invalid scheduled writer state");
  }
  return scheduled;
}

function cronJobReceipt(receipt: PlatformMigrationWriterReceipt): CronJobReceipt[] {
  const cronJobs = receipt.cronJobs;
  if (!Array.isArray(cronJobs) || cronJobs.length !== PLATFORM_MIGRATION_CRONJOB_WRITERS.length) {
    throw new Error("writer quiescence receipt has an invalid Kubernetes CronJob set");
  }
  const expected = [...PLATFORM_MIGRATION_CRONJOB_WRITERS].sort();
  for (let index = 0; index < expected.length; index += 1) {
    const cronJob = cronJobs[index];
    if (!cronJob || cronJob.name !== expected[index] || typeof cronJob.priorSuspended !== "boolean" || cronJob.quiescedSuspended !== true) {
      throw new Error("writer quiescence receipt has an invalid Kubernetes CronJob state");
    }
  }
  return cronJobs;
}

function assertScheduledWriterReceiptMatchesTarget(
  receipt: PlatformMigrationWriterReceipt,
  settings: DeploymentEnvironmentSettings,
): void {
  const scheduled = scheduledWriterReceipt(receipt);
  if (scheduled.projectId !== settings.firebaseProjectId || scheduled.region !== settings.region) {
    throw new Error("writer quiescence receipt scheduled writer target drifted");
  }
  cronJobReceipt(receipt);
}

function assertCurrentScheduledWriters(
  observed: readonly PlatformMigrationScheduledWriter[],
  receipt: PlatformMigrationWriterReceipt,
  allowedStates: (prior: "ENABLED" | "PAUSED") => readonly ("ENABLED" | "PAUSED")[],
): void {
  const scheduled = scheduledWriterReceipt(receipt);
  if (observed.length !== scheduled.jobs.length) throw new Error("scheduled writer set drifted from the quiescence receipt");
  for (let index = 0; index < scheduled.jobs.length; index += 1) {
    const expected = scheduled.jobs[index]!;
    const current = observed[index]!;
    const currentAttemptDeadline = durationMilliseconds(
      current.attemptDeadline,
      `Cloud Scheduler job ${current.name} attemptDeadline`,
    );
    const currentRetryConfig = zeroRetryConfig(
      current.retryConfig,
      `Cloud Scheduler job ${current.name}`,
    );
    if (
      current.name !== expected.name ||
      current.targetType !== expected.targetType ||
      currentAttemptDeadline !== expected.attemptDeadlineMilliseconds ||
      currentRetryConfig.retryCount !== expected.retryConfig.retryCount ||
      currentRetryConfig.maxRetryDurationMilliseconds !== expected.retryConfig.maxRetryDurationMilliseconds ||
      !allowedStates(expected.priorState).includes(schedulerState(current.state, `Cloud Scheduler job ${current.name} state`))
    ) {
      throw new Error(`scheduled writer drifted from the quiescence receipt: ${expected.name}`);
    }
  }
}

function assertCurrentCronJobs(
  observed: readonly { name: string; suspended: boolean }[],
  receipt: PlatformMigrationWriterReceipt,
  allowedSuspended: (prior: boolean) => readonly boolean[],
): void {
  const expected = cronJobReceipt(receipt);
  if (observed.length !== expected.length) throw new Error("Kubernetes CronJob set drifted from the quiescence receipt");
  for (let index = 0; index < expected.length; index += 1) {
    const prior = expected[index]!;
    const current = observed[index]!;
    if (current.name !== prior.name || !allowedSuspended(prior.priorSuspended).includes(current.suspended)) {
      throw new Error(`Kubernetes CronJob drifted from the quiescence receipt: ${prior.name}`);
    }
  }
}

function terminalCronJobJob(job: KubernetesCronJobJob, label: string): boolean {
  nonNegativeInteger(job.status?.succeeded ?? 0, `${label} succeeded`);
  nonNegativeInteger(job.status?.failed ?? 0, `${label} failed`);
  return (job.status?.conditions ?? []).some((condition) =>
    (condition.type === "Complete" || condition.type === "Failed") && condition.status === "True");
}

function cronJobOwner(job: KubernetesCronJobJob, name: string): string | null {
  const owners = (job.metadata?.ownerReferences ?? []).filter((owner) => owner.kind === "CronJob");
  if (owners.length === 0) return null;
  const owner = owners.length === 1 ? owners[0]?.name : null;
  if (typeof owner !== "string" || owner.length === 0) {
    throw new Error(`Kubernetes Job ${name} has an ambiguous CronJob owner`);
  }
  return owner;
}

function assertCronJobJobDrained(
  job: KubernetesCronJobJob,
  declared: ReadonlySet<string>,
): void {
  const name = job.metadata?.name;
  if (typeof name !== "string" || name.length === 0) throw new Error("Kubernetes Job has no name");
  const owner = cronJobOwner(job, name);
  if (owner === null) return;
  const active = nonNegativeInteger(job.status?.active ?? 0, `Kubernetes Job ${name} active`);
  const terminal = terminalCronJobJob(job, `Kubernetes Job ${name}`);
  if (!declared.has(owner)) {
    if (active > 0 || !terminal) throw new Error(`unknown CronJob Job can still write: ${name}`);
    return;
  }
  if (active > 0) throw new Error(`CronJob Job ${name} is still active`);
  if (!terminal) throw new Error(`CronJob Job ${name} is not terminal`);
}

function assertCronJobJobsDrained(
  jobs: readonly KubernetesCronJobJob[],
  receipt: PlatformMigrationWriterReceipt,
): void {
  const declared = new Set(cronJobReceipt(receipt).map((cronJob) => cronJob.name));
  for (const job of jobs) assertCronJobJobDrained(job, declared);
}

export function assertPlatformMigrationScheduledWritersQuiesced(
  settings: DeploymentEnvironmentSettings,
  receipt: PlatformMigrationWriterReceipt,
  schedulerJobs: readonly PlatformMigrationScheduledWriter[],
  cronJobs: readonly KubernetesCronJob[],
  cronJobJobs: readonly KubernetesCronJobJob[],
): void {
  assertScheduledWriterReceiptMatchesTarget(receipt, settings);
  assertCurrentScheduledWriters(
    selectPlatformMigrationScheduledWriters(settings, schedulerJobs),
    receipt,
    () => ["PAUSED"],
  );
  assertCurrentCronJobs(selectPlatformMigrationCronJobs(cronJobs), receipt, () => [true]);
  assertCronJobJobsDrained(cronJobJobs, receipt);
}

export function assertPlatformMigrationScheduledWritersReady(
  settings: DeploymentEnvironmentSettings,
  receipt: PlatformMigrationWriterReceipt,
  schedulerJobs: readonly PlatformMigrationScheduledWriter[],
  cronJobs: readonly KubernetesCronJob[],
): void {
  assertScheduledWriterReceiptMatchesTarget(receipt, settings);
  assertCurrentScheduledWriters(
    selectPlatformMigrationScheduledWriters(settings, schedulerJobs),
    receipt,
    (prior) => [prior],
  );
  assertCurrentCronJobs(
    selectPlatformMigrationCronJobs(cronJobs),
    receipt,
    (prior) => [prior],
  );
}

export async function waitForPlatformMigrationScheduledAttemptDrain(input: {
  attemptDeadlineMilliseconds: number;
  now(): number;
  sleep(milliseconds: number): Promise<void>;
}): Promise<void> {
  if (
    !Number.isSafeInteger(input.attemptDeadlineMilliseconds) ||
    input.attemptDeadlineMilliseconds <= 0 ||
    input.attemptDeadlineMilliseconds > PLATFORM_MIGRATION_SCHEDULER_ATTEMPT_DEADLINE_MILLISECONDS
  ) {
    throw new Error("Scheduler attempt drain requires the reviewed bounded deadline");
  }
  const startedAt = input.now();
  const drainedAt = startedAt + input.attemptDeadlineMilliseconds;
  if (!Number.isSafeInteger(drainedAt)) throw new Error("Scheduler attempt drain deadline overflowed");
  while (input.now() < drainedAt) {
    await input.sleep(drainedAt - input.now());
  }
}

export function platformMigrationScheduledAttemptDeadlineMilliseconds(
  receipt: PlatformMigrationWriterReceipt,
): number {
  return Math.max(...scheduledWriterReceipt(receipt).jobs.map((job) => job.attemptDeadlineMilliseconds));
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
    content.kind === "platform-content-migration-receipt" &&
    content.verified === true &&
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
  scheduledWriterReceipt(receipt);
  cronJobReceipt(receipt);
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
      throw new Error(`writer quiescence document has unsupported field: ${key}`);
    }
    if (typeof value !== "string" && (typeof value !== "number" || !Number.isFinite(value))) {
      throw new Error(`writer quiescence document has non-metadata field: ${key}`);
    }
  }
  if (typeof maintenance.mode !== "string" || maintenance.mode.length === 0) {
    throw new Error("writer quiescence document has no mode");
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
  scheduledWriters: PlatformMigrationScheduledWriter[];
  cronJobs: Array<{ name: string; suspended: boolean }>;
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
    scheduledWriters,
    cronJobs,
    maintenance,
    plannedReceipt,
    existing,
    receiptUri,
  } = input;
  if (existing === null) {
    await dependencies.writeReceipt(receiptUri, plannedReceipt);
  } else {
    assertReceipt(existing, args, plannedReceipt.revision);
    assertScheduledWriterReceiptMatchesTarget(existing, settings);
    if (!equal(existing.priorMaintenance, maintenance) && !equal(maintenance, frozenMaintenance())) {
      throw new Error("maintenance state drifted from the quiescence receipt");
    }
    assertCurrentWorkloads(observed, existing, (replicas) => [0, replicas]);
    assertCurrentScheduledWriters(scheduledWriters, existing, (state) => [state, "PAUSED"]);
    assertCurrentCronJobs(cronJobs, existing, (suspended) => [suspended, true]);
  }
  const activeReceipt = existing ?? plannedReceipt;
  if (!equal(maintenance, frozenMaintenance())) {
    if (!equal(maintenance, activeReceipt.priorMaintenance)) {
      throw new Error("maintenance state drifted before credential writer quiescence");
    }
    await dependencies.writeMaintenance(settings, frozenMaintenance());
  }
  const scheduled = scheduledWriterReceipt(activeReceipt);
  for (const job of scheduled.jobs) {
    const current = scheduledWriters.find((writer) => writer.name === job.name)!;
    if (current.state !== "PAUSED") await dependencies.pauseScheduledWriter(settings, job);
  }
  for (const cronJob of cronJobReceipt(activeReceipt)) {
    const current = cronJobs.find((candidate) => candidate.name === cronJob.name)!;
    if (!current.suspended) await dependencies.setCronJobSuspended(settings, cronJob, true);
  }
  await dependencies.waitForScheduledWritersQuiesced(settings, activeReceipt);
  await dependencies.waitForScheduledWriterAttemptsDrained(settings, activeReceipt);
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
  scheduledWriters: PlatformMigrationScheduledWriter[];
  cronJobs: Array<{ name: string; suspended: boolean }>;
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
    scheduledWriters,
    cronJobs,
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
  assertScheduledWriterReceiptMatchesTarget(existing, settings);
  await dependencies.assertRequiredMigrationReceipts(existing);
  await dependencies.assertMigrationActivation(existing);
  await dependencies.assertPairedCentralQuiesced(existing);
  if (!equal(maintenance, frozenMaintenance())) {
    throw new Error("restore requires the writer-quiescence maintenance state to remain frozen");
  }
  assertCurrentWorkloads(observed, existing, () => [0]);
  assertCurrentScheduledWriters(scheduledWriters, existing, () => ["PAUSED"]);
  assertCurrentCronJobs(cronJobs, existing, () => [true]);
  await dependencies.waitForWritersQuiesced(settings, existing);
  await dependencies.waitForScheduledWritersQuiesced(settings, existing);
  if (!args.apply) {
    return { mode: args.mode, receipt: receiptUri, targetId: args.targetId, writerWorkloads: existing.writerWorkloads };
  }
  for (const workload of existing.writerWorkloads) {
    await dependencies.scaleWorkload(settings, workload, workload.replicas);
  }
  await dependencies.waitForWritersReady(settings, existing);
  await dependencies.validateGiteaTokenConsumers(settings);
  for (const job of scheduledWriterReceipt(existing).jobs) {
    if (job.priorState === "ENABLED") await dependencies.resumeScheduledWriter(settings, job);
  }
  for (const cronJob of cronJobReceipt(existing)) {
    if (!cronJob.priorSuspended) await dependencies.setCronJobSuspended(settings, cronJob, false);
  }
  await dependencies.waitForScheduledWritersReady(settings, existing);
  await dependencies.writeMaintenance(settings, existing.priorMaintenance);
  return { mode: args.mode, receipt: receiptUri, targetId: args.targetId, writerWorkloads: existing.writerWorkloads };
}

export async function executePlatformMigrationWriterQuiescence(
  args: PlatformMigrationWriterQuiescenceArgs,
  dependencies: PlatformMigrationWriterQuiescenceDependencies,
): Promise<ExecutionResult> {
  await dependencies.assertReceiptStorage();
  const settings = dependencies.settingsForTarget(args.targetId);
  const observed = selectPlatformCredentialWriterWorkloads(await dependencies.readWorkloads(settings));
  const scheduledWriters = selectPlatformMigrationScheduledWriters(
    settings,
    await dependencies.readScheduledWriters(settings),
  );
  const cronJobs = selectPlatformMigrationCronJobs(await dependencies.readCronJobs(settings));
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
    scheduledWriters: {
      projectId: settings.firebaseProjectId,
      region: settings.region,
      jobs: scheduledWriters.map((job) => ({
        name: job.name,
        priorState: schedulerState(job.state, `Cloud Scheduler job ${job.name} state`),
        quiescedState: "PAUSED" as const,
        targetType: "HTTP" as const,
        attemptDeadlineMilliseconds: PLATFORM_MIGRATION_SCHEDULER_ATTEMPT_DEADLINE_MILLISECONDS,
        retryConfig: zeroRetryConfig(job.retryConfig, `Cloud Scheduler job ${job.name}`),
      })),
    },
    cronJobs: cronJobs.map((cronJob) => ({
      name: cronJob.name,
      priorSuspended: cronJob.suspended,
      quiescedSuspended: true as const,
    })),
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
      scheduledWriters,
      cronJobs,
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
    scheduledWriters,
    cronJobs,
    maintenance,
    existing,
    revision,
    receiptUri,
  });
}
