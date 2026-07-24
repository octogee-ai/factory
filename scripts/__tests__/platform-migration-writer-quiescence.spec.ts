import { describe, expect, it } from "vitest";

import {
  executePlatformMigrationWriterQuiescence,
  assertRequiredPlatformMigrationReceipts,
  parsePlatformMigrationWriterQuiescenceArgs,
  PLATFORM_MIGRATION_WRITER_READINESS_TIMEOUT_MILLISECONDS,
  platformMigrationWriterQuiescenceConfirmation,
  PLATFORM_MIGRATION_CRONJOB_WRITERS,
  PLATFORM_MIGRATION_SCHEDULER_ATTEMPT_DEADLINE_MILLISECONDS,
  platformMigrationScheduledWriterNames,
  assertPlatformMigrationScheduledWritersQuiesced,
  selectPlatformCredentialWriterWorkloads,
  waitForPlatformMigrationWriterQuiescence,
  waitForPlatformMigrationWriterReadiness,
  waitForPlatformMigrationScheduledAttemptDrain,
} from "../lib/platform-migration-writer-quiescence.js";

const migrationId = "west-cutover-20260724";
const targetId = "test-west";
const partnerTargetId = "test-central";

const scheduledWriters = platformMigrationScheduledWriterNames("us-west1").map((name) => ({
  name,
  state: "ENABLED" as const,
  attemptDeadline: "180s",
  retryConfig: {},
  targetType: "HTTP" as const,
}));

const cronJobs = PLATFORM_MIGRATION_CRONJOB_WRITERS.map((name) => ({
  name,
  suspended: false,
}));
const migrationCronJobNames = [...PLATFORM_MIGRATION_CRONJOB_WRITERS].sort();
const sortedCronJobs = migrationCronJobNames.map((name) => ({ name, suspended: false }));

function kubernetesCronJobs(jobs: readonly { name: string; suspended: boolean }[]) {
  return jobs.map((job) => ({ metadata: { name: job.name }, spec: { suspend: job.suspended } }));
}

const writerWorkloads = [
  {
    kind: "Deployment",
    metadata: { name: "gateway-router", labels: { app: "gateway-router" } },
    spec: { replicas: 2, template: { spec: { containers: [{ name: "gateway-router" }] } } },
  },
  {
    kind: "Deployment",
    metadata: { name: "glm-controller", labels: { app: "glm-controller" } },
    spec: { replicas: 1, template: { spec: { containers: [{ name: "glm-controller" }] } } },
  },
  {
    kind: "Deployment",
    metadata: { name: "octogee-api", labels: { app: "octogee-api" } },
    spec: { replicas: 2, template: { spec: { containers: [{ name: "octogee-api" }] } } },
  },
  {
    kind: "Deployment",
    metadata: { name: "octogee-gateway-builder-ada", labels: { app: "octogee-gateway" } },
    spec: { replicas: 1, template: { spec: { containers: [{ name: "gateway" }, { name: "gateway-edge" }, { name: "provisioner" }] } } },
  },
];

const preservedWorkloads = [
  {
    kind: "Deployment",
    metadata: { name: "mattermost", labels: { app: "mattermost" } },
    spec: { replicas: 1, template: { spec: { containers: [{ name: "mattermost" }] } } },
  },
  {
    kind: "Deployment",
    metadata: { name: "octogee-gitea", labels: { app: "gitea" } },
    spec: { replicas: 1, template: { spec: { containers: [{ name: "gitea" }] } } },
  },
  {
    kind: "Deployment",
    metadata: { name: "cloud-sql-proxy", labels: { app: "cloud-sql-proxy" } },
    spec: { replicas: 1, template: { spec: { containers: [{ name: "cloud-sql-proxy" }] } } },
  },
  {
    kind: "Deployment",
    metadata: { name: "llm-broker", labels: { app: "llm-broker" } },
    spec: { replicas: 2, template: { spec: { containers: [{ name: "llm-broker" }] } } },
  },
  {
    kind: "Deployment",
    metadata: { name: "mattermost-callback-router", labels: { app: "router" } },
    spec: { replicas: 2, template: { spec: { containers: [{ name: "router" }] } } },
  },
  {
    kind: "Deployment",
    metadata: { name: "octogee-artifact-worker", labels: { app: "artifact-worker" } },
    spec: { replicas: 1, template: { spec: { containers: [{ name: "artifact-worker" }] } } },
  },
  {
    kind: "Deployment",
    metadata: { name: "octogee-ops-agent", labels: { app: "ops-agent" } },
    spec: { replicas: 1, template: { spec: { containers: [{ name: "ops-agent" }] } } },
  },
];

function args(mode: "quiesce" | "restore", apply = true) {
  const confirmation = platformMigrationWriterQuiescenceConfirmation(targetId, migrationId, mode);
  return parsePlatformMigrationWriterQuiescenceArgs([
    `--target=${targetId}`,
    `--migration-id=${migrationId}`,
    `--mode=${mode}`,
    ...(apply ? ["--apply", `--confirm=${confirmation}`] : []),
  ]);
}

function dependencies(overrides: Partial<Parameters<typeof executePlatformMigrationWriterQuiescence>[1]> = {}) {
  let receipt: unknown = null;
  let workloads = [...writerWorkloads, ...preservedWorkloads];
  let schedulerState = scheduledWriters.map((writer) => ({ ...writer }));
  let cronJobState = sortedCronJobs.map((cronJob) => ({ ...cronJob }));
  let maintenance: Record<string, unknown> | null = { mode: "open", reason: "normal operation", updatedAt: 1, updatedBy: "operator" };
  const scales: string[] = [];
  const schedulerPauses: string[] = [];
  const schedulerResumes: string[] = [];
  const cronSuspensions: string[] = [];
  const maintenanceWrites: Array<Record<string, unknown> | null> = [];
  return {
    dependencies: {
      assertExactMergedMain: async () => "a".repeat(40),
      readWorkloads: async () => workloads,
      readMaintenance: async () => maintenance,
      writeMaintenance: async (_settings: unknown, next: Record<string, unknown> | null) => {
        maintenanceWrites.push(next);
        maintenance = next;
      },
      scaleWorkload: async (_settings: unknown, workload: { kind: string; name: string }, replicas: number) => {
        scales.push(`${workload.kind}/${workload.name}=${replicas}`);
        workloads = workloads.map((current) => current.kind === workload.kind && current.metadata.name === workload.name
          ? { ...current, spec: { ...current.spec, replicas } }
          : current);
      },
      readScheduledWriters: async () => schedulerState,
      pauseScheduledWriter: async (_settings: unknown, writer: { name: string }) => {
        schedulerPauses.push(writer.name);
        schedulerState = schedulerState.map((current) => current.name === writer.name
          ? { ...current, state: "PAUSED" }
          : current);
      },
      resumeScheduledWriter: async (_settings: unknown, writer: { name: string }) => {
        schedulerResumes.push(writer.name);
        schedulerState = schedulerState.map((current) => current.name === writer.name
          ? { ...current, state: "ENABLED" }
          : current);
      },
      readCronJobs: async () => kubernetesCronJobs(cronJobState),
      readCronJobJobs: async () => [],
      setCronJobSuspended: async (_settings: unknown, cronJob: { name: string }, suspended: boolean) => {
        cronSuspensions.push(`${cronJob.name}=${suspended}`);
        cronJobState = cronJobState.map((current) => current.name === cronJob.name
          ? { ...current, suspended }
          : current);
      },
      waitForScheduledWritersQuiesced: async () => undefined,
      waitForScheduledWriterAttemptsDrained: async () => undefined,
      waitForScheduledWritersReady: async () => undefined,
      waitForWritersQuiesced: async () => undefined,
      waitForWritersReady: async () => undefined,
      readReceipt: async () => receipt as never,
      writeReceipt: async (_uri: string, next: unknown) => {
        if (receipt !== null) throw new Error("receipt already exists");
        receipt = next;
      },
      assertRequiredMigrationReceipts: async () => undefined,
      assertPairedCentralQuiesced: async () => undefined,
      settingsForTarget: () => ({ targetId, namespace: "octogee-test", region: "us-west1", firebaseProjectId: "octogee-data-test" }) as never,
      receiptUri: (next: { targetId: string; migrationId: string }) =>
        `gs://receipts/${next.migrationId}-${next.targetId}.json`,
      ...overrides,
    },
    scales,
    schedulerPauses,
    schedulerResumes,
    cronSuspensions,
    maintenanceWrites,
    getReceipt: () => receipt,
  };
}

describe("platform migration writer quiescence", () => {
  it("gives restored writers the Helm-consistent bounded ten-minute readiness window", () => {
    expect(PLATFORM_MIGRATION_WRITER_READINESS_TIMEOUT_MILLISECONDS).toBe(600_000);
  });

  it("waits the complete reviewed Scheduler attempt bound after pause", async () => {
    let clock = 12_000;
    const sleeps: number[] = [];
    await waitForPlatformMigrationScheduledAttemptDrain({
      attemptDeadlineMilliseconds: PLATFORM_MIGRATION_SCHEDULER_ATTEMPT_DEADLINE_MILLISECONDS,
      now: () => clock,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        clock += milliseconds;
      },
    });
    expect(sleeps).toEqual([180_000]);
    expect(clock).toBe(192_000);
  });

  it("rejects retrying or unbounded Scheduler attempts before freezing maintenance", async () => {
    for (const drift of [
      { retryConfig: { retryCount: 1 } },
      { retryConfig: { maxRetryDuration: "60s" } },
      { attemptDeadline: "0s" },
      { attemptDeadline: "181s" },
      { targetType: "PUBSUB" },
    ]) {
      const state = dependencies({
        readScheduledWriters: async () => [
          { ...scheduledWriters[0]!, ...drift },
          ...scheduledWriters.slice(1),
        ],
      });
      await expect(executePlatformMigrationWriterQuiescence(args("quiesce"), state.dependencies))
        .rejects.toThrow(/Scheduler|scheduled writer/i);
      expect(state.maintenanceWrites).toEqual([]);
    }
  });

  it("does not claim CronJob quiescence while an owned Job can still write", () => {
    const state = dependencies();
    return executePlatformMigrationWriterQuiescence(args("quiesce"), state.dependencies)
      .then(() => {
        expect(() => assertPlatformMigrationScheduledWritersQuiesced(
          state.dependencies.settingsForTarget(targetId),
          state.getReceipt() as never,
          scheduledWriters.map((writer) => ({ ...writer, state: "PAUSED" })),
          kubernetesCronJobs(cronJobs.map((cronJob) => ({ ...cronJob, suspended: true }))),
          [{
            metadata: {
              name: "trial-expiry-29182",
              ownerReferences: [{ kind: "CronJob", name: "trial-expiry" }],
            },
            status: { active: 1 },
          }],
        )).toThrow("still active");

        expect(() => assertPlatformMigrationScheduledWritersQuiesced(
          state.dependencies.settingsForTarget(targetId),
          state.getReceipt() as never,
          scheduledWriters.map((writer) => ({ ...writer, state: "PAUSED" })),
          kubernetesCronJobs(cronJobs.map((cronJob) => ({ ...cronJob, suspended: true }))),
          [{
            metadata: {
              name: "trial-expiry-29182",
              ownerReferences: [{ kind: "CronJob", name: "trial-expiry" }],
            },
            status: {
              active: 0,
              succeeded: 1,
              conditions: [{ type: "Complete", status: "True" }],
            },
          }],
        )).not.toThrow();
      });
  });

  it("binds both completed migration receipts to the exact writer-quiescence revision", () => {
    const receipt = {
      schemaVersion: 1 as const,
      kind: "platform-migration-writer-quiescence-receipt" as const,
      targetId,
      partnerTargetId,
      migrationId,
      revision: "a".repeat(40),
      priorMaintenance: { mode: "open" },
      writerWorkloads: selectPlatformCredentialWriterWorkloads(writerWorkloads),
    };
    const content = {
      schemaVersion: 1,
      migrationId,
      source: "test-central",
      target: "test-west",
      revision: receipt.revision,
      completedAt: "2026-07-24T00:00:00.000Z",
      services: [
        { service: "mattermost", files: { digest: "a" }, database: "mattermost_test" },
        { service: "gitea", files: { digest: "b" }, database: "gitea_test" },
      ],
    };
    const firebase = {
      schemaVersion: 1,
      kind: "platform-firestore-auth-west-migration-receipt",
      mode: "apply",
      verified: true,
      migrationId,
      sourceTargetId: "test-central",
      targetTargetId: "test-west",
      gitCommit: receipt.revision,
    };
    expect(() => assertRequiredPlatformMigrationReceipts(receipt, content, [firebase])).not.toThrow();
    expect(() => assertRequiredPlatformMigrationReceipts(receipt, { ...content, revision: "b".repeat(40) }, [firebase])).toThrow("exact completed migration");
    expect(() => assertRequiredPlatformMigrationReceipts(receipt, content, [{ ...firebase, gitCommit: "b".repeat(40) }])).toThrow("exact writer quiescence revision");
  });

  it("selects exactly credential writers and preserves durable-copy and operations workloads", () => {
    expect(selectPlatformCredentialWriterWorkloads([...writerWorkloads, ...preservedWorkloads])).toEqual([
      { kind: "Deployment", name: "gateway-router", replicas: 2, containers: ["gateway-router"] },
      { kind: "Deployment", name: "glm-controller", replicas: 1, containers: ["glm-controller"] },
      { kind: "Deployment", name: "octogee-api", replicas: 2, containers: ["octogee-api"] },
      { kind: "Deployment", name: "octogee-gateway-builder-ada", replicas: 1, containers: ["gateway", "gateway-edge", "provisioner"] },
    ]);
  });

  it("fails closed when a required static writer is missing or a writer workload is malformed", () => {
    expect(() => selectPlatformCredentialWriterWorkloads(writerWorkloads.filter((workload) => workload.metadata.name !== "octogee-api"))).toThrow("octogee-api");
    expect(() => selectPlatformCredentialWriterWorkloads([{ kind: "Job", metadata: { name: "rogue" }, spec: { template: { spec: { containers: [{ name: "gateway" }] } } } }])).toThrow("unsupported kind");
  });

  it("plans dry-run without writing receipts, maintenance, or replicas", async () => {
    const state = dependencies();
    const result = await executePlatformMigrationWriterQuiescence(args("quiesce", false), state.dependencies);
    expect(result.mode).toBe("quiesce");
    expect(state.getReceipt()).toBeNull();
    expect(state.scales).toEqual([]);
    expect(state.maintenanceWrites).toEqual([]);
    expect(state.schedulerPauses).toEqual([]);
    expect(state.cronSuspensions).toEqual([]);
  });

  it("records and pauses the declared scheduler and CronJob writer sets before claiming quiescence", async () => {
    const state = dependencies();
    await executePlatformMigrationWriterQuiescence(args("quiesce"), state.dependencies);
    expect(state.schedulerPauses).toEqual(platformMigrationScheduledWriterNames("us-west1"));
    expect(state.cronSuspensions).toEqual(migrationCronJobNames.map((name) => `${name}=true`));
    expect(state.getReceipt()).toMatchObject({
      scheduledWriters: {
        projectId: "octogee-data-test",
        region: "us-west1",
        jobs: scheduledWriters.map((writer) => ({
          name: writer.name,
          priorState: "ENABLED",
          quiescedState: "PAUSED",
          targetType: "HTTP",
          attemptDeadlineMilliseconds: 180_000,
          retryConfig: {
            retryCount: 0,
            maxRetryDurationMilliseconds: 0,
          },
        })),
      },
      cronJobs: sortedCronJobs.map((cronJob) => ({
        name: cronJob.name,
        priorSuspended: false,
        quiescedSuspended: true,
      })),
    });
  });

  it("fails closed for an unknown enabled scheduled writer before freezing maintenance", async () => {
    const state = dependencies({
      readScheduledWriters: async () => [...scheduledWriters, { name: "unreviewed-writer", state: "ENABLED" }],
    });
    await expect(executePlatformMigrationWriterQuiescence(args("quiesce"), state.dependencies))
      .rejects.toThrow("unknown enabled scheduled writer");
    expect(state.maintenanceWrites).toEqual([]);
  });

  it("fails closed for an unknown active Kubernetes CronJob before freezing maintenance", async () => {
    const state = dependencies({
      readCronJobs: async () => kubernetesCronJobs([
        ...cronJobs,
        { name: "unreviewed-writer", suspended: false },
      ]),
    });
    await expect(executePlatformMigrationWriterQuiescence(args("quiesce"), state.dependencies))
      .rejects.toThrow("unknown active Kubernetes CronJob");
    expect(state.maintenanceWrites).toEqual([]);
  });

  it("keeps maintenance frozen when scheduler pause does not verify", async () => {
    const state = dependencies({
      waitForScheduledWritersQuiesced: async () => { throw new Error("scheduled writer state did not quiesce"); },
    });
    await expect(executePlatformMigrationWriterQuiescence(args("quiesce"), state.dependencies))
      .rejects.toThrow("scheduled writer state did not quiesce");
    expect(state.maintenanceWrites.at(-1)).toEqual({
      mode: "frozen",
      managedBy: "platform-migration-writer-quiescence",
    });
  });

  it("does not stop Kubernetes writers until the Scheduler attempt window has drained", async () => {
    const state = dependencies({
      waitForScheduledWriterAttemptsDrained: async () => {
        throw new Error("Scheduler attempt drain incomplete");
      },
    });
    await expect(executePlatformMigrationWriterQuiescence(args("quiesce"), state.dependencies))
      .rejects.toThrow("Scheduler attempt drain incomplete");
    expect(state.scales).toEqual([]);
    expect(state.maintenanceWrites.at(-1)).toEqual({
      mode: "frozen",
      managedBy: "platform-migration-writer-quiescence",
    });
  });

  it("leaves a receipt and frozen maintenance when pausing a scheduled writer fails, then resumes deterministically", async () => {
    const state = dependencies();
    const pause = state.dependencies.pauseScheduledWriter;
    let calls = 0;
    state.dependencies.pauseScheduledWriter = async (settings, writer) => {
      calls += 1;
      if (calls === 2) throw new Error("Cloud Scheduler unavailable");
      await pause(settings, writer);
    };
    await expect(executePlatformMigrationWriterQuiescence(args("quiesce"), state.dependencies))
      .rejects.toThrow("Cloud Scheduler unavailable");
    expect(state.getReceipt()).not.toBeNull();
    expect(state.maintenanceWrites.at(-1)).toEqual({
      mode: "frozen",
      managedBy: "platform-migration-writer-quiescence",
    });

    state.dependencies.pauseScheduledWriter = pause;
    await executePlatformMigrationWriterQuiescence(args("quiesce"), state.dependencies);
    expect(calls).toBe(2);
    expect(state.schedulerPauses).toEqual(platformMigrationScheduledWriterNames("us-west1"));
  });

  it("resumes only previously enabled schedules after Kubernetes writers are Ready and verifies them before maintenance reopens", async () => {
    const state = dependencies({
      readScheduledWriters: async () => [
        ...scheduledWriters.slice(0, 1),
        ...scheduledWriters.slice(1).map((writer) => ({ ...writer, state: "PAUSED" })),
      ],
      readCronJobs: async () => kubernetesCronJobs([
        ...sortedCronJobs.slice(0, 1),
        ...sortedCronJobs.slice(1).map((cronJob) => ({ ...cronJob, suspended: true })),
      ]),
    });
    await executePlatformMigrationWriterQuiescence(args("quiesce"), state.dependencies);
    state.dependencies.readScheduledWriters = async () => scheduledWriters.map((writer) => ({ ...writer, state: "PAUSED" }));
    state.dependencies.readCronJobs = async () => kubernetesCronJobs(cronJobs.map((cronJob) => ({ ...cronJob, suspended: true })));
    await executePlatformMigrationWriterQuiescence(args("restore"), state.dependencies);
    expect(state.schedulerResumes).toEqual([platformMigrationScheduledWriterNames("us-west1")[0]]);
    expect(state.cronSuspensions.filter((entry) => entry.endsWith("=false"))).toEqual([`${migrationCronJobNames[0]}=false`]);
    expect(state.maintenanceWrites.at(-1)).toEqual({ mode: "open", reason: "normal operation", updatedAt: 1, updatedBy: "operator" });
  });

  it("keeps maintenance frozen on a partial scheduler resume", async () => {
    const state = dependencies();
    await executePlatformMigrationWriterQuiescence(args("quiesce"), state.dependencies);
    state.dependencies.readScheduledWriters = async () => scheduledWriters.map((writer) => ({ ...writer, state: "PAUSED" }));
    state.dependencies.readCronJobs = async () => kubernetesCronJobs(cronJobs.map((cronJob) => ({ ...cronJob, suspended: true })));
    state.dependencies.waitForScheduledWritersReady = async () => { throw new Error("scheduler resume verification failed"); };
    await expect(executePlatformMigrationWriterQuiescence(args("restore"), state.dependencies))
      .rejects.toThrow("scheduler resume verification failed");
    expect(state.maintenanceWrites.at(-1)).toEqual({
      mode: "frozen",
      managedBy: "platform-migration-writer-quiescence",
    });
  });

  it("refuses to put an unclassified maintenance field into a receipt", async () => {
    const state = dependencies({ readMaintenance: async () => ({ mode: "open", token: "never-record" }) });
    await expect(executePlatformMigrationWriterQuiescence(args("quiesce", false), state.dependencies)).rejects.toThrow("unsupported field: token");
  });

  it("does not report quiescence until fresh replicas and every writer pod are gone", async () => {
    const receipt = {
      schemaVersion: 1 as const,
      kind: "platform-migration-writer-quiescence-receipt" as const,
      targetId,
      partnerTargetId,
      migrationId,
      revision: "a".repeat(40),
      priorMaintenance: { mode: "open" },
      writerWorkloads: selectPlatformCredentialWriterWorkloads(writerWorkloads),
    };
    let reads = 0;
    await waitForPlatformMigrationWriterQuiescence({
      receipt,
      readWorkloads: async () => writerWorkloads.map((workload) => ({
        ...workload,
        spec: { ...workload.spec, replicas: 0 },
      })),
      readPods: async () => {
        reads += 1;
        return reads === 1
          ? { items: [{ metadata: { name: "gateway-still-stopping" }, status: { phase: "Succeeded" }, spec: { containers: [{ name: "gateway" }] } }] }
          : { items: [] };
      },
      now: () => 0,
      sleep: async () => undefined,
      timeoutMilliseconds: 1_000,
      pollMilliseconds: 1,
    });
    expect(reads).toBe(2);
  });

  it("fails loudly when the bounded quiescence proof cannot converge", async () => {
    const receipt = {
      schemaVersion: 1 as const,
      kind: "platform-migration-writer-quiescence-receipt" as const,
      targetId,
      partnerTargetId,
      migrationId,
      revision: "a".repeat(40),
      priorMaintenance: { mode: "open" },
      writerWorkloads: selectPlatformCredentialWriterWorkloads(writerWorkloads),
    };
    let clock = 0;
    await expect(waitForPlatformMigrationWriterQuiescence({
      receipt,
      readWorkloads: async () => writerWorkloads,
      readPods: async () => ({ items: [] }),
      now: () => clock,
      sleep: async () => { clock = 1_000; },
      timeoutMilliseconds: 1_000,
      pollMilliseconds: 1,
    })).rejects.toThrow("did not quiesce within");
  });

  it("waits for exact desired and Ready replicas plus Running/Ready writer pods", async () => {
    const receipt = {
      schemaVersion: 1 as const,
      kind: "platform-migration-writer-quiescence-receipt" as const,
      targetId,
      partnerTargetId,
      migrationId,
      revision: "a".repeat(40),
      priorMaintenance: { mode: "open" },
      writerWorkloads: selectPlatformCredentialWriterWorkloads(writerWorkloads),
    };
    let reads = 0;
    await waitForPlatformMigrationWriterReadiness({
      receipt,
      readWorkloads: async () => {
        reads += 1;
        return writerWorkloads.map((workload) => ({
          ...workload,
          status: {
            readyReplicas: reads === 1 ? 0 : workload.spec.replicas,
          },
        }));
      },
      readPods: async () => ({
        items: Array.from({ length: 6 }, (_, index) => ({
          metadata: { name: `writer-${index}` },
          spec: { containers: [{ name: index === 0 ? "gateway-router" : "gateway" }] },
          status: {
            phase: "Running",
            conditions: [{ type: "Ready", status: reads === 1 ? "False" : "True" }],
          },
        })),
      }),
      now: () => 0,
      sleep: async () => undefined,
      timeoutMilliseconds: 1_000,
      pollMilliseconds: 1,
    });
    expect(reads).toBe(2);
  });

  it("fails loudly when restored writer readiness cannot converge", async () => {
    const receipt = {
      schemaVersion: 1 as const,
      kind: "platform-migration-writer-quiescence-receipt" as const,
      targetId,
      partnerTargetId,
      migrationId,
      revision: "a".repeat(40),
      priorMaintenance: { mode: "open" },
      writerWorkloads: selectPlatformCredentialWriterWorkloads(writerWorkloads),
    };
    let clock = 0;
    await expect(waitForPlatformMigrationWriterReadiness({
      receipt,
      readWorkloads: async () => writerWorkloads.map((workload) => ({
        ...workload,
        status: { readyReplicas: 0 },
      })),
      readPods: async () => ({ items: [] }),
      now: () => clock,
      sleep: async () => { clock = 1_000; },
      timeoutMilliseconds: 1_000,
      pollMilliseconds: 1,
    })).rejects.toThrow("did not become Ready within");
  });

  it("quiesces idempotently and captures only metadata in one immutable receipt", async () => {
    const state = dependencies();
    await executePlatformMigrationWriterQuiescence(args("quiesce"), state.dependencies);
    expect(state.scales).toEqual([
      "Deployment/gateway-router=0",
      "Deployment/glm-controller=0",
      "Deployment/octogee-api=0",
      "Deployment/octogee-gateway-builder-ada=0",
    ]);
    expect(state.maintenanceWrites).toEqual([{ mode: "frozen", managedBy: "platform-migration-writer-quiescence" }]);
    expect(JSON.stringify(state.getReceipt())).not.toContain("secret");

    await executePlatformMigrationWriterQuiescence(args("quiesce"), state.dependencies);
    expect(state.scales).toHaveLength(4);
    expect(state.maintenanceWrites).toHaveLength(1);
  });

  it("leaves a resumable immutable receipt and fails loudly after a partial scale failure", async () => {
    const state = dependencies();
    const scale = state.dependencies.scaleWorkload;
    let calls = 0;
    state.dependencies.scaleWorkload = async (settings, workload, replicas) => {
      calls += 1;
      if (calls === 2) throw new Error("kubectl unavailable");
      await scale(settings, workload, replicas);
    };
    await expect(executePlatformMigrationWriterQuiescence(args("quiesce"), state.dependencies)).rejects.toThrow("kubectl unavailable");
    expect(state.getReceipt()).not.toBeNull();
    expect(state.maintenanceWrites).toEqual([{ mode: "frozen", managedBy: "platform-migration-writer-quiescence" }]);

    state.dependencies.scaleWorkload = scale;
    await executePlatformMigrationWriterQuiescence(args("quiesce"), state.dependencies);
    expect(state.scales).toEqual([
      "Deployment/gateway-router=0",
      "Deployment/glm-controller=0",
      "Deployment/octogee-api=0",
      "Deployment/octogee-gateway-builder-ada=0",
    ]);
  });

  it("restores only a matching receipt after both required migration receipts exist", async () => {
    const state = dependencies();
    await executePlatformMigrationWriterQuiescence(args("quiesce"), state.dependencies);
    await executePlatformMigrationWriterQuiescence(args("restore"), state.dependencies);
    expect(state.scales.slice(-4)).toEqual([
      "Deployment/gateway-router=2",
      "Deployment/glm-controller=1",
      "Deployment/octogee-api=2",
      "Deployment/octogee-gateway-builder-ada=1",
    ]);
    expect(state.maintenanceWrites.at(-1)).toEqual({ mode: "open", reason: "normal operation", updatedAt: 1, updatedBy: "operator" });
  });

  it("requires an all-zero and podless WEST target before restore", async () => {
    const state = dependencies();
    await executePlatformMigrationWriterQuiescence(args("quiesce"), state.dependencies);
    const scale = state.dependencies.scaleWorkload;
    await scale({} as never, { kind: "Deployment", name: "octogee-api" }, 2);

    await expect(executePlatformMigrationWriterQuiescence(args("restore"), state.dependencies))
      .rejects.toThrow("credential writer workload drifted");

    const podBlocked = dependencies({
      waitForWritersQuiesced: async () => {
        throw new Error("credential writer pods remain: stale-api");
      },
    });
    await executePlatformMigrationWriterQuiescence(args("quiesce"), {
      ...podBlocked.dependencies,
      waitForWritersQuiesced: async () => undefined,
    });
    await expect(executePlatformMigrationWriterQuiescence(args("restore"), podBlocked.dependencies))
      .rejects.toThrow("credential writer pods remain");
  });

  it("keeps maintenance frozen until every restored writer is Ready", async () => {
    const state = dependencies();
    await executePlatformMigrationWriterQuiescence(args("quiesce"), state.dependencies);
    state.dependencies.waitForWritersReady = async () => {
      throw new Error("credential writers did not become Ready");
    };

    await expect(executePlatformMigrationWriterQuiescence(args("restore"), state.dependencies))
      .rejects.toThrow("did not become Ready");
    expect(state.maintenanceWrites.at(-1)).toEqual({
      mode: "frozen",
      managedBy: "platform-migration-writer-quiescence",
    });

    await expect(executePlatformMigrationWriterQuiescence(args("restore"), state.dependencies))
      .rejects.toThrow("credential writer workload drifted");

    state.dependencies.waitForWritersReady = async () => undefined;
    await executePlatformMigrationWriterQuiescence(args("quiesce"), state.dependencies);
    await executePlatformMigrationWriterQuiescence(args("restore"), state.dependencies);
    expect(state.maintenanceWrites.at(-1)).toEqual({
      mode: "open",
      reason: "normal operation",
      updatedAt: 1,
      updatedBy: "operator",
    });
  });

  it("refuses restore for a different exact commit, target, or missing migration receipts", async () => {
    const state = dependencies();
    await executePlatformMigrationWriterQuiescence(args("quiesce"), state.dependencies);
    await expect(executePlatformMigrationWriterQuiescence(args("restore"), {
      ...state.dependencies,
      assertExactMergedMain: async () => "b".repeat(40),
    })).rejects.toThrow("exact merged commit");

    const blocked = dependencies({ assertRequiredMigrationReceipts: async () => { throw new Error("Firebase receipt missing"); } });
    await executePlatformMigrationWriterQuiescence(args("quiesce"), blocked.dependencies);
    await expect(executePlatformMigrationWriterQuiescence(args("restore"), blocked.dependencies)).rejects.toThrow("Firebase receipt missing");
  });

  it("binds scheduler state to the exact Firebase project and region in the receipt", async () => {
    const state = dependencies();
    await executePlatformMigrationWriterQuiescence(args("quiesce"), state.dependencies);
    state.dependencies.settingsForTarget = () => ({
      targetId,
      namespace: "octogee-test",
      region: "us-west1",
      firebaseProjectId: "unexpected-project",
    }) as never;
    await expect(executePlatformMigrationWriterQuiescence(args("restore"), state.dependencies))
      .rejects.toThrow("scheduled writer target drifted");
  });

  it("runs receipt and migration preconditions during restore dry-run", async () => {
    const missing = dependencies();
    await expect(executePlatformMigrationWriterQuiescence(args("restore", false), missing.dependencies)).rejects.toThrow("existing writer quiescence receipt");

    const blocked = dependencies({ assertRequiredMigrationReceipts: async () => { throw new Error("Firebase receipt missing"); } });
    await executePlatformMigrationWriterQuiescence(args("quiesce"), blocked.dependencies);
    await expect(executePlatformMigrationWriterQuiescence(args("restore", false), blocked.dependencies)).rejects.toThrow("Firebase receipt missing");
  });

  it("refuses a WEST restore when the paired CENTRAL writer set is not still frozen", async () => {
    const state = dependencies({ assertPairedCentralQuiesced: async () => { throw new Error("paired central writer is running"); } });
    await executePlatformMigrationWriterQuiescence(args("quiesce"), state.dependencies);
    await expect(executePlatformMigrationWriterQuiescence(args("restore"), state.dependencies))
      .rejects.toThrow("paired central writer is running");
  });

  it("rejects normal CENTRAL restore authority", () => {
    expect(() => parsePlatformMigrationWriterQuiescenceArgs([
      "--target=test-central",
      `--migration-id=${migrationId}`,
      "--mode=restore",
    ])).toThrow("restore supports WEST targets only");
  });

  it("requires an explicit target-scoped confirmation", () => {
    expect(() => parsePlatformMigrationWriterQuiescenceArgs([
      `--target=${targetId}`,
      `--migration-id=${migrationId}`,
      "--mode=quiesce",
      "--apply",
      "--confirm=yes",
    ])).toThrow("apply requires --confirm=");
  });
});
