import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FenceMismatchError, MissingRecordError } from "../../errors.js";
import type { MigrationTransferTask } from "../../migration-tasks.js";
import { createHarness, dsn, recordingListener, type PlatformStateHarness, type RecordingListener } from "./fixtures/harness.js";

const NOW = 1_762_500_000_000;
const TASK_ID = "mig_1__pre";
const CLAIM = { attempt: 1, attemptId: "attempt-1", leaseOwner: "glm-controller-0" };
const WAIT = { timeout: 20_000, interval: 20 };

function runningTask(overrides: Partial<MigrationTransferTask> = {}): MigrationTransferTask {
  return {
    id: TASK_ID,
    kind: "gateway-rsync-transfer",
    migrationId: "mig/1",
    slug: "ceckert",
    mode: "pre",
    sourceGatewayId: "shared-0",
    targetGatewayId: "walter",
    status: "running",
    attempt: 1,
    attemptId: "attempt-1",
    leaseOwner: "glm-controller-0",
    leasePod: { name: "glm-controller-0", uid: "pod-uid" },
    leaseExpiresAt: NOW + 60_000,
    leaseRestartCount: 0,
    createdAt: NOW,
    updatedAt: NOW,
    startedAt: NOW,
    completedAt: null,
    error: null,
    ...overrides,
  };
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

function changeKeys(listener: RecordingListener<"migrationTasks">): string[] {
  return listener.events
    .flatMap((event) => (event.kind === "changes" ? [...event.changes] : []))
    .map((change) => `${change.type}:${change.key}`);
}

describe.skipIf(!dsn)("PostgreSQL migration transfer tasks", { timeout: 30_000 }, () => {
  let harness: PlatformStateHarness;
  const tasks = () => harness.store.migrationTasks;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it("claims an absent task and reads it back whole, with a revision", async () => {
    await tasks().claim(runningTask(), "absent");

    expect(await tasks().get(TASK_ID)).toEqual({ ...runningTask(), revision: expect.stringMatching(/^\d+$/) });
    expect(await tasks().get("mig_2__pre")).toBeNull();
  });

  it("claims a task without a lease pod or restart count and reads them as null", async () => {
    await tasks().claim(runningTask({ leasePod: null, leaseRestartCount: null }), "absent");

    expect(await tasks().get(TASK_ID)).toEqual({ ...runningTask({ leasePod: null, leaseRestartCount: null }), revision: expect.any(String) });
  });

  it("reclaims only at the expected revision and refuses a second absent claim", async () => {
    await tasks().claim(runningTask({ leasePod: null }), "absent");
    const first = await tasks().get(TASK_ID);

    expect(await failure(tasks().claim(runningTask(), "absent"))).toMatchObject({
      constructor: FenceMismatchError,
      fence: "absent",
      expected: "absent",
      actual: first?.revision,
    });

    await tasks().claim(runningTask({ attempt: 2, attemptId: "attempt-2" }), first!.revision);
    expect(await tasks().get(TASK_ID)).toMatchObject({ attempt: 2, attemptId: "attempt-2", leasePod: { name: "glm-controller-0", uid: "pod-uid" } });

    expect(await failure(tasks().claim(runningTask({ attempt: 3 }), first!.revision))).toMatchObject({ constructor: FenceMismatchError, fence: "revision" });
    expect(await failure(tasks().claim(runningTask({ id: "mig_2__pre", migrationId: "mig/2" }), first!.revision))).toMatchObject({
      constructor: MissingRecordError,
      record: { aggregate: "migration-transfer-task", key: "mig_2__pre" },
    });
    expect((await tasks().get(TASK_ID))?.attempt).toBe(2);
  });

  it("refuses a task whose id is not derived from its migration and mode", async () => {
    expect(await failure(tasks().claim(runningTask({ id: "mig_1__final" }), "absent"))).toMatchObject({ code: "23514" });
    expect(await tasks().get("mig_1__final")).toBeNull();
  });

  it("finishes only the attempt holding the claim and drops its lease fields", async () => {
    await tasks().claim(runningTask(), "absent");

    const mismatches = await Promise.all([
      failure(tasks().finish(TASK_ID, { ...CLAIM, attemptId: "attempt-0" }, NOW + 5, null)),
      failure(tasks().finish(TASK_ID, { ...CLAIM, attempt: 2 }, NOW + 5, null)),
      failure(tasks().finish(TASK_ID, { ...CLAIM, leaseOwner: "glm-controller-1" }, NOW + 5, null)),
    ]);
    for (const mismatch of mismatches) {
      expect(mismatch).toMatchObject({ constructor: FenceMismatchError, fence: "attemptId", actual: CLAIM });
    }

    await tasks().finish(TASK_ID, CLAIM, NOW + 5, null);
    expect(await tasks().get(TASK_ID)).toEqual({
      ...runningTask(),
      status: "succeeded",
      leaseOwner: null,
      leasePod: null,
      leaseExpiresAt: null,
      leaseRestartCount: null,
      completedAt: NOW + 5,
      updatedAt: NOW + 5,
      revision: expect.any(String),
    });

    expect(await failure(tasks().finish(TASK_ID, CLAIM, NOW + 6, null))).toMatchObject({
      constructor: FenceMismatchError,
      fence: "status",
      expected: ["running"],
      actual: "succeeded",
    });
    expect(await failure(tasks().finish("mig_2__pre", CLAIM, NOW + 6, null))).toBeInstanceOf(MissingRecordError);
  });

  it("records the error of a failed attempt", async () => {
    await tasks().claim(runningTask(), "absent");
    await tasks().finish(TASK_ID, CLAIM, NOW + 5, "rsync exited 23");

    expect(await tasks().get(TASK_ID)).toMatchObject({ status: "failed", error: "rsync exited 23", completedAt: NOW + 5, leaseOwner: null });
  });

  it("finishes a contested claim exactly once", async () => {
    await tasks().claim(runningTask(), "absent");

    const results = await Promise.allSettled([tasks().finish(TASK_ID, CLAIM, NOW + 5, null), tasks().finish(TASK_ID, CLAIM, NOW + 6, "boom")]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { constructor: FenceMismatchError, fence: "status" } });
  });

  it("lists by one status or several", async () => {
    await Promise.all([tasks().claim(runningTask(), "absent"), tasks().claim(runningTask({ id: "mig_1__final", mode: "final" }), "absent")]);
    await tasks().finish("mig_1__final", CLAIM, NOW + 5, "boom");

    expect((await tasks().listByStatus(["running"])).map((task) => task.id)).toEqual([TASK_ID]);
    expect((await tasks().listByStatus(["running", "failed"])).map((task) => task.id)).toEqual(["mig_1__final", TASK_ID]);
    expect(await tasks().listByStatus(["succeeded"])).toEqual([]);
    expect(await tasks().listByStatus([])).toEqual([]);
  });

  it("watches running tasks as a snapshot and then removes a finished one", async () => {
    await tasks().claim(runningTask(), "absent");
    const running = recordingListener<"migrationTasks">();
    const all = recordingListener<"migrationTasks">();
    harness.store.watch({ aggregate: "migrationTasks", filter: { statuses: ["running"] } }, running);
    harness.store.watch({ aggregate: "migrationTasks", filter: {} }, all);

    await vi.waitFor(() => expect(running.events[0]).toMatchObject({ kind: "snapshot", records: [expect.objectContaining({ id: TASK_ID })] }), WAIT);
    await vi.waitFor(() => expect(all.events[0]).toMatchObject({ kind: "snapshot", records: [expect.objectContaining({ id: TASK_ID })] }), WAIT);
    await tasks().claim(runningTask({ id: "mig_1__final", mode: "final" }), "absent");
    await vi.waitFor(() => expect(changeKeys(running)).toEqual(["added:mig_1__final"]), WAIT);
    await tasks().finish(TASK_ID, CLAIM, NOW + 5, null);

    await vi.waitFor(() => expect(changeKeys(running)).toEqual(["added:mig_1__final", `removed:${TASK_ID}`]), WAIT);
    await vi.waitFor(() => expect(changeKeys(all)).toEqual(["added:mig_1__final", `modified:${TASK_ID}`]), WAIT);
    expect(running.errors).toEqual([]);
    expect(all.errors).toEqual([]);
  });
});
