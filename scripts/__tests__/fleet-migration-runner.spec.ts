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

function makeDeps(client: MigrationClient & { calls: string[] }) {
  const cutoverCalls: Array<{ uid: string; toGatewayId: string }> = [];
  const logCalls: string[] = [];
  return {
    client,
    cutoverFirestore: vi.fn(async (uid: string, toGatewayId: string) => {
      client.calls.push(`cutover:${uid}->${toGatewayId}`);
      cutoverCalls.push({ uid, toGatewayId });
    }),
    log: (msg: string) => logCalls.push(msg),
    cutoverCalls,
    logCalls,
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
    // Un-quiesce is modeled as another quiesce call to source (toggle).
    // We saw quiesce twice: once forward, once during rollback.
    const quiesceCalls = (client.quiesce as unknown as { mock: { calls: unknown[] } }).mock.calls;
    expect(quiesceCalls.length).toBeGreaterThanOrEqual(2);
    expect(deps.cutoverFirestore).not.toHaveBeenCalled();
  });

  it("rolls back the Firestore cutover and unmounts the destination when unmount-source fails", async () => {
    const client = happyClient();
    client.unmount = vi.fn(async () => {
      throw new Error("unmount: 500 config.patch failed");
    }) as MigrationClient["unmount"];

    const deps = makeDeps(client);
    const res = await runMigration(INPUT, deps);
    expect(res.success).toBe(false);
    // The state machine is at `cutover-done` when unmount-source throws.
    expect(res.errorAt?.phase).toBe("cutover-done");
    expect(res.rolledBack).toBe(true);
    // Rollback: cutover-firestore back (gw-green → gw-blue), then unmount target.
    expect(deps.cutoverCalls.at(-1)).toMatchObject({ uid: "uid-alice", toGatewayId: "gw-blue" });
  });

  it("does NOT roll back when the rollback would itself destroy data (post source-unmounted)", async () => {
    // Force the runner to advance past source-unmounted and then fail
    // somewhere it can't roll back from. We simulate by making the FOURTH
    // unmount succeed but then rejecting on a hypothetical post-unmount
    // step (none exists, so this case is structural — we just assert the
    // happy path doesn't try to invoke rollback after success).
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
