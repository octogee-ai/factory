import { describe, it, expect, vi } from "vitest";
import { runMigration, type MigrationRunnerDeps } from "./fleet-migration-runner";
import { MigrationDrainPendingError, MigrationRpcError, type MigrationClient } from "./fleet-migration-client";

// Mirrors the pinned OpenClaw cron.migration kernel: an abort with no row for the
// operation writes an "aborted" tombstone, and any later non-abort phase for that
// operation on that gateway is refused.
function kernelScheduler() {
  const tombstones = new Set<string>();
  return vi.fn(async ({ migrationId, phase, gatewayId }: Parameters<MigrationClient["scheduler"]>[0]) => {
    const key = `${gatewayId}/${migrationId}`;
    if (phase === "abort") tombstones.add(key);
    else if (tombstones.has(key)) throw new Error(`/scheduler/${gatewayId}: 500 {"error":"scheduler migration failed","message":"Cron migration already aborted: ${migrationId}"}`);
    return { operationId: migrationId, agentIds: ["octogee-alice-coach"], phase, drained: true, snapshot: {} };
  });
}

function happyClient(): MigrationClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    scheduler: kernelScheduler(),
    schedulerReady: vi.fn(async () => undefined),
    resume: vi.fn(async () => undefined),
    restoreTarget: vi.fn(async ({ slug }) => {
      calls.push(`restore:${slug}`);
      return { migrationId: "m1", slug, restored: true, steps: ["clone-workspace-repo"] };
    }) as MigrationClient["restoreTarget"],
    quiesce: vi.fn(async ({ slug }) => {
      calls.push(`quiesce:${slug}`);
      return { migrationId: "m1", slug, drained: true, runningCount: 0 };
    }) as MigrationClient["quiesce"],
    flushGateway: vi.fn(async ({ slug, reason }) => {
      calls.push(`flush:${slug}:${reason}`);
      return { migrationId: "m1", slug, ok: true, durationMs: 1, steps: [] };
    }) as MigrationClient["flushGateway"],
    transferState: vi.fn(async ({ slug, mode }) => {
      calls.push(`transfer:${slug}:${mode ?? "default"}`);
      return { migrationId: "m1", slug, imported: true };
    }) as MigrationClient["transferState"],
    verifyTarget: vi.fn(async ({ slug }) => {
      calls.push(`verify:${slug}`);
      return {
        migrationId: "m1",
        slug,
        ready: true,
        checks: { customerDir: true, coachWired: true, mountMarked: true, accountHealthy: true },
      };
    }) as MigrationClient["verifyTarget"],
    unmount: vi.fn(async ({ gatewayId, slug }) => {
      calls.push(`unmount:${gatewayId}:${slug}`);
      return { migrationId: "m1", slug, unmounted: true };
    }) as MigrationClient["unmount"],
    calls,
  } as MigrationClient & { calls: string[] };
}

interface HarnessOptions {
  client?: MigrationClient & { calls: string[] };
  gateAssignment?: boolean;
  toGatewayId?: string;
  fromGatewayId?: string;
}

function harness(options: HarnessOptions = {}) {
  const client = options.client ?? happyClient();
  const events: string[] = [];
  const assignmentWrites: Array<{ gatewayId: string; uid: string; state: string }> = [];
  const deps: MigrationRunnerDeps = {
    client,
    commitCutover: vi.fn(async (commit) => {
      events.push(`cutover:${commit.fromGatewayId}->${commit.toGatewayId}:mirror=${commit.flipMirror}`);
    }),
    setAssignmentState: vi.fn(async (input) => {
      assignmentWrites.push(input);
      events.push(`assignment:${input.gatewayId}:${input.state}`);
    }),
    log: (msg) => events.push(`log:${msg}`),
    reportStep: vi.fn(async (step) => {
      events.push(`report:${step.name}:${step.status}`);
    }),
  };
  const input = {
    migrationId: "m1",
    uid: "uid-alice",
    slug: "alice",
    fromGatewayId: options.fromGatewayId ?? "gw-blue",
    toGatewayId: options.toGatewayId ?? "gw-green",
    includeActivationManifest: true,
    ...(options.gateAssignment !== undefined ? { gateAssignment: options.gateAssignment } : {}),
  };
  return { client, deps, input, events, assignmentWrites };
}

describe("runMigration — happy path", () => {
  it("executes keys → prepare → quiesce → final → verify → cutover → unmount with an incremental final copy and zero target restore", async () => {
    const { client, deps, input } = harness();

    const result = await runMigration(input, deps);

    expect(result).toMatchObject({ success: true, finalPhase: "done", rolledBack: false });
    expect(client.calls).toEqual([
      "transfer:alice:keys",
      "transfer:alice:pre",
      "quiesce:alice",
      "quiesce:alice",
      "flush:alice:migration-final",
      "transfer:alice:final",
      "verify:alice",
      "unmount:gw-blue:alice",
    ]);
    expect(client.restoreTarget).not.toHaveBeenCalled();
    expect(client.calls.every((call) => !/config/u.test(call))).toBe(true);
  });

  it("emits reportStep running→done for each forward step in order", async () => {
    const { deps, input, events } = harness();

    await runMigration(input, deps);

    const reports = events.filter((event) => event.startsWith("report:"));
    expect(reports).toEqual([
      "report:keys-sync-state:running", "report:keys-sync-state:done",
      "report:pre-sync-state:running", "report:pre-sync-state:done",
      "report:target-scheduler-ready:running", "report:target-scheduler-ready:done",
      "report:quiesce-source:running", "report:quiesce-source:done",
      "report:flush-source:running", "report:flush-source:done",
      "report:final-sync-state:running", "report:final-sync-state:done",
      "report:verify-target:running", "report:verify-target:done",
      "report:cutover-firestore:running", "report:cutover-firestore:done",
      "report:unmount-source:running", "report:unmount-source:done",
    ]);
  });

  it("cross-gateway cutover is ONE commit that flips the mirror; unmount comes AFTER", async () => {
    const { deps, input, events } = harness();

    await runMigration(input, deps);

    const cutoverIndex = events.indexOf("cutover:gw-blue->gw-green:mirror=true");
    const unmountReport = events.indexOf("report:unmount-source:running");
    expect(cutoverIndex).toBeGreaterThan(-1);
    expect(unmountReport).toBeGreaterThan(cutoverIndex);
  });

  it("same-gateway migration commits with NO mirror flip", async () => {
    const { deps, input, events } = harness({ toGatewayId: "gw-blue" });

    await runMigration(input, deps);

    expect(events).toContain("cutover:gw-blue->gw-blue:mirror=false");
  });

  it.each(["workspace-only", "workspace-and-projects"] as const)(
    "carries %s checkout scope through both state transfers",
    async (projectCheckoutScope) => {
      const { client, deps, input } = harness();
      input.projectCheckoutScope = projectCheckoutScope;

      await runMigration(input, deps);

      const transferCalls = (client.transferState as ReturnType<typeof vi.fn>).mock.calls;
      expect(transferCalls).toHaveLength(3);
      expect(transferCalls.map(([call]) => call)).toEqual([
        expect.objectContaining({
          mode: "keys",
          projectCheckoutScope,
          includeActivationManifest: false,
        }),
        expect.objectContaining({ mode: "pre", projectCheckoutScope, includeActivationManifest: true }),
        expect.objectContaining({
          mode: "final",
          projectCheckoutScope,
          includeActivationManifest: true,
        }),
      ]);
    },
  );
});

describe("migration preparation", () => {
  it("never fences or drains the source if destination preparation fails", async () => {
    const h = harness({ gateAssignment: true });
    vi.mocked(h.client.transferState).mockImplementation(async ({ mode, slug, migrationId }) => {
      if (mode === "pre") throw new Error("incompatible destination");
      return { migrationId, slug, imported: true };
    });
    const result = await runMigration(h.input, h.deps);
    expect(result.success).toBe(false);
    expect(h.client.quiesce).not.toHaveBeenCalled();
    expect(h.assignmentWrites).toEqual([]);
  });
});

describe("runMigration — failures", () => {
  it("quiesce failure FAILS the migration: rollback runs, no cutover commit", async () => {
    const client = happyClient();
    (client.quiesce as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ migrationId: "m1", slug: "alice", drained: true, runningCount: 0 }).mockRejectedValue(new Error("agents busy"));
    const { deps, input, events } = harness({ client });

    const result = await runMigration(input, deps);

    expect(result).toMatchObject({ success: false, rolledBack: true });
    expect(result.errorAt).toMatchObject({ phase: "pre-synced", error: "agents busy" });
    expect(events.some((event) => event.startsWith("cutover:"))).toBe(false);
    expect(events.some((event) => event.startsWith("report:rollback:"))).toBe(true);
  });

  it("keeps the durable target cutover when post-cutover source cleanup fails", async () => {
    const client = happyClient();
    (client.unmount as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("source pod gone"));
    const { deps, input, events } = harness({ client });

    const result = await runMigration(input, deps);

    expect(result).toMatchObject({ success: true, finalPhase: "done", rolledBack: false });
    expect(events).toContain("report:unmount-source:skipped");
  });

  it.each([
    ["a source eviction already holding the agent-deletion lease", '/unmount/shared-0: 500 {"error":"unmount failed","message":"[remove:alice] agents.delete failed for octogee-alice-coach (OpenClawStateLeaseError: agent deletion core:agent-deletion/octogee-alice-coach is held by 6bfbcbdf (lease epoch 1790259821898): code=OPENCLAW_STATE_LEASE_HELD)"}'],
    ["a concurrent source config write", '/unmount/shared-0: 500 {"error":"unmount failed","message":"config changed since last load; re-read and retry","code":"hash-mismatch"}'],
    ["a dropped source socket", '/unmount/shared-0: 500 {"error":"unmount failed","message":"socket closed before connect response","code":"connect-failed"}'],
  ])("leaves the committed cutover untouched when source cleanup loses to %s", async (_name, message) => {
    const client = happyClient();
    (client.unmount as ReturnType<typeof vi.fn>).mockRejectedValue(new Error(message));
    const { deps, input, events } = harness({ client });

    const result = await runMigration(input, deps);

    expect(result).toMatchObject({ success: true, finalPhase: "done", rolledBack: false });
    expect(events.filter((event) => event.startsWith("cutover:"))).toEqual(["cutover:gw-blue->gw-green:mirror=true"]);
    expect(events.some((event) => event.startsWith("report:rollback:"))).toBe(false);
    expect(events).toContain("report:unmount-source:skipped");
    expect(events.some((event) => event.startsWith("log:") && event.includes("cleanup failed after durable cutover") && event.includes(message))).toBe(true);
  });

  it("reports failed destination cleanup without claiming rollback completed", async () => {
    const client = happyClient();
    (client.verifyTarget as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("verify broke"));
    (client.unmount as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("target also broke"));
    const { deps, input, events } = harness({ client, gateAssignment: true, fromGatewayId: "shared-blue" });

    const result = await runMigration(input, deps);

    expect(result).toMatchObject({ success: false, rolledBack: false });
    expect(result.errorAt?.error).toContain("target also broke");
    expect(events).toContain("report:rollback:unmount-target:failed");
    expect(events).toContain("assignment:shared-blue:serving");
    expect(events.some((event) => event.includes("rollback warn"))).toBe(true);
  });

  it("preserves pre-quiesce source ownership when held target state prevents import and rollback cleanup", async () => {
    const client = happyClient();
    const held = "agent database files are still held open: /state/agents/octogee-alice-coach/agent/openclaw-agent.sqlite";
    (client.transferState as ReturnType<typeof vi.fn>).mockImplementation(async ({ mode }) => {
      if (mode === "pre") throw new Error(held);
      return { migrationId: "m1", slug: "alice", imported: true };
    });
    (client.unmount as ReturnType<typeof vi.fn>).mockRejectedValue(new Error(held));
    const { deps, input, events } = harness({ client, gateAssignment: true, fromGatewayId: "shared-blue" });

    const result = await runMigration(input, deps);

    expect(result).toMatchObject({ success: false, finalPhase: "keys-synced", rolledBack: false });
    expect(result.errorAt?.error).toContain(`rollback:unmount-target: ${held}`);
    expect(client.quiesce).not.toHaveBeenCalled();
    expect(client.scheduler).not.toHaveBeenCalled();
    expect(deps.commitCutover).not.toHaveBeenCalled();
    expect(events).toContain("report:rollback:unmount-target:failed");
    expect(events).not.toContain("assignment:shared-blue:quiescing");
  });
});

describe("runMigration — gated quiesce", () => {
  it("marks the assignment quiescing BEFORE the source quiesce RPC", async () => {
    const client = happyClient();
    const { deps, input, events } = harness({ client, gateAssignment: true });

    await runMigration(input, deps);

    const markIndex = events.indexOf("assignment:gw-blue:quiescing");
    const quiesceReport = events.indexOf("report:quiesce-source:done");
    expect(markIndex).toBeGreaterThan(-1);
    expect(markIndex).toBeLessThan(quiesceReport);
  });

  it("quiesce failure restores the assignment to serving on rollback", async () => {
    const client = happyClient();
    (client.quiesce as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ migrationId: "m1", slug: "alice", drained: true, runningCount: 0 }).mockRejectedValue(new Error("agents busy"));
    const { deps, input, events } = harness({ client, gateAssignment: true });

    const result = await runMigration(input, deps);

    expect(result).toMatchObject({ success: false, rolledBack: true });
    expect(events).toContain("assignment:gw-blue:quiescing");
    expect(events).toContain("assignment:gw-blue:serving");
  });

  it("flushes the source after assignment-gated quiescence and before final sync", async () => {
    const client = happyClient();
    const { deps, input, events } = harness({ client, gateAssignment: true });

    await runMigration(input, deps);

    const gate = events.indexOf("assignment:gw-blue:quiescing");
    const quiesceDone = events.indexOf("report:quiesce-source:done");
    const flushRunning = events.indexOf("report:flush-source:running");
    const finalSyncRunning = events.indexOf("report:final-sync-state:running");
    const quiesce = client.calls.indexOf("quiesce:alice");
    const flush = client.calls.indexOf("flush:alice:migration-final");
    const finalSync = client.calls.indexOf("transfer:alice:final");
    expect(gate).toBeGreaterThan(-1);
    expect(quiesceDone).toBeGreaterThan(gate);
    expect(flushRunning).toBeGreaterThan(quiesceDone);
    expect(finalSyncRunning).toBeGreaterThan(flushRunning);
    expect(quiesce).toBeGreaterThan(-1);
    expect(flush).toBeGreaterThan(quiesce);
    expect(finalSync).toBeGreaterThan(flush);
  });

  it("flush failure restores the source assignment and never starts final sync", async () => {
    const client = happyClient();
    (client.flushGateway as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("durable checkpoint unavailable"),
    );
    const { deps, input, events } = harness({ client, gateAssignment: true });

    const result = await runMigration(input, deps);

    expect(result).toMatchObject({ success: false, rolledBack: true });
    expect(result.errorAt).toMatchObject({
      phase: "source-quiesced",
      error: "durable checkpoint unavailable",
    });
    expect(client.calls).not.toContain("transfer:alice:final");
    expect(events).toContain("assignment:gw-blue:serving");
  });

  it("a pre-quiesce failure never touches roster state", async () => {
    const client = happyClient();
    (client.transferState as ReturnType<typeof vi.fn>).mockImplementation(async ({ mode }: { mode?: string }) => {
      if (mode === "keys") throw new Error("key sync broke");
      return { migrationId: "m1", slug: "alice", imported: true };
    });
    const { deps, input, assignmentWrites } = harness({ client, gateAssignment: true });

    const result = await runMigration(input, deps);

    expect(result).toMatchObject({ success: false });
    expect(assignmentWrites).toEqual([]);
  });

  it("legacy migration (no gateAssignment): no roster-state writes at all", async () => {
    const { deps, input, assignmentWrites } = harness();

    await runMigration(input, deps);

    expect(assignmentWrites).toEqual([]);
  });

  it("refuses a gated migration without setAssignmentState wired", async () => {
    const { deps, input } = harness({ gateAssignment: true });
    delete (deps as { setAssignmentState?: unknown }).setAssignmentState;

    const result = await runMigration(input, deps);

    expect(result).toMatchObject({ success: false });
    expect(result.errorAt?.error).toMatch(/setAssignmentState/u);
  });
});

it("resumes source ingress after final copy fails, and never on successful cutover", async () => {
  const failed = harness({ gateAssignment: true });
  const transfer = vi.mocked(failed.client.transferState).getMockImplementation()!;
  vi.mocked(failed.client.transferState).mockImplementationOnce(transfer).mockImplementationOnce(transfer).mockRejectedValueOnce(new Error("copy failed"));
  await runMigration(failed.input, failed.deps);
  expect(failed.client.resume).toHaveBeenCalledWith({ migrationId: "m1", gatewayId: "gw-blue", slug: "alice" });
  const success = harness({ gateAssignment: true });
  await runMigration(success.input, success.deps);
  expect(success.client.resume).not.toHaveBeenCalled();
});

it("reports source assignment publication failure after native ingress resumes", async () => {
  const h = harness({ gateAssignment: true });
  vi.mocked(h.client.quiesce).mockResolvedValueOnce({ migrationId: "m1", slug: "alice", drained: true, runningCount: 0 }).mockRejectedValueOnce(new Error("drain failed"));
  vi.mocked(h.deps.setAssignmentState!).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("restore failed"));
  await expect(runMigration(h.input, h.deps)).rejects.toThrow("restore failed");
  expect(h.client.resume).toHaveBeenCalledOnce();
  expect(h.assignmentWrites).not.toContainEqual(expect.objectContaining({ state: "serving" }));
});


describe("scheduled work handoff", () => {
  it("stages schedules before final copy and activates only after ownership cutover", async () => {
    const h = harness();
    const order: string[] = [];
    const snapshot = { version: 1, agentIds: ["octogee-alice-coach"], jobs: [] };
    Object.assign(h.client, { scheduler: vi.fn(async ({ phase, gatewayId }) => {
      order.push(`${gatewayId}:${phase}`);
      return { operationId: "m1", agentIds: snapshot.agentIds, phase, drained: true, snapshot };
    }) });
    vi.mocked(h.client.transferState).mockImplementation(async ({ mode, slug }) => {
      order.push(`copy:${mode}`);
      return { migrationId: "m1", slug, imported: true };
    });
    vi.mocked(h.deps.commitCutover).mockImplementation(async () => { order.push("cutover"); });
    vi.mocked(h.client.unmount).mockImplementation(async ({ gatewayId, slug }) => {
      order.push(`unmount:${gatewayId}`);
      return { migrationId: "m1", slug, unmounted: true };
    });
    expect(await runMigration(h.input, h.deps)).toMatchObject({ success: true });
    expect(order).toEqual([
      "copy:keys", "copy:pre", "gw-blue:export", "gw-green:stage",
      "copy:final", "cutover", "gw-blue:retire", "gw-green:activate", "unmount:gw-blue",
    ]);
  });

  it("lets the source's quiesce own the scheduler hold: no /scheduler call precedes /quiesce, and the request names the handoff", async () => {
    const h = harness();
    const order: string[] = [];
    Object.assign(h.client, { scheduler: vi.fn(async ({ phase, gatewayId, migrationId }) => {
      order.push(`${gatewayId}:${phase}`);
      if (phase === "hold") throw new Error("scheduler hold did not prove a drained matching operation");
      return { operationId: migrationId, agentIds: ["octogee-alice-coach"], phase, drained: true, snapshot: {} };
    }) });
    vi.mocked(h.client.quiesce).mockImplementation(async (request) => {
      order.push(`quiesce:${request.gatewayId}`);
      if (request.stopMattermost !== false) expect(request).toMatchObject({ schedulerHandoff: true, schedulerMigrationId: "m1" });
      return { migrationId: "m1", slug: "alice", drained: true, runningCount: 0 };
    });

    expect(await runMigration(h.input, h.deps)).toMatchObject({ success: true });
    expect(order.slice(0, 4)).toEqual(["quiesce:gw-blue", "quiesce:gw-blue", "gw-blue:export", "gw-green:stage"]);
    expect(order).not.toContain("gw-blue:hold");
  });

  it("stages beside the jobs a partial return left dormant only when the caller accepts them on the target", async () => {
    const accepting = harness();
    expect(await runMigration({ ...accepting.input, acceptRetainedTargetJobs: true }, accepting.deps)).toMatchObject({ success: true });
    const requests = vi.mocked(accepting.client.scheduler).mock.calls.map(([request]) => request);
    expect(requests.find((request) => request.phase === "stage")).toMatchObject({ gatewayId: "gw-green", retainNonportable: true });
    expect(requests.filter((request) => request.phase !== "stage").every((request) => request.retainNonportable === undefined)).toBe(true);
    expect(vi.mocked(accepting.client.quiesce).mock.calls[0][0].retainNonportable).toBeUndefined();

    const strict = harness();
    expect(await runMigration(strict.input, strict.deps)).toMatchObject({ success: true });
    expect(vi.mocked(strict.client.scheduler).mock.calls.map(([request]) => request).every((request) => request.retainNonportable === undefined)).toBe(true);
  });

  it("reports where the final sync spent its time: scheduler export, scheduler stage, and the copy", async () => {
    const h = harness();
    let clock = 0;
    h.deps.now = () => clock;
    Object.assign(h.client, { scheduler: vi.fn(async ({ phase, migrationId }) => {
      clock += phase === "export" ? 7_000 : phase === "stage" ? 4_000 : 100;
      return { operationId: migrationId, agentIds: ["octogee-alice-coach"], phase, drained: true, snapshot: {} };
    }) });
    vi.mocked(h.client.transferState).mockImplementation(async ({ mode, slug }) => {
      clock += mode === "final" ? 70_000 : 400;
      return { migrationId: "m1", slug, imported: true };
    });

    expect(await runMigration(h.input, h.deps)).toMatchObject({ success: true });

    const finalSync = h.events.find((event) => event.startsWith("log:") && event.includes("final-sync-state ok"));
    expect(finalSync).toContain("schedulerExportMs=7000");
    expect(finalSync).toContain("schedulerStageMs=4000");
    expect(finalSync).toContain("transferMs=70000");
    const keysSync = h.events.find((event) => event.startsWith("log:") && event.includes("keys-sync-state ok"));
    expect(keysSync).toContain("transferMs=400");
  });

  it("aborts destination scheduling before reopening the source after failed transfer", async () => {
    const h = harness();
    const order: string[] = [];
    Object.assign(h.client, { scheduler: vi.fn(async ({ phase, gatewayId }) => {
      order.push(`${gatewayId}:${phase}`);
      return { operationId: "m1", agentIds: ["octogee-alice-coach"], phase, drained: true, snapshot: {} };
    }) });
    vi.mocked(h.client.transferState).mockImplementation(async ({ mode, slug }) => {
      if (mode === "final") throw new Error("transfer failed");
      return { migrationId: "m1", slug, imported: true };
    });
    vi.mocked(h.client.resume).mockImplementation(async () => { order.push("source-ingress-resumed"); });
    expect(await runMigration(h.input, h.deps)).toMatchObject({ success: false, rolledBack: true });
    expect(order).toEqual([
      "gw-blue:export", "gw-green:stage", "gw-green:abort", "gw-blue:resume", "source-ingress-resumed",
    ]);
    expect(h.deps.commitCutover).not.toHaveBeenCalled();
  });
});

it("keeps post-cutover activation failures pending without reopening source", async () => {
  const h = harness();
  const scheduler = vi.mocked(h.client.scheduler).getMockImplementation()!;
  vi.mocked(h.client.scheduler).mockImplementation(async (request) => {
    if (request.phase === "activate") throw new Error("gateway unavailable");
    return scheduler(request);
  });
  const result = await runMigration(h.input, h.deps);
  expect(result).toMatchObject({ success: false, rolledBack: false, finalPhase: "cutover-done" });
  expect(result.errorAt?.error).toContain("scheduler handoff cleanup pending");
  expect(h.client.unmount).not.toHaveBeenCalled();
  expect(h.client.resume).not.toHaveBeenCalled();
});

it("does not reopen the source when target scheduler abort is unconfirmed, and says so in the failure", async () => {
  const h = harness({ gateAssignment: true });
  vi.mocked(h.client.verifyTarget).mockRejectedValue(new Error("verification failed"));
  const scheduler = vi.mocked(h.client.scheduler).getMockImplementation()!;
  vi.mocked(h.client.scheduler).mockImplementation(async (request) => {
    if (request.phase === "abort") throw new Error("abort unconfirmed");
    return scheduler(request);
  });
  const result = await runMigration(h.input, h.deps);
  expect(result).toMatchObject({ success: false, rolledBack: false });
  expect(result.errorAt?.error).toContain("verification failed");
  expect(result.errorAt?.error).toContain("abort unconfirmed");
  expect(h.client.resume).not.toHaveBeenCalled();
  expect(h.assignmentWrites).not.toContainEqual(expect.objectContaining({ state: "serving" }));
  expect(h.events).toContain("report:rollback:scheduler-abort:failed");
});

describe("rollback releases the source scheduler fence", () => {
  function heldSourceHarness() {
    const h = harness({ gateAssignment: true });
    h.deps.wait = vi.fn(async () => undefined);
    vi.mocked(h.client.quiesce).mockResolvedValueOnce({ migrationId: "m1", slug: "alice", drained: true, runningCount: 0 }).mockRejectedValue(new Error("/quiesce/gw-blue timed out after 60000ms"));
    return h;
  }

  it("retries the source scheduler resume until the fence is confirmed released", async () => {
    const h = heldSourceHarness();
    const scheduler = vi.mocked(h.client.scheduler).getMockImplementation()!;
    let resumeAttempts = 0;
    vi.mocked(h.client.scheduler).mockImplementation(async (request) => {
      if (request.phase === "resume" && request.gatewayId === "gw-blue" && ++resumeAttempts < 3) {
        throw new Error("/scheduler/gw-blue: 500 socket closed before connect response");
      }
      return scheduler(request);
    });

    const result = await runMigration(h.input, h.deps);

    expect(result).toMatchObject({ success: false, rolledBack: true });
    expect(resumeAttempts).toBe(3);
    expect(h.deps.wait).toHaveBeenCalledTimes(2);
    expect(h.client.resume).toHaveBeenCalledWith({ migrationId: "m1", gatewayId: "gw-blue", slug: "alice" });
    expect(h.events).toContain("report:rollback:scheduler-resume:done");
    expect(h.events).toContain("assignment:gw-blue:serving");
  });

  it("reports a fence it could not release as a failed rollback instead of leaving it held silently", async () => {
    const h = heldSourceHarness();
    const scheduler = vi.mocked(h.client.scheduler).getMockImplementation()!;
    vi.mocked(h.client.scheduler).mockImplementation(async (request) => {
      if (request.phase === "resume") throw new Error("/scheduler/gw-blue timed out after 60000ms");
      return scheduler(request);
    });

    const result = await runMigration(h.input, h.deps);

    expect(result).toMatchObject({ success: false, rolledBack: false });
    expect(result.errorAt?.error).toContain("/quiesce/gw-blue timed out after 60000ms");
    expect(result.errorAt?.error).toContain("scheduler fence m1 on gw-blue not released");
    expect(h.events).toContain("report:rollback:scheduler-resume:failed");
    expect(h.assignmentWrites).not.toContainEqual(expect.objectContaining({ state: "serving" }));
    expect(h.client.resume).toHaveBeenCalledTimes(1);
    expect(h.events.some((event) => event.startsWith("log:") && event.includes("❌") && event.includes("scheduler fence m1 on gw-blue not released"))).toBe(true);
  });

  it("publishes source serving only after native ingress acknowledges resumption", async () => {
    const h = heldSourceHarness();
    vi.mocked(h.client.resume).mockImplementation(async () => {
      expect(h.assignmentWrites).not.toContainEqual(expect.objectContaining({ state: "serving" }));
    });
    expect(await runMigration(h.input, h.deps)).toMatchObject({ rolledBack: true });
    expect(h.assignmentWrites.at(-1)).toMatchObject({ state: "serving" });
  });

  it("never touches the source scheduler or ingress when the failure precedes the quiesce", async () => {
    const h = harness({ gateAssignment: true });
    vi.mocked(h.client.transferState).mockImplementation(async ({ mode, slug }) => {
      if (mode === "keys") throw new Error("key sync broke");
      return { migrationId: "m1", slug, imported: true };
    });

    const result = await runMigration(h.input, h.deps);

    expect(result).toMatchObject({ success: false, rolledBack: false });
    expect(vi.mocked(h.client.scheduler).mock.calls.map(([request]) => request.phase)).not.toContain("resume");
    expect(h.client.resume).not.toHaveBeenCalled();
  });
});

describe("target scheduler readiness", () => {
  const NOT_READY = '/scheduler/gw-green: 500 {"error":"scheduler migration failed","message":"OpenClaw workspace identities are not initialized for this boot"}';
  const READY_NOT_READY = '/scheduler-ready/gw-green: 500 {"error":"scheduler readiness failed","message":"OpenClaw workspace identities are not initialized for this boot"}';

  function clockedHarness() {
    const h = harness({ gateAssignment: true });
    let clock = 0;
    h.deps.now = () => clock;
    h.deps.wait = vi.fn(async (delayMs: number) => { clock += delayMs; });
    return h;
  }

  function targetNotReadyFor(h: ReturnType<typeof harness>, notReady: (request: { phase: string; gatewayId: string }) => boolean) {
    const scheduler = vi.mocked(h.client.scheduler).getMockImplementation()!;
    vi.mocked(h.client.scheduler).mockImplementation(async (request) => {
      if (request.gatewayId === "gw-green" && notReady(request)) throw new Error(NOT_READY);
      return scheduler(request);
    });
  }

  it("sends nothing to the target's scheduler for the attempt before it stages", async () => {
    const h = harness({ gateAssignment: true });
    const calls: string[] = [];
    const scheduler = vi.mocked(h.client.scheduler).getMockImplementation()!;
    vi.mocked(h.client.scheduler).mockImplementation(async (request) => {
      calls.push(`${request.gatewayId}:${request.phase}`);
      return scheduler(request);
    });

    expect(await runMigration({ ...h.input, schedulerMigrationId: "m1:scheduler:1" }, h.deps)).toMatchObject({ success: true });

    const targetCalls = calls.filter((call) => call.startsWith("gw-green:"));
    expect(targetCalls[0]).toBe("gw-green:stage");
  });

  it("asks the target whether its scheduler is ready before fencing the source", async () => {
    const h = clockedHarness();
    let probes = 0;
    vi.mocked(h.client.schedulerReady).mockImplementation(async () => {
      if (++probes < 3) throw new Error(READY_NOT_READY);
    });

    expect(await runMigration(h.input, h.deps)).toMatchObject({ success: true });

    expect(probes).toBe(3);
    expect(h.client.schedulerReady).toHaveBeenCalledWith({ migrationId: "m1", gatewayId: "gw-green", slug: "alice" });
    const lastProbe = vi.mocked(h.client.schedulerReady).mock.invocationCallOrder[2];
    expect(lastProbe).toBeLessThan(vi.mocked(h.client.quiesce).mock.invocationCallOrder[0]);
  });

  it("proceeds without the gate when the target predates the readiness endpoint", async () => {
    const h = harness({ gateAssignment: true });
    vi.mocked(h.client.schedulerReady).mockRejectedValue(new MigrationRpcError("/scheduler-ready/gw-green: 404 Cannot POST", { status: 404 }));
    const calls: string[] = [];
    const scheduler = vi.mocked(h.client.scheduler).getMockImplementation()!;
    vi.mocked(h.client.scheduler).mockImplementation(async (request) => {
      calls.push(`${request.gatewayId}:${request.phase}`);
      return scheduler(request);
    });

    expect(await runMigration(h.input, h.deps)).toMatchObject({ success: true });

    expect(h.client.schedulerReady).toHaveBeenCalledOnce();
    expect(calls.filter((call) => call.startsWith("gw-green:"))[0]).toBe("gw-green:stage");
    expect(h.events.filter((event) => event.startsWith("log:") && event.includes("predates the scheduler readiness endpoint") && event.includes("gw-green"))).toHaveLength(1);
    expect(h.events).toContain("report:target-scheduler-ready:skipped");
  });

  it.each([401, 403])("fails the migration without fencing the source when the readiness probe is refused with %i", async (status) => {
    const h = harness({ gateAssignment: true });
    vi.mocked(h.client.schedulerReady).mockRejectedValue(new MigrationRpcError(`/scheduler-ready/gw-green: ${status} invalid signature`, { status }));

    const result = await runMigration(h.input, h.deps);

    expect(result).toMatchObject({ success: false });
    expect(result.errorAt?.error).toContain(`${status} invalid signature`);
    expect(h.client.quiesce).not.toHaveBeenCalled();
    expect(h.client.scheduler).not.toHaveBeenCalled();
  });

  it("never fences the source when the target scheduler stays unready, and fails retryably", async () => {
    const h = clockedHarness();
    vi.mocked(h.client.schedulerReady).mockRejectedValue(new Error(READY_NOT_READY));

    const result = await runMigration(h.input, h.deps);

    expect(result).toMatchObject({ success: false, rolledBack: true });
    expect(result.errorAt?.error).toMatch(/target gateway gw-green scheduler did not become ready within \d+ms/);
    expect(h.client.quiesce).not.toHaveBeenCalled();
    expect(h.client.scheduler).not.toHaveBeenCalled();
    expect(h.client.resume).not.toHaveBeenCalled();
    expect(h.assignmentWrites).toEqual([]);
    expect(h.events).toContain("report:target-scheduler-ready:failed");
    expect(h.events.some((event) => event.startsWith("report:quiesce-source"))).toBe(false);
  });

  it("waits out a target that restarts between the readiness gate and the stage", async () => {
    const h = clockedHarness();
    let stages = 0;
    targetNotReadyFor(h, ({ phase }) => phase === "stage" && ++stages < 3);

    expect(await runMigration(h.input, h.deps)).toMatchObject({ success: true });

    expect(stages).toBe(3);
  });

  it("releases the source when a stage never reached an unready target", async () => {
    const h = clockedHarness();
    let ready = true;
    targetNotReadyFor(h, ({ phase }) => {
      if (phase === "stage") ready = false;
      return !ready;
    });

    const result = await runMigration(h.input, h.deps);

    expect(result).toMatchObject({ success: false, rolledBack: true });
    expect(h.events).toContain("report:rollback:scheduler-abort:skipped");
    expect(vi.mocked(h.client.scheduler).mock.calls.map(([request]) => `${request.gatewayId}:${request.phase}`))
      .toContain("gw-blue:resume");
    expect(h.client.resume).toHaveBeenCalledWith({ migrationId: "m1", gatewayId: "gw-blue", slug: "alice" });
    expect(h.events).toContain("assignment:gw-blue:serving");
  });

  it("keeps the source closed when a stage that may have landed cannot be aborted on an unready target", async () => {
    const h = clockedHarness();
    vi.mocked(h.client.transferState).mockImplementation(async ({ mode, slug }) => {
      if (mode === "final") throw new Error("transfer failed");
      return { migrationId: "m1", slug, imported: true };
    });
    let staged = false;
    targetNotReadyFor(h, ({ phase }) => {
      if (phase === "stage") { staged = true; return false; }
      return staged;
    });

    const result = await runMigration(h.input, h.deps);

    expect(result).toMatchObject({ success: false, rolledBack: false });
    expect(result.errorAt?.error).toContain("target scheduler abort unconfirmed on gw-green, source left closed");
    expect(h.events).toContain("report:rollback:scheduler-abort:failed");
    expect(vi.mocked(h.client.scheduler).mock.calls.map(([request]) => request.phase)).not.toContain("resume");
    expect(h.client.resume).not.toHaveBeenCalled();
  });
});

describe("held Builder target", () => {
  const HELD = '/scheduler/gw-green: 500 {"error":"scheduler migration failed","message":"OpenClaw workspace identities are not initialized for this boot"}';
  const HELD_READY = '/scheduler-ready/gw-green: 500 {"error":"scheduler readiness failed","message":"OpenClaw workspace identities are not initialized for this boot"}';

  function heldHarness(options: { releasedAfterStageAttempts?: number } = {}) {
    const h = harness({ gateAssignment: true });
    let clock = 0;
    h.deps.now = () => clock;
    h.deps.wait = vi.fn(async (delayMs: number) => { clock += delayMs; });
    const order: string[] = [];
    let cutOver = false;
    let stageAttempts = 0;
    const kernel = vi.mocked(h.client.scheduler).getMockImplementation()!;
    vi.mocked(h.client.scheduler).mockImplementation(async (request) => {
      if (request.gatewayId === "gw-green") {
        const released = cutOver && (request.phase !== "stage" || ++stageAttempts >= (options.releasedAfterStageAttempts ?? 1));
        if (!released) {
          order.push(`gw-green:${request.phase}:held`);
          throw new Error(HELD);
        }
      }
      order.push(`${request.gatewayId}:${request.phase}${request.retainNonportable ? ":retain" : ""}`);
      return kernel(request);
    });
    vi.mocked(h.client.schedulerReady).mockImplementation(async () => {
      if (!cutOver) throw new Error(HELD_READY);
    });
    vi.mocked(h.client.transferState).mockImplementation(async ({ mode, slug }) => {
      order.push(`copy:${mode}`);
      return { migrationId: "m1", slug, imported: true };
    });
    vi.mocked(h.deps.commitCutover).mockImplementation(async () => { cutOver = true; order.push("cutover"); });
    vi.mocked(h.client.unmount).mockImplementation(async ({ gatewayId, slug }) => {
      order.push(`unmount:${gatewayId}`);
      return { migrationId: "m1", slug, unmounted: true };
    });
    h.deps.recordSchedulesStaged = vi.fn(async () => { order.push("staged-recorded"); });
    const input = { ...h.input, stageSchedulesAfterCutover: true, acceptRetainedTargetJobs: true };
    return { ...h, input, order };
  }

  it("exports before cutover and stages on the computer only after cutover releases it", async () => {
    const h = heldHarness();

    expect(await runMigration(h.input, h.deps)).toMatchObject({ success: true, finalPhase: "done" });

    expect(h.order).toEqual([
      "copy:keys", "copy:pre", "gw-blue:export", "copy:final", "cutover",
      "gw-green:stage:retain", "staged-recorded", "gw-blue:retire", "gw-green:activate", "unmount:gw-blue",
    ]);
    expect(h.client.schedulerReady).not.toHaveBeenCalled();
    expect(h.events.some((event) => event.startsWith("report:target-scheduler-ready"))).toBe(false);
  });

  it("waits for the released computer's OpenClaw before staging", async () => {
    const h = heldHarness({ releasedAfterStageAttempts: 4 });

    expect(await runMigration(h.input, h.deps)).toMatchObject({ success: true });

    expect(h.order.filter((call) => call === "gw-green:stage:held")).toHaveLength(3);
    expect(h.order.slice(-4)).toEqual(["staged-recorded", "gw-blue:retire", "gw-green:activate", "unmount:gw-blue"]);
  });

  it("rolls a pre-cutover failure back to the source without touching the held computer's scheduler", async () => {
    const h = heldHarness();
    vi.mocked(h.client.verifyTarget).mockRejectedValue(new Error("verify failed"));

    const result = await runMigration(h.input, h.deps);

    expect(result).toMatchObject({ success: false, rolledBack: true });
    expect(h.order.filter((call) => call.startsWith("gw-green:"))).toEqual([]);
    expect(h.order).toContain("gw-blue:resume");
    expect(h.client.resume).toHaveBeenCalledWith({ migrationId: "m1", gatewayId: "gw-blue", slug: "alice" });
    expect(h.events).toContain("assignment:gw-blue:serving");
  });

  it("keeps the source's exported copy and leaves the handoff pending when the released computer never readies", async () => {
    const h = heldHarness({ releasedAfterStageAttempts: Number.POSITIVE_INFINITY });

    const result = await runMigration(h.input, h.deps);

    expect(result).toMatchObject({ success: false, rolledBack: false, finalPhase: "cutover-done" });
    expect(result.errorAt?.error).toContain("scheduler handoff cleanup pending");
    expect(h.order).not.toContain("gw-blue:retire");
    expect(h.order).not.toContain("gw-blue:resume");
    expect(h.deps.recordSchedulesStaged).not.toHaveBeenCalled();
    expect(h.client.unmount).not.toHaveBeenCalled();
  });

  it("does not retire the source until the stage is durably recorded", async () => {
    const h = heldHarness();
    vi.mocked(h.deps.recordSchedulesStaged!).mockRejectedValue(new Error("journal unavailable"));

    const result = await runMigration(h.input, h.deps);

    expect(result).toMatchObject({ success: false, rolledBack: false });
    expect(result.errorAt?.error).toContain("scheduler handoff cleanup pending: journal unavailable");
    expect(h.order).not.toContain("gw-blue:retire");
  });

  it("refuses to start without a way to record the post-cutover stage", async () => {
    const h = heldHarness();
    delete h.deps.recordSchedulesStaged;

    await expect(runMigration(h.input, h.deps)).rejects.toThrow("recordSchedulesStaged");
    expect(h.client.transferState).not.toHaveBeenCalled();
  });
});

 it.each([false, true])("defers active coach work without discarding preparation (fenced=%s)", async (fenced) => {
  const h = harness({ gateAssignment: true });
  if (fenced) vi.mocked(h.client.quiesce).mockResolvedValueOnce({ migrationId: "m1", slug: "alice", drained: true, runningCount: 0 });
  vi.mocked(h.client.quiesce).mockRejectedValue(new MigrationDrainPendingError("coach is active"));
  expect(await runMigration(h.input, h.deps)).toMatchObject({ success: false, waitingForBuilderIdle: true, rolledBack: false });
  expect(h.client.unmount).not.toHaveBeenCalled();
  expect(h.client.flushGateway).not.toHaveBeenCalled();
  expect(h.client.resume).toHaveBeenCalled();
  expect(h.deps.commitCutover).not.toHaveBeenCalled();
  expect(h.assignmentWrites).toEqual(fenced ? [expect.objectContaining({ state: "quiescing" }), expect.objectContaining({ state: "serving" })] : []);
});
