/**
 * Tests for the fleet migration state machine.
 *
 * Pure function tests — no mocks, no Firestore, no HTTP. Coverage targets:
 *   1. Forward path: every phase emits the right step, in order.
 *   2. fullPlan from `initial` produces the canonical 4-step sequence.
 *   3. Rollback path: pre-cutover, at-cutover, post-cutover boundaries.
 *   4. The post-source-unmount rollback throws (no recovery).
 *   5. describeStep renders every action variant without crashing.
 */
import { describe, it, expect } from "vitest";
import {
  type MigrationState,
  type MigrationPhase,
  nextMigrationStep,
  advancePhase,
  fullPlan,
  rollbackPlan,
  describeStep,
} from "../lib/fleet-migration";

const baseCtx = {
  slug: "ceckert",
  uid: "uid-ceckert",
  fromGatewayId: "gw-prod",
  toGatewayId: "gw-prod-v2",
} as const;

function s(phase: MigrationPhase): MigrationState {
  return { phase, ...baseCtx };
}

describe("nextMigrationStep — forward path", () => {
  it("initial → quiesce-source on the source gateway", () => {
    const step = nextMigrationStep(s("initial"));
    expect(step).toEqual({
      action: "quiesce-source",
      gateway: "gw-prod",
      slug: "ceckert",
    });
  });

  it("source-quiesced → transfer-state from→to", () => {
    const step = nextMigrationStep(s("source-quiesced"));
    expect(step).toEqual({
      action: "transfer-state",
      from: "gw-prod",
      to: "gw-prod-v2",
      slug: "ceckert",
    });
  });

  it("state-transferred → cutover-firestore", () => {
    const step = nextMigrationStep(s("state-transferred"));
    expect(step).toEqual({
      action: "cutover-firestore",
      uid: "uid-ceckert",
      from: "gw-prod",
      to: "gw-prod-v2",
    });
  });

  it("cutover-done → unmount-source on the source gateway", () => {
    const step = nextMigrationStep(s("cutover-done"));
    expect(step).toEqual({
      action: "unmount-source",
      gateway: "gw-prod",
      slug: "ceckert",
    });
  });

  it("source-unmounted → complete", () => {
    expect(nextMigrationStep(s("source-unmounted")).action).toBe("complete");
  });

  it("done → complete (terminal idempotence)", () => {
    expect(nextMigrationStep(s("done")).action).toBe("complete");
  });
});

describe("advancePhase", () => {
  it("walks the canonical sequence", () => {
    expect(advancePhase("initial")).toBe("source-quiesced");
    expect(advancePhase("source-quiesced")).toBe("state-transferred");
    expect(advancePhase("state-transferred")).toBe("cutover-done");
    expect(advancePhase("cutover-done")).toBe("source-unmounted");
    expect(advancePhase("source-unmounted")).toBe("done");
  });

  it("done is terminal — advancing stays at done", () => {
    expect(advancePhase("done")).toBe("done");
  });

  it("throws on unknown phase", () => {
    expect(() => advancePhase("garbage" as MigrationPhase)).toThrow();
  });
});

describe("fullPlan", () => {
  it("from initial → 4 steps in canonical order", () => {
    const plan = fullPlan(s("initial"));
    expect(plan).toHaveLength(4);
    expect(plan.map((p) => p.action)).toEqual([
      "quiesce-source",
      "transfer-state",
      "cutover-firestore",
      "unmount-source",
    ]);
  });

  it("from a mid-state, only emits remaining steps", () => {
    const plan = fullPlan(s("state-transferred"));
    expect(plan.map((p) => p.action)).toEqual([
      "cutover-firestore",
      "unmount-source",
    ]);
  });

  it("from terminal state, emits no steps", () => {
    expect(fullPlan(s("source-unmounted"))).toEqual([]);
    expect(fullPlan(s("done"))).toEqual([]);
  });
});

describe("rollbackPlan — pre-cutover", () => {
  it("initial → empty (nothing to undo)", () => {
    expect(rollbackPlan(s("initial"))).toEqual([]);
  });

  it("source-quiesced → un-quiesce the source", () => {
    const plan = rollbackPlan(s("source-quiesced"));
    expect(plan).toHaveLength(1);
    expect(plan[0]).toEqual({
      action: "quiesce-source",
      gateway: "gw-prod",
      slug: "ceckert",
    });
  });

  it("state-transferred → un-quiesce (target import is leaked, caller prunes lazily)", () => {
    // Source still owns + customer data dir intact. Target has a partial
    // copy of the agent state but no Firestore flip — chat-proxy still
    // routes to source. Safe to leave target's leak for lazy GC.
    const plan = rollbackPlan(s("state-transferred"));
    expect(plan.map((p) => p.action)).toEqual(["quiesce-source"]);
  });
});

describe("rollbackPlan — post-cutover", () => {
  it("cutover-done → reverse Firestore flip + unmount target", () => {
    const plan = rollbackPlan(s("cutover-done"));
    expect(plan).toEqual([
      {
        action: "cutover-firestore",
        uid: "uid-ceckert",
        from: "gw-prod-v2", // current owner (we just flipped to it)
        to: "gw-prod", // restore source
      },
      {
        action: "unmount-source",
        gateway: "gw-prod-v2", // unmount the TARGET, not source
        slug: "ceckert",
      },
    ]);
  });
});

describe("rollbackPlan — terminal states", () => {
  it("source-unmounted throws (no recovery — source data is gone)", () => {
    expect(() => rollbackPlan(s("source-unmounted"))).toThrow(/Cannot rollback/);
  });

  it("done throws", () => {
    expect(() => rollbackPlan(s("done"))).toThrow(/Cannot rollback/);
  });
});

describe("describeStep", () => {
  it("renders every action variant non-empty", () => {
    const variants: ReturnType<typeof nextMigrationStep>[] = [
      { action: "quiesce-source", gateway: "g", slug: "s" },
      { action: "transfer-state", from: "a", to: "b", slug: "s" },
      { action: "cutover-firestore", uid: "u", from: "a", to: "b" },
      { action: "unmount-source", gateway: "g", slug: "s" },
      { action: "complete" },
    ];
    for (const v of variants) {
      const desc = describeStep(v);
      expect(desc.length).toBeGreaterThan(0);
    }
  });

  it("includes the slug + gateway in quiesce + unmount descriptions", () => {
    const q = describeStep({ action: "quiesce-source", gateway: "gw-prod", slug: "ceckert" });
    expect(q).toContain("ceckert");
    expect(q).toContain("gw-prod");

    const u = describeStep({ action: "unmount-source", gateway: "gw-prod", slug: "ceckert" });
    expect(u).toContain("ceckert");
    expect(u).toContain("gw-prod");
  });

  it("includes both gateway ids in transfer-state description", () => {
    const t = describeStep({ action: "transfer-state", from: "gw-a", to: "gw-b", slug: "x" });
    expect(t).toContain("gw-a");
    expect(t).toContain("gw-b");
    expect(t).toContain("x");
  });
});
