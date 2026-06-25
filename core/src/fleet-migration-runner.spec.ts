import { describe, it, expect, vi } from "vitest";
import { runMigration } from "./fleet-migration-runner";
import type { MigrationClient } from "./fleet-migration-client";
import type { FleetBrokerUserSnapshot } from "@octogee/shared/types/fleet-broker";

const SNAPSHOT: FleetBrokerUserSnapshot = {
  uid: "uid-alice",
  slug: "alice",
  tier: "trial",
  gatewayId: "gw-blue",
  status: "complete",
  agentIds: ["octogee-alice-coach"],
  repoUrl: "git@gitea:octogee/alice.git",
  mattermostUserId: "mm-alice",
  customerMmUserId: "mm-alice",
  greetingPosted: true,
  channels: [],
  projects: [],
  ownerName: "Alice",
  email: "alice@example.com",
  displayName: "Alice",
  lastName: "",
  photoURL: "",
  onboardingVibe: null,
  coachToken: "coach-token",
  coachMmUserId: "mm-coach",
};

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
        checks: {
          customerDir: true,
          coachWired: true,
          mountMarked: true,
          accountHealthy: true,
        },
      };
    }) as MigrationClient["verifyTarget"],
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
  restoreSnapshot: SNAPSHOT,
};

describe("runMigration — happy path", () => {
  it("executes the blue/green flow in order: keys → restore → pre-sync → quiesce → final-sync → verify → cutover → unmount", async () => {
    const client = happyClient();
    const deps = makeDeps(client);
    const res = await runMigration(INPUT, deps);
    expect(res.success).toBe(true);
    expect(res.finalPhase).toBe("done");
    expect(res.rolledBack).toBe(false);
    expect(client.calls).toEqual([
      "transfer:alice:keys",
      "restore:alice",
      "transfer:alice:pre",
      "quiesce:alice",
      "transfer:alice:final",
      "verify:alice",
      "cutover:uid-alice->gw-green",
      "unmount:alice",
    ]);
  });

  it("logs a step-completed line for every step", async () => {
    const client = happyClient();
    const deps = makeDeps(client);
    await runMigration(INPUT, deps);
    expect(deps.logCalls.some((l) => l.includes("keys-sync-state") && l.includes("ok"))).toBe(true);
    expect(deps.logCalls.some((l) => l.includes("quiesce") && l.includes("ok"))).toBe(true);
    expect(deps.logCalls.some((l) => l.includes("pre-sync-state") && l.includes("ok"))).toBe(true);
    expect(deps.logCalls.some((l) => l.includes("final-sync-state") && l.includes("ok"))).toBe(true);
    expect(deps.logCalls.some((l) => l.includes("cutover") && l.includes("ok"))).toBe(true);
    expect(deps.logCalls.some((l) => l.includes("unmount") && l.includes("ok"))).toBe(true);
  });

  it("emits reportStep running→done for each forward step in order", async () => {
    const client = happyClient();
    const deps = makeDeps(client);
    await runMigration(INPUT, deps);
    expect(deps.reportedSteps).toEqual([
      { name: "keys-sync-state", status: "running" },
      { name: "keys-sync-state", status: "done" },
      { name: "restore-target", status: "running" },
      { name: "restore-target", status: "done" },
      { name: "pre-sync-state", status: "running" },
      { name: "pre-sync-state", status: "done" },
      { name: "quiesce-source", status: "running" },
      { name: "quiesce-source", status: "done" },
      { name: "final-sync-state", status: "running" },
      { name: "final-sync-state", status: "done" },
      { name: "verify-target", status: "running" },
      { name: "verify-target", status: "done" },
      { name: "cutover-firestore", status: "running" },
      { name: "cutover-firestore", status: "done" },
      { name: "unmount-source", status: "running" },
      { name: "unmount-source", status: "done" },
    ]);
  });
});

describe("runMigration — failures", () => {
  it("cleans up the pre-synced target when quiesce fails — source still owns", async () => {
    const client = happyClient();
    client.quiesce = vi.fn(async () => {
      throw new Error("quiesce did not drain: 2 still running");
    }) as MigrationClient["quiesce"];

    const deps = makeDeps(client);
    const res = await runMigration(INPUT, deps);
    expect(res.success).toBe(false);
    expect(res.errorAt?.phase).toBe("pre-synced");
    expect(res.errorAt?.error).toMatch(/did not drain/);
    expect(res.rolledBack).toBe(true);
    expect(deps.cutoverFirestore).not.toHaveBeenCalled();
    expect(client.unmount).toHaveBeenCalledWith(
      expect.objectContaining({ gatewayId: "gw-green", slug: "alice" }),
    );
  });

  it("cleans up the target import when final sync fails (source-quiesced phase)", async () => {
    const client = happyClient();
    let transferCount = 0;
    client.transferState = vi.fn(async ({ migrationId, slug }) => {
      transferCount++;
      if (transferCount === 3) throw new Error("export: 503 upstream draining");
      return { migrationId, slug, imported: true };
    }) as MigrationClient["transferState"];

    const deps = makeDeps(client);
    const res = await runMigration(INPUT, deps);
    expect(res.success).toBe(false);
    expect(res.errorAt?.phase).toBe("source-quiesced");
    expect(res.rolledBack).toBe(true);

    expect(deps.cutoverFirestore).not.toHaveBeenCalled();
    expect(client.unmount).toHaveBeenCalledWith(
      expect.objectContaining({ gatewayId: "gw-green", slug: "alice" }),
    );

const failed = deps.reportedSteps.find((s) => s.status === "failed");
    expect(failed?.name).toBe("final-sync-state");
    expect(failed?.error).toMatch(/503/);
    const rollbackNames = deps.reportedSteps
      .filter((s) => s.name.startsWith("rollback:"))
      .map((s) => s.name);
    expect(rollbackNames).toContain("rollback:unmount-target");
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
    let transferCount = 0;
    client.transferState = vi.fn(async ({ migrationId, slug }) => {
      transferCount++;
      if (transferCount === 3) throw new Error("export: 503");
      return { migrationId, slug, imported: true };
    }) as MigrationClient["transferState"];
    client.unmount = vi.fn(async () => {
      throw new Error("rollback target cleanup failed: 500");
    }) as MigrationClient["unmount"];

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

describe("runMigration — disposable source (blue/green roll): source-side steps degrade, never veto", () => {
  it("unmount-source failure does NOT roll back — the customer is already cut over to the target", async () => {
    const client = happyClient();
    client.unmount = vi.fn(async () => {
      throw new Error("rate limit exceeded for config.patch; retry after 16s");
    }) as MigrationClient["unmount"];
    const deps = makeDeps(client);

    const res = await runMigration({ ...INPUT, sourceDisposable: true }, deps);

    expect(res.success).toBe(true);
    expect(res.rolledBack).toBe(false);
    // cutover committed and NOT undone
    expect(client.calls).toContain("cutover:uid-alice->gw-green");
    expect(deps.reportedSteps).toContainEqual(
      expect.objectContaining({ name: "unmount-source", status: "failed" }),
    );
    expect(
      deps.logCalls.some((l) => l.includes("best-effort") && l.includes("disposable source")),
    ).toBe(true);
  });

  it("a source step failure pre-cutover (quiesce-source) degrades to the substrate baseline and still cuts over", async () => {
    const client = happyClient();
    client.quiesce = vi.fn(async () => {
      throw new Error("quiesce: source pod already gone");
    }) as MigrationClient["quiesce"];
    const deps = makeDeps(client);

    const res = await runMigration({ ...INPUT, sourceDisposable: true }, deps);

    expect(res.success).toBe(true);
    expect(res.rolledBack).toBe(false);
    expect(client.calls).toContain("verify:alice"); // strict target steps still ran
    expect(client.calls).toContain("cutover:uid-alice->gw-green");
  });

  it("a TARGET step (restore-target) still fails strictly — never cut over to a target we couldn't set up", async () => {
    const client = happyClient();
    client.restoreTarget = vi.fn(async () => {
      throw new Error("restore failed: gitea-broker 403");
    }) as MigrationClient["restoreTarget"];
    const deps = makeDeps(client);

    const res = await runMigration({ ...INPUT, sourceDisposable: true }, deps);

    expect(res.success).toBe(false);
    expect(client.calls).not.toContain("cutover:uid-alice->gw-green");
  });

  it("WITHOUT sourceDisposable (cross-pool migrate, source survives), an unmount-source failure still rolls back — strict contract preserved", async () => {
    const client = happyClient();
    client.unmount = vi.fn(async () => {
      throw new Error("unmount failed");
    }) as MigrationClient["unmount"];
    const deps = makeDeps(client);

    const res = await runMigration(INPUT, deps); // no sourceDisposable

    expect(res.success).toBe(false);
  });
});
