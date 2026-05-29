import { describe, it, expect, vi } from "vitest";
import { runMigration } from "../lib/fleet-migration-runner";
import type { MigrationClient } from "../lib/fleet-migration-client";

function happyClient(): MigrationClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    quiesce: vi.fn(async ({ slug }) => {
      calls.push(`quiesce:${slug}`);
      return { migrationId: "m1", slug, drained: true, runningCount: 0 };
    }) as MigrationClient["quiesce"],
    transferState: vi.fn(async ({ slug }) => {
      calls.push(`transfer:${slug}`);
      return { migrationId: "m1", slug, imported: true };
    }) as MigrationClient["transferState"],
    unmount: vi.fn(async ({ slug }) => {
      calls.push(`unmount:${slug}`);
      return { migrationId: "m1", slug, unmounted: true };
    }) as MigrationClient["unmount"],
    calls,
  };
}

interface ReportedStep {
  name: string;
  status: "running" | "done" | "failed";
  error?: string;
}

function makeDeps(client: MigrationClient & { calls: string[] }) {
  const cutoverCalls: Array<{ uid: string; toGatewayId: string; slug: string }> = [];
  const logCalls: string[] = [];
  const reportedSteps: ReportedStep[] = [];
  return {
    client,
    cutoverFirestore: vi.fn(async (uid: string, toGatewayId: string, slug: string) => {
      client.calls.push(`cutover:${uid}->${toGatewayId}`);
      cutoverCalls.push({ uid, toGatewayId, slug });
    }),
    log: (msg: string) => logCalls.push(msg),
    reportStep: vi.fn(async (step: ReportedStep) => {
      reportedSteps.push(step);
    }),
    cutoverCalls,
    logCalls,
    reportedSteps,
  };
}

const INPUT = {
  migrationId: "m1",
  uid: "uid-alice",
  slug: "alice",
  fromGatewayId: "gw-blue",
  toGatewayId: "gw-green",
};

describe("runMigration — happy path", () => {
  it("executes all four steps in order: quiesce → transfer → cutover → unmount", async () => {
    const client = happyClient();
    const deps = makeDeps(client);
    const res = await runMigration(INPUT, deps);
    expect(res.success).toBe(true);
    expect(res.finalPhase).toBe("done");
    expect(res.rolledBack).toBe(false);
    expect(client.calls).toEqual([
      "quiesce:alice",
      "transfer:alice",
      "cutover:uid-alice->gw-green",
      "unmount:alice",
    ]);
  });

  it("logs a step-completed line for every step", async () => {
    const client = happyClient();
    const deps = makeDeps(client);
    await runMigration(INPUT, deps);
    expect(deps.logCalls.some((l) => l.includes("quiesce") && l.includes("ok"))).toBe(true);
    expect(deps.logCalls.some((l) => l.includes("transfer") && l.includes("ok"))).toBe(true);
    expect(deps.logCalls.some((l) => l.includes("cutover") && l.includes("ok"))).toBe(true);
    expect(deps.logCalls.some((l) => l.includes("unmount") && l.includes("ok"))).toBe(true);
  });

  it("emits reportStep running→done for each forward step in order", async () => {
    const client = happyClient();
    const deps = makeDeps(client);
    await runMigration(INPUT, deps);
    expect(deps.reportedSteps).toEqual([
      { name: "quiesce-source", status: "running" },
      { name: "quiesce-source", status: "done" },
      { name: "transfer-state", status: "running" },
      { name: "transfer-state", status: "done" },
      { name: "cutover-firestore", status: "running" },
      { name: "cutover-firestore", status: "done" },
      { name: "unmount-source", status: "running" },
      { name: "unmount-source", status: "done" },
    ]);
  });
});

describe("runMigration — failures", () => {
  it("aborts pre-cutover when quiesce fails — no rollback needed (source still owns)", async () => {
    const client = happyClient();
    client.quiesce = vi.fn(async () => {
      throw new Error("quiesce did not drain: 2 still running");
    }) as MigrationClient["quiesce"];

    const deps = makeDeps(client);
    const res = await runMigration(INPUT, deps);
    expect(res.success).toBe(false);
    expect(res.errorAt?.phase).toBe("initial");
    expect(res.errorAt?.error).toMatch(/did not drain/);
    expect(res.rolledBack).toBe(false);
    expect(deps.cutoverFirestore).not.toHaveBeenCalled();
    expect(client.unmount).not.toHaveBeenCalled();
  });

  it("rolls back un-quiesce when transfer fails (source-quiesced phase)", async () => {
    const client = happyClient();
    client.transferState = vi.fn(async () => {
      throw new Error("export: 503 upstream draining");
    }) as MigrationClient["transferState"];

    const deps = makeDeps(client);
    const res = await runMigration(INPUT, deps);
    expect(res.success).toBe(false);
    expect(res.errorAt?.phase).toBe("source-quiesced");
    expect(res.rolledBack).toBe(true);

const quiesceCalls = (client.quiesce as unknown as { mock: { calls: unknown[] } }).mock.calls;
    expect(quiesceCalls.length).toBeGreaterThanOrEqual(2);
    expect(deps.cutoverFirestore).not.toHaveBeenCalled();

const failed = deps.reportedSteps.find((s) => s.status === "failed");
    expect(failed?.name).toBe("transfer-state");
    expect(failed?.error).toMatch(/503/);
    const rollbackNames = deps.reportedSteps
      .filter((s) => s.name.startsWith("rollback:"))
      .map((s) => s.name);
    expect(rollbackNames).toContain("rollback:quiesce-source");
  });

  it("rolls back the Firestore cutover and unmounts the destination when unmount-source fails", async () => {
    const client = happyClient();
    client.unmount = vi.fn(async () => {
      throw new Error("unmount: 500 config.patch failed");
    }) as MigrationClient["unmount"];

    const deps = makeDeps(client);
    const res = await runMigration(INPUT, deps);
    expect(res.success).toBe(false);
    
    expect(res.errorAt?.phase).toBe("cutover-done");
    expect(res.rolledBack).toBe(true);
    
    expect(deps.cutoverCalls.at(-1)).toMatchObject({
      uid: "uid-alice",
      toGatewayId: "gw-blue",
      slug: "alice",
    });
  });

  it("does NOT roll back when the rollback would itself destroy data (post source-unmounted)", async () => {

const client = happyClient();
    const deps = makeDeps(client);
    const res = await runMigration(INPUT, deps);
    expect(res.success).toBe(true);
    expect(res.rolledBack).toBe(false);
  });

  it("treats a rollback step that itself fails as a logged warning, not a thrown error (operator-runbook situation)", async () => {
    const client = happyClient();
    let rollbackQuiesceCount = 0;
    client.quiesce = vi.fn(async () => {
      rollbackQuiesceCount++;
      if (rollbackQuiesceCount === 1) {
        return { migrationId: "m1", slug: "alice", drained: true, runningCount: 0 };
      }
      throw new Error("rollback un-quiesce failed: 500");
    }) as MigrationClient["quiesce"];
    client.transferState = vi.fn(async () => {
      throw new Error("export: 503");
    }) as MigrationClient["transferState"];

    const deps = makeDeps(client);
    const res = await runMigration(INPUT, deps);
    expect(res.success).toBe(false);
    expect(res.rolledBack).toBe(true);
    expect(
      deps.logCalls.some(
        (l) => l.includes("rollback") && l.toLowerCase().includes("warn"),
      ),
    ).toBe(true);
  });
});
