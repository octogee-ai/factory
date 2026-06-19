

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
  it("initial → seed per-customer SSH key on target", () => {
    const step = nextMigrationStep(s("initial"));
    expect(step).toEqual({
      action: "sync-state",
      mode: "keys",
      from: "gw-prod",
      to: "gw-prod-v2",
      slug: "ceckert",
    });
  });

  it("keys-synced → restore durable state on target", () => {
    const step = nextMigrationStep(s("keys-synced"));
    expect(step).toEqual({
      action: "restore-target",
      gateway: "gw-prod-v2",
      uid: "uid-ceckert",
      slug: "ceckert",
    });
  });

  it("target-restored → pre-sync state from source to target", () => {
    const step = nextMigrationStep(s("target-restored"));
    expect(step).toEqual({
      action: "sync-state",
      mode: "pre",
      from: "gw-prod",
      to: "gw-prod-v2",
      slug: "ceckert",
    });
  });

  it("pre-synced → quiesce-source on the source gateway", () => {
    const step = nextMigrationStep(s("pre-synced"));
    expect(step).toEqual({
      action: "quiesce-source",
      gateway: "gw-prod",
      slug: "ceckert",
    });
  });

  it("source-quiesced → final-sync state from source to target", () => {
    const step = nextMigrationStep(s("source-quiesced"));
    expect(step).toEqual({
      action: "sync-state",
      mode: "final",
      from: "gw-prod",
      to: "gw-prod-v2",
      slug: "ceckert",
    });
  });

  it("final-synced → verify-target", () => {
    const step = nextMigrationStep(s("final-synced"));
    expect(step).toEqual({
      action: "verify-target",
      gateway: "gw-prod-v2",
      slug: "ceckert",
    });
  });

  it("target-verified → cutover-firestore", () => {
    const step = nextMigrationStep(s("target-verified"));
    expect(step).toEqual({
      action: "cutover-firestore",
      uid: "uid-ceckert",
      from: "gw-prod",
      to: "gw-prod-v2",
    });
  });

  it("cutover-done → unmount source gateway", () => {
    const step = nextMigrationStep(s("cutover-done"));
    expect(step).toEqual({
      action: "unmount-gateway",
      role: "source",
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
    expect(advancePhase("initial")).toBe("keys-synced");
    expect(advancePhase("keys-synced")).toBe("target-restored");
    expect(advancePhase("target-restored")).toBe("pre-synced");
    expect(advancePhase("pre-synced")).toBe("source-quiesced");
    expect(advancePhase("source-quiesced")).toBe("final-synced");
    expect(advancePhase("final-synced")).toBe("target-verified");
    expect(advancePhase("target-verified")).toBe("cutover-done");
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
  it("from initial → 8 steps in canonical order", () => {
    const plan = fullPlan(s("initial"));
    expect(plan).toHaveLength(8);
    expect(plan.map((p) => p.action === "sync-state" ? `${p.mode}-sync-state` : p.action)).toEqual([
      "keys-sync-state",
      "restore-target",
      "pre-sync-state",
      "quiesce-source",
      "final-sync-state",
      "verify-target",
      "cutover-firestore",
      "unmount-gateway",
    ]);
  });

  it("from a mid-state, only emits remaining steps", () => {
    const plan = fullPlan(s("target-verified"));
    expect(plan.map((p) => p.action)).toEqual([
      "cutover-firestore",
      "unmount-gateway",
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

  it("keys-synced/target-restored/pre-synced → unmount target import; source still owns", () => {
    const plan = rollbackPlan(s("keys-synced"));
    expect(plan).toHaveLength(1);
    expect(plan[0]).toEqual({
      action: "unmount-gateway",
      role: "target",
      gateway: "gw-prod-v2",
      slug: "ceckert",
    });
    expect(rollbackPlan(s("target-restored"))).toEqual(plan);
    expect(rollbackPlan(s("pre-synced"))).toEqual(plan);
  });

  it("source-quiesced/final-synced/target-verified → unmount target import; source still owns", () => {

    for (const phase of ["source-quiesced", "final-synced", "target-verified"] as const) {
      const plan = rollbackPlan(s(phase));
      expect(plan).toEqual([
        {
          action: "unmount-gateway",
          role: "target",
          gateway: "gw-prod-v2",
          slug: "ceckert",
        },
      ]);
    }
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
        action: "unmount-gateway",
        role: "target",
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
      { action: "restore-target", gateway: "g", uid: "u", slug: "s" },
      { action: "sync-state", mode: "pre", from: "a", to: "b", slug: "s" },
      { action: "verify-target", gateway: "b", slug: "s" },
      { action: "cutover-firestore", uid: "u", from: "a", to: "b" },
      { action: "unmount-gateway", role: "source", gateway: "g", slug: "s" },
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

    const u = describeStep({
      action: "unmount-gateway",
      role: "source",
      gateway: "gw-prod",
      slug: "ceckert",
    });
    expect(u).toContain("ceckert");
    expect(u).toContain("gw-prod");
  });

  it("includes both gateway ids in sync-state description", () => {
    const t = describeStep({ action: "sync-state", mode: "pre", from: "gw-a", to: "gw-b", slug: "x" });
    expect(t).toContain("gw-a");
    expect(t).toContain("gw-b");
    expect(t).toContain("x");
  });
});
