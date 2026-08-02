import { describe, it, expect, vi } from "vitest";
import { runMigration, type MigrationRunnerDeps } from "./fleet-migration-runner";
import type { MigrationClient } from "./fleet-migration-client";

function happyClient(): MigrationClient & { calls: string[] } {
  const calls: string[] = [];
  return {
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
    fromGatewayId: "gw-blue",
    toGatewayId: options.toGatewayId ?? "gw-green",
    includeActivationManifest: true,
    ...(options.gateAssignment !== undefined ? { gateAssignment: options.gateAssignment } : {}),
  };
  return { client, deps, input, events, assignmentWrites };
}

describe("runMigration — happy path", () => {
  it("executes keys → pre → quiesce → final → verify → cutover → unmount with zero target restore", async () => {
    const { client, deps, input } = harness();

    const result = await runMigration(input, deps);

    expect(result).toMatchObject({ success: true, finalPhase: "done", rolledBack: false });
    expect(client.calls).toEqual([
      "transfer:alice:keys",
      "transfer:alice:pre",
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
        expect.objectContaining({
          mode: "pre",
          projectCheckoutScope,
          includeActivationManifest: false,
        }),
        expect.objectContaining({
          mode: "final",
          projectCheckoutScope,
          includeActivationManifest: true,
        }),
      ]);
    },
  );
});

describe("runMigration — failures", () => {
  it("quiesce failure FAILS the migration: rollback runs, no cutover commit", async () => {
    const client = happyClient();
    (client.quiesce as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("agents busy"));
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

  it("treats a rollback step that itself fails as a logged warning, not a thrown error", async () => {
    const client = happyClient();
    (client.verifyTarget as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("verify broke"));
    (client.unmount as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("target also broke"));
    const { deps, input, events } = harness({ client });

    const result = await runMigration(input, deps);

    expect(result).toMatchObject({ success: false, rolledBack: true });
    expect(events.some((event) => event.includes("rollback warn"))).toBe(true);
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
    (client.quiesce as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("agents busy"));
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
      if (mode === "pre") throw new Error("pre sync broke");
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
