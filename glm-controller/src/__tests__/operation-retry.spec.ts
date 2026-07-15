import { describe, expect, it } from "vitest";
import { FieldValue } from "firebase-admin/firestore";
import {
  MAX_OPERATION_ATTEMPTS,
  buildOperationCompletionUpdate,
  classifyOperationFailure,
  retryBackoffMs,
  shouldPersistClaimedOperationCompletion,
  supersededRollMigrationAction,
} from "../operation-retry";

describe("supersededRollMigrationAction", () => {
  it("cancels unstarted work but waits for running or cleanup-pending workers to finish", () => {
    expect(supersededRollMigrationAction({ status: "pending" })).toBe("cancel");
    expect(supersededRollMigrationAction({ status: "running" })).toBe("wait");
    expect(supersededRollMigrationAction({
      status: "pending",
      output: { configCleanup: { migrationId: "mig-1" } },
    })).toBe("wait");
    expect(supersededRollMigrationAction({ status: "failed" })).toBe("done");
    expect(supersededRollMigrationAction({ status: "rolled-back" })).toBe("done");
  });
});

describe("shouldPersistClaimedOperationCompletion", () => {
  it("does not let an in-memory worker overwrite a durably cancelled operation", () => {
    expect(shouldPersistClaimedOperationCompletion("running")).toBe(true);
    expect(shouldPersistClaimedOperationCompletion("rolled-back")).toBe(false);
    expect(shouldPersistClaimedOperationCompletion("failed")).toBe(false);
  });
});

describe("classifyOperationFailure", () => {
  it("classifies timeouts, K8s API hiccups, and preemption as transient", () => {
    expect(classifyOperationFailure("helm did not render bender-green@sha within 60000ms")).toBe(
      "transient",
    );
    expect(
      classifyOperationFailure("gateway bender-green never published a heartbeat with version=sha within 300000ms"),
    ).toBe("transient");
    expect(classifyOperationFailure("connect ECONNREFUSED 10.0.0.1:443")).toBe("transient");
    expect(classifyOperationFailure("request failed with status 503")).toBe("transient");
    expect(classifyOperationFailure("context deadline exceeded")).toBe("transient");
    expect(classifyOperationFailure("instance preempted mid-warm")).toBe("transient");
    expect(
      classifyOperationFailure("gateway bender durable desired revision did not materialize within 120000ms"),
    ).toBe("transient");
    expect(classifyOperationFailure("config unfreeze cleanup pending: source RPC unavailable")).toBe(
      "transient",
    );
    expect(classifyOperationFailure("source unmount cleanup pending: source RPC unavailable")).toBe(
      "transient",
    );
  });

  it("classifies validation and the #2137 fail-fast target-state guard as terminal", () => {
    expect(classifyOperationFailure("missing gatewayId in op.input")).toBe("terminal");
    expect(classifyOperationFailure("glmGateways/bender-green not found — cannot roll out")).toBe(
      "terminal",
    );
    expect(
      classifyOperationFailure(
        "target bender-green already holds customers at sha-1 — re-drive the roll at that tag first",
      ),
    ).toBe("terminal");
    expect(
      classifyOperationFailure(
        'blue/green sibling id "bender-blue-blue" is invalid (source "bender-blue" leaves no room for a colour suffix under the gateway-id limit)',
      ),
    ).toBe("terminal");
  });

  it("defaults to terminal for an unrecognized cause — fail fast rather than retry blind", () => {
    expect(classifyOperationFailure("some never-seen-before error string")).toBe("terminal");
  });

  it("treats a missing error message as terminal", () => {
    expect(classifyOperationFailure(undefined)).toBe("terminal");
  });
});

describe("retryBackoffMs", () => {
  it("grows exponentially and is capped", () => {
    expect(retryBackoffMs(1)).toBe(30_000);
    expect(retryBackoffMs(2)).toBe(120_000);
    expect(retryBackoffMs(3)).toBe(480_000);
    expect(retryBackoffMs(4)).toBe(480_000);
  });
});

describe("MAX_OPERATION_ATTEMPTS", () => {
  it("caps at 3", () => {
    expect(MAX_OPERATION_ATTEMPTS).toBe(3);
  });
});

describe("buildOperationCompletionUpdate", () => {
  const now = 2_000_000;

  it("builds a succeeded update, clearing queue/retry bookkeeping", () => {
    const update = buildOperationCompletionUpdate({
      op: { attempts: 0, attemptHistory: [] },
      result: { steps: [], success: true },
      steps: [{ name: "spawn-green", status: "done" }],
      now,
    });
    expect(update).toEqual({
      status: "succeeded",
      completedAt: now,
      attempts: 1,
      steps: [{ name: "spawn-green", status: "done" }],
      error: FieldValue.delete(),
      rolledBack: false,
      nextAttemptAt: FieldValue.delete(),
      waitingOn: FieldValue.delete(),
      output: FieldValue.delete(),
    });
  });

  it("keeps a durable config cleanup obligation level-triggered after the normal retry cap", () => {
    const configCleanup = {
      migrationId: "mig-1",
      slug: "alice",
      sourceGatewayId: "default",
      sourceTransportId: "default-r1",
      resume: { success: true, rolledBack: false },
    };
    const update = buildOperationCompletionUpdate({
      op: { attempts: MAX_OPERATION_ATTEMPTS, attemptHistory: [] },
      result: {
        steps: [],
        success: false,
        error: "config unfreeze cleanup pending: source RPC unavailable",
        output: { configCleanup },
      },
      steps: [],
      now,
    });

    expect(update.status).toBe("pending");
    expect(update.output).toEqual({ configCleanup });
    expect(update.nextAttemptAt).toBe(now + retryBackoffMs(MAX_OPERATION_ATTEMPTS + 1));
  });

  it("terminalizes a definitive unsupported or wrong-owner cleanup even when the obligation is retained for audit", () => {
    for (const error of [
      "config cleanup terminal: /config-unfreeze/default: 501 not configured",
      "config cleanup terminal: freeze is owned by mig-other-op",
    ]) {
      const configCleanup = {
        migrationId: "mig-1",
        slug: "alice",
        sourceGatewayId: "default",
        sourceTransportId: "default-r1",
        resume: { success: true, rolledBack: false },
      };
      const update = buildOperationCompletionUpdate({
        op: { attempts: MAX_OPERATION_ATTEMPTS, attemptHistory: [] },
        result: { steps: [], success: false, error, output: { configCleanup } },
        steps: [],
        now,
      });

      expect(update.status).toBe("failed");
      expect(update.output).toEqual({ configCleanup });
    }
  });

  it("deletes a stale cleanup obligation after cleanup finishes", () => {
    const update = buildOperationCompletionUpdate({
      op: { attempts: 1 },
      result: { steps: [], success: true },
      steps: [],
      now,
    });

    expect(update.output).toEqual(FieldValue.delete());
  });

  it("persists migration checkpoint and proof output with the terminal operation", () => {
    const output = {
      configCheckpoint: { checkpointCommit: "a".repeat(40), configHash: "b".repeat(64) },
      configProof: { restoredCommit: "a".repeat(40), acceptedCommit: "c".repeat(40) },
    };
    const update = buildOperationCompletionUpdate({
      op: { attempts: 0 },
      result: { steps: [], success: true, output },
      steps: [],
      now,
    });

    expect(update.output).toEqual(output);
  });

  it("requeues a transient failure with backoff, bumps attempts, and appends attempt history", () => {
    const claimedAt = now - 45_000;
    const update = buildOperationCompletionUpdate({
      op: { attempts: 0, attemptHistory: [], startedAt: claimedAt },
      result: { steps: [], success: false, error: "connect ECONNREFUSED 10.0.0.1:443" },
      steps: [{ name: "spawn-green", status: "failed", error: "connect ECONNREFUSED 10.0.0.1:443" }],
      now,
    });
    expect(update.status).toBe("pending");
    expect(update.attempts).toBe(1);
    expect(update.startedAt).toBeNull();
    expect(update.steps).toEqual([]);
    expect(update.nextAttemptAt).toBe(now + 30_000);
    expect(update.waitingOn).toEqual(FieldValue.delete());
    expect(update.error).toMatch(/attempt 1.*transient.*retrying in 30s/i);
    expect(update.attemptHistory).toEqual([
      {
        attempt: 1,
        startedAt: claimedAt,
        completedAt: now,
        error: "connect ECONNREFUSED 10.0.0.1:443",
        classification: "transient",
        steps: [{ name: "spawn-green", status: "failed", error: "connect ECONNREFUSED 10.0.0.1:443" }],
      },
    ]);
  });

  it("falls back to completion time for the attempt start when the op carries no startedAt", () => {
    const update = buildOperationCompletionUpdate({
      op: { attempts: 0, attemptHistory: [] },
      result: { steps: [], success: false, error: "connect ECONNREFUSED 10.0.0.1:443" },
      steps: [],
      now,
    });
    expect((update.attemptHistory as Array<{ startedAt: number }>)[0].startedAt).toBe(now);
  });

  it("fails terminally (no retry) for a validation-style error on the first attempt", () => {
    const update = buildOperationCompletionUpdate({
      op: { attempts: 0, attemptHistory: [] },
      result: { steps: [], success: false, error: "missing gatewayId in op.input" },
      steps: [],
      now,
    });
    expect(update.status).toBe("failed");
    expect(update.completedAt).toBe(now);
    expect(update.attempts).toBe(1);
    expect(update.error).toBe("missing gatewayId in op.input");
    expect(update.nextAttemptAt).toEqual(FieldValue.delete());
    expect(update.waitingOn).toEqual(FieldValue.delete());
  });

  it("fails terminally once the attempt cap is reached even for a transient cause", () => {
    const update = buildOperationCompletionUpdate({
      op: {
        attempts: 2,
        attemptHistory: [
          { attempt: 1, startedAt: 1, completedAt: 2, error: "e1", classification: "transient", steps: [] },
          { attempt: 2, startedAt: 3, completedAt: 4, error: "e2", classification: "transient", steps: [] },
        ],
      },
      result: { steps: [], success: false, error: "connect ECONNREFUSED 10.0.0.1:443" },
      steps: [],
      now,
    });
    expect(update.status).toBe("failed");
    expect(update.attempts).toBe(3);
    expect(update.error).toBe("connect ECONNREFUSED 10.0.0.1:443");
    expect((update.attemptHistory as unknown[]).length).toBe(3);
  });

  it("preserves rolledBack from the handler result on terminal failure", () => {
    const update = buildOperationCompletionUpdate({
      op: { attempts: 0, attemptHistory: [] },
      result: { steps: [], success: false, error: "missing gatewayId in op.input", rolledBack: true },
      steps: [],
      now,
    });
    expect(update.rolledBack).toBe(true);
  });
});
