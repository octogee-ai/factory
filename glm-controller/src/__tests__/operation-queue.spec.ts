import { describe, expect, it } from "vitest";
import {
  decideOperationClaim,
  findRunningRolloutParentOperationId,
  findSerialConflict,
  isSeriallyExclusiveKind,
} from "../operation-queue";

describe("findRunningRolloutParentOperationId", () => {
  it("finds the rollout document that owns a gateway's release roll", () => {
    expect(findRunningRolloutParentOperationId("default", [
      { id: "other", kind: "migrate-customer", input: { toGatewayId: "default" } },
      { id: "rollout-document", kind: "rollout", input: { gatewayId: "default" } },
    ])).toBe("rollout-document");
  });

  it("rejects an impossible ambiguous parent instead of guessing", () => {
    expect(() => findRunningRolloutParentOperationId("default", [
      { id: "rollout-a", kind: "rollout", input: { gatewayId: "default" } },
      { id: "rollout-b", kind: "rollout", input: { fromGatewayId: "default" } },
    ])).toThrow("multiple running rollout operations target gateway default");
  });
});

describe("isSeriallyExclusiveKind", () => {
  it("treats rollout as globally serial — one blue/green plane at a time", () => {
    expect(isSeriallyExclusiveKind("rollout")).toBe(true);
  });

  it("treats migrate-customer as serial per migration target", () => {
    expect(isSeriallyExclusiveKind("migrate-customer")).toBe(true);
  });

  it("does not restrict kinds with no known hard-fail-on-busy path", () => {
    expect(isSeriallyExclusiveKind("retire-gateway")).toBe(false);
    expect(isSeriallyExclusiveKind("recycle-gateway")).toBe(false);
    expect(isSeriallyExclusiveKind("add-gateway")).toBe(false);
    expect(isSeriallyExclusiveKind("restart-gateway")).toBe(false);
    expect(isSeriallyExclusiveKind("deprovision-customer")).toBe(false);
  });
});

describe("findSerialConflict — rollout (global scope)", () => {
  it("returns null when the candidate's kind isn't serially exclusive", () => {
    const conflict = findSerialConflict(
      { id: "op-2", kind: "retire-gateway" },
      [{ id: "op-1", kind: "retire-gateway", input: { gatewayId: "bender-blue" } }],
    );
    expect(conflict).toBeNull();
  });

  it("returns null when no other op of the same kind is running", () => {
    const conflict = findSerialConflict({ id: "op-2", kind: "rollout" }, []);
    expect(conflict).toBeNull();
  });

  it("flags a conflict against another running rollout and names the rolling gateway", () => {
    const conflict = findSerialConflict(
      { id: "op-2", kind: "rollout" },
      [{ id: "op-1", kind: "rollout", input: { gatewayId: "bender-blue" } }],
    );
    expect(conflict).toEqual({
      conflictingOpId: "op-1",
      waitingOn: "roll bender-blue",
    });
  });

  it("never conflicts with itself (a doc can't be its own running blocker)", () => {
    const conflict = findSerialConflict(
      { id: "op-1", kind: "rollout" },
      [{ id: "op-1", kind: "rollout", input: { gatewayId: "bender-blue" } }],
    );
    expect(conflict).toBeNull();
  });

  it("falls back to a generic description when the running op has no gatewayId", () => {
    const conflict = findSerialConflict(
      { id: "op-2", kind: "rollout" },
      [{ id: "op-1", kind: "rollout", input: {} }],
    );
    expect(conflict).toEqual({
      conflictingOpId: "op-1",
      waitingOn: "another rollout operation",
    });
  });

  it("two rollout ops for DIFFERENT gateways still conflict — the plane is global, not per-gateway", () => {
    const conflict = findSerialConflict(
      { id: "op-2", kind: "rollout", input: { gatewayId: "default-green" } },
      [{ id: "op-1", kind: "rollout", input: { gatewayId: "bender-blue" } }],
    );
    expect(conflict?.conflictingOpId).toBe("op-1");
  });
});

describe("findSerialConflict — migrate-customer (per-target scope)", () => {
  it("conflicts with another running migration to the SAME target", () => {
    const conflict = findSerialConflict(
      { id: "op-2", kind: "migrate-customer", input: { toGatewayId: "bender-green" } },
      [
        {
          id: "op-1",
          kind: "migrate-customer",
          input: { fromGatewayId: "bender-blue", toGatewayId: "bender-green" },
        },
      ],
    );
    expect(conflict).toEqual({
      conflictingOpId: "op-1",
      waitingOn: "migration bender-blue → bender-green",
    });
  });

  it("does NOT conflict with a running migration to a DIFFERENT target", () => {
    const conflict = findSerialConflict(
      { id: "op-2", kind: "migrate-customer", input: { toGatewayId: "gw-purple" } },
      [{ id: "op-1", kind: "migrate-customer", input: { toGatewayId: "gw-green" } }],
    );
    expect(conflict).toBeNull();
  });

  it("conflicts with another migration sharing the source even when targets differ", () => {
    const conflict = findSerialConflict(
      {
        id: "op-2",
        kind: "migrate-customer",
        input: { fromGatewayId: "source", toGatewayId: "target-b" },
      },
      [{
        id: "op-1",
        kind: "migrate-customer",
        input: { fromGatewayId: "source", toGatewayId: "target-a" },
      }],
    );
    expect(conflict?.conflictingOpId).toBe("op-1");
  });

  it("never conflicts when the candidate has no toGatewayId — its own validation failure stops it, not the queue", () => {
    const conflict = findSerialConflict(
      { id: "op-2", kind: "migrate-customer", input: {} },
      [{ id: "op-1", kind: "migrate-customer", input: { toGatewayId: "gw-green" } }],
    );
    expect(conflict).toBeNull();
  });

  it("describes a target-only migration without a fromGatewayId", () => {
    const conflict = findSerialConflict(
      { id: "op-2", kind: "migrate-customer", input: { toGatewayId: "gw-green" } },
      [{ id: "op-1", kind: "migrate-customer", input: { toGatewayId: "gw-green" } }],
    );
    expect(conflict).toEqual({
      conflictingOpId: "op-1",
      waitingOn: "migration → gw-green",
    });
  });
});

describe("findSerialConflict — shared migration/release-roll scope", () => {
  it("queues a migration that shares a gateway with a running rollout — no lineage exemption", () => {
    const decision = decideOperationClaim({
      op: {
        id: "migration",
        kind: "migrate-customer",
        status: "pending",
        createdAt: 2,
        input: {
          fromGatewayId: "default",
          toGatewayId: "other",
          parentOperationId: "rollout-document",
        },
      },
      now: 1_000,
      runningOpsSameKind: [{
        id: "rollout-document",
        kind: "rollout",
        input: { gatewayId: "default" },
      }],
      pendingOpsSameKind: [],
    });

    expect(decision).toEqual({ outcome: "queue", waitingOn: "roll default" });
  });

  it.each(["source", "target"])(
    "queues a release roll that begins on the migration %s gateway",
    (gatewayId) => {
      const conflict = findSerialConflict(
        { id: "roll", kind: "rollout", input: { gatewayId } },
        [{
          id: "migration",
          kind: "migrate-customer",
          input: { fromGatewayId: "source", toGatewayId: "target" },
        }],
      );
      expect(conflict?.conflictingOpId).toBe("migration");
    },
  );

  it.each(["source", "target"])(
    "queues a migration that begins while its %s gateway is rolling",
    (gatewayId) => {
      const conflict = findSerialConflict(
        {
          id: "migration",
          kind: "migrate-customer",
          input: { fromGatewayId: "source", toGatewayId: "target" },
        },
        [{ id: "roll", kind: "rollout", input: { gatewayId } }],
      );
      expect(conflict?.conflictingOpId).toBe("roll");
    },
  );

  it("uses durable revision bindings while a migration is retrying", () => {
    const conflict = findSerialConflict(
      { id: "roll", kind: "rollout", input: { gatewayId: "source" } },
      [{
        id: "migration",
        kind: "migrate-customer",
        input: { toGatewayId: "target" },
        customerMigrationV2: {
          sourceGatewayId: "source",
          sourceRevisionId: "source-r2",
          targetGatewayId: "target",
          targetRevisionId: "target-r4",
        } as never,
      }],
    );
    expect(conflict?.conflictingOpId).toBe("migration");
  });
});

describe("decideOperationClaim", () => {
  const now = 1_000_000;

  it("skips a doc that is no longer pending (already claimed by another process)", () => {
    const decision = decideOperationClaim({
      op: { id: "op-1", kind: "rollout", status: "running", createdAt: 1 },
      now,
      runningOpsSameKind: [],
      pendingOpsSameKind: [],
    });
    expect(decision).toEqual({ outcome: "skip" });
  });

  it("skips a pending op whose backoff window hasn't elapsed yet", () => {
    const decision = decideOperationClaim({
      op: { id: "op-1", kind: "rollout", status: "pending", createdAt: 1, nextAttemptAt: now + 5_000 },
      now,
      runningOpsSameKind: [],
      pendingOpsSameKind: [],
    });
    expect(decision).toEqual({ outcome: "skip" });
  });

  it("claims a pending op whose backoff window has elapsed", () => {
    const decision = decideOperationClaim({
      op: { id: "op-1", kind: "rollout", status: "pending", createdAt: 1, nextAttemptAt: now - 1 },
      now,
      runningOpsSameKind: [],
      pendingOpsSameKind: [],
    });
    expect(decision).toEqual({ outcome: "claim" });
  });

  it("claims a pending op with no conflict and no backoff", () => {
    const decision = decideOperationClaim({
      op: { id: "op-2", kind: "rollout", status: "pending", createdAt: 1 },
      now,
      runningOpsSameKind: [],
      pendingOpsSameKind: [],
    });
    expect(decision).toEqual({ outcome: "claim" });
  });

  it("queues instead of failing when a conflicting rollout is running", () => {
    const decision = decideOperationClaim({
      op: { id: "op-2", kind: "rollout", status: "pending", createdAt: 2 },
      now,
      runningOpsSameKind: [
        { id: "op-1", kind: "rollout", input: { gatewayId: "bender-blue" } },
      ],
      pendingOpsSameKind: [],
    });
    expect(decision).toEqual({
      outcome: "queue",
      waitingOn: "roll bender-blue",
    });
  });

  it("claims kinds with no known hard-fail-on-busy path even when others of the same kind are running", () => {
    const decision = decideOperationClaim({
      op: { id: "op-2", kind: "retire-gateway", status: "pending", createdAt: 2 },
      now,
      runningOpsSameKind: [{ id: "op-1", kind: "retire-gateway", input: { gatewayId: "bender-green" } }],
      pendingOpsSameKind: [],
    });
    expect(decision).toEqual({ outcome: "claim" });
  });

  it("queues a migrate-customer op behind another one targeting the same gateway", () => {
    const decision = decideOperationClaim({
      op: {
        id: "op-2",
        kind: "migrate-customer",
        status: "pending",
        createdAt: 2,
        input: { toGatewayId: "gw-green" },
      },
      now,
      runningOpsSameKind: [
        { id: "op-1", kind: "migrate-customer", input: { toGatewayId: "gw-green" } },
      ],
      pendingOpsSameKind: [],
    });
    expect(decision).toEqual({ outcome: "queue", waitingOn: "migration → gw-green" });
  });

  it("claims a migrate-customer op whose target differs from the running one", () => {
    const decision = decideOperationClaim({
      op: {
        id: "op-2",
        kind: "migrate-customer",
        status: "pending",
        createdAt: 2,
        input: { toGatewayId: "gw-purple" },
      },
      now,
      runningOpsSameKind: [
        { id: "op-1", kind: "migrate-customer", input: { toGatewayId: "gw-green" } },
      ],
      pendingOpsSameKind: [],
    });
    expect(decision).toEqual({ outcome: "claim" });
  });
});

describe("decideOperationClaim — FIFO per scope (an older pending op blocks a newer claimer)", () => {
  const now = 1_000_000;

  it("queues behind an OLDER same-scope pending rollout even when nothing is running — the fast path must not let a newcomer jump the queue", () => {
    const decision = decideOperationClaim({
      op: { id: "op-new", kind: "rollout", status: "pending", createdAt: 3 },
      now,
      runningOpsSameKind: [],
      pendingOpsSameKind: [
        { id: "op-old", kind: "rollout", createdAt: 2, input: { gatewayId: "bender-blue" } },
      ],
    });
    expect(decision).toEqual({
      outcome: "queue",
      waitingOn: "roll bender-blue",
    });
  });

  it("claims when the other same-scope pending op is NEWER (this op is the head of the queue)", () => {
    const decision = decideOperationClaim({
      op: { id: "op-old", kind: "rollout", status: "pending", createdAt: 2 },
      now,
      runningOpsSameKind: [],
      pendingOpsSameKind: [
        { id: "op-new", kind: "rollout", createdAt: 3, input: { gatewayId: "default-green" } },
      ],
    });
    expect(decision).toEqual({ outcome: "claim" });
  });

  it("tiebreaks equal createdAt by op id so exactly one of the two claims", () => {
    const blocked = decideOperationClaim({
      op: { id: "op-b", kind: "rollout", status: "pending", createdAt: 2 },
      now,
      runningOpsSameKind: [],
      pendingOpsSameKind: [
        { id: "op-a", kind: "rollout", createdAt: 2, input: { gatewayId: "bender-blue" } },
      ],
    });
    expect(blocked.outcome).toBe("queue");

    const admitted = decideOperationClaim({
      op: { id: "op-a", kind: "rollout", status: "pending", createdAt: 2 },
      now,
      runningOpsSameKind: [],
      pendingOpsSameKind: [
        { id: "op-b", kind: "rollout", createdAt: 2, input: { gatewayId: "default-green" } },
      ],
    });
    expect(admitted).toEqual({ outcome: "claim" });
  });

  it("ignores older pending migrations to a DIFFERENT target — FIFO is per scope, not per kind", () => {
    const decision = decideOperationClaim({
      op: {
        id: "op-new",
        kind: "migrate-customer",
        status: "pending",
        createdAt: 3,
        input: { toGatewayId: "gw-purple" },
      },
      now,
      runningOpsSameKind: [],
      pendingOpsSameKind: [
        { id: "op-old", kind: "migrate-customer", createdAt: 2, input: { toGatewayId: "gw-green" } },
      ],
    });
    expect(decision).toEqual({ outcome: "claim" });
  });

  it("queues behind an older pending migration to the SAME target", () => {
    const decision = decideOperationClaim({
      op: {
        id: "op-new",
        kind: "migrate-customer",
        status: "pending",
        createdAt: 3,
        input: { toGatewayId: "gw-green" },
      },
      now,
      runningOpsSameKind: [],
      pendingOpsSameKind: [
        {
          id: "op-old",
          kind: "migrate-customer",
          createdAt: 2,
          input: { fromGatewayId: "gw-blue", toGatewayId: "gw-green" },
        },
      ],
    });
    expect(decision).toEqual({
      outcome: "queue",
      waitingOn: "migration gw-blue → gw-green",
    });
  });

  it("never blocks itself when its own doc appears in the pending list", () => {
    const decision = decideOperationClaim({
      op: { id: "op-1", kind: "rollout", status: "pending", createdAt: 2 },
      now,
      runningOpsSameKind: [],
      pendingOpsSameKind: [
        { id: "op-1", kind: "rollout", createdAt: 2, input: { gatewayId: "bender-blue" } },
      ],
    });
    expect(decision).toEqual({ outcome: "claim" });
  });
});
