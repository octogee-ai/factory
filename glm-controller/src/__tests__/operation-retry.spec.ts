import { describe, expect, it } from "vitest";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import {
  MAX_OPERATION_ATTEMPTS,
  MAX_OPERATION_ATTEMPT_HISTORY,
  OPERATION_JOURNAL_RETENTION_MS,
  buildOperationCompletionUpdate,
  classifyOperationFailure,
  retryBackoffMs,
  shouldPersistClaimedOperationCompletion,
  supersededRollMigrationAction,
  operationNeedsDurableRestartResume,
  verifiedDeletionCompletion,
} from "../operation-retry";

describe("verifiedDeletionCompletion", () => {
  it("returns the durable deletion mapping only for a successful verified erasure", () => {
    expect(verifiedDeletionCompletion({
      steps: [],
      success: true,
      output: {
        archiveId: "archive-1",
        verifiedDeletion: { deletionId: "delete-1", archiveId: "archive-1" },
      },
    })).toEqual({ deletionId: "delete-1", archiveId: "archive-1" });
    expect(verifiedDeletionCompletion({
      steps: [],
      success: false,
      output: { verifiedDeletion: { deletionId: "delete-1", archiveId: "archive-1" } },
    })).toBeNull();
  });
});

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
    expect(shouldPersistClaimedOperationCompletion({ status: "running", startedAt: 100, claimedStartedAt: 100 })).toBe(true);
    expect(shouldPersistClaimedOperationCompletion({ status: "rolled-back", startedAt: 100, claimedStartedAt: 100 })).toBe(false);
    expect(shouldPersistClaimedOperationCompletion({ status: "failed", startedAt: 100, claimedStartedAt: 100 })).toBe(false);
  });

  it("does not let a stale executor overwrite an operation that was re-armed and claimed again", () => {
    expect(shouldPersistClaimedOperationCompletion({ status: "running", startedAt: 200, claimedStartedAt: 100 })).toBe(false);
    expect(shouldPersistClaimedOperationCompletion({ status: "running", startedAt: null, claimedStartedAt: 100 })).toBe(false);
  });
});

describe("operationNeedsDurableRestartResume", () => {
  it("resumes an interrupted automatic Builder return rather than reaping its coordinated handoff", () => {
    const op = { id: "builder-return-native", kind: "migrate-customer", origin: "automatic", input: {
      source: "builder-activation-lease", fromGatewayId: "native", toGatewayId: "shared-0",
    } };
    expect(operationNeedsDurableRestartResume(op)).toBe(true);
    expect(operationNeedsDurableRestartResume({ ...op, id: "manual-move" })).toBe(false);
  });
  it.each(["suspend-customer", "erase-customer"])(
    "keeps an interrupted %s operation available for restart re-drive",
    (kind) => {
      expect(operationNeedsDurableRestartResume({ kind })).toBe(true);
    },
  );
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
      classifyOperationFailure(
        "status 503: gateway default cannot activate release 3 while release 2 is not live",
      ),
    ).toBe("transient");
    expect(classifyOperationFailure("TypeError: fetch failed")).toBe("transient");
    expect(
      classifyOperationFailure(
        "/push-rsync-state/shared-0: 500 agent store /home/node/.openclaw/agents/octogee-ceckert-coach/agent/openclaw-agent.sqlite could not be checkpointed for carry: database is locked",
      ),
    ).toBe("transient");
    expect(classifyOperationFailure("response body terminated before completion")).toBe("transient");
    expect(classifyOperationFailure("premature close while reading response body")).toBe("transient");
    expect(classifyOperationFailure("Unexpected end of JSON input")).toBe("transient");
    expect(classifyOperationFailure("14 UNAVAILABLE: Firestore request failed")).toBe("transient");
    expect(
      classifyOperationFailure("gateway bender durable desired revision did not materialize within 120000ms"),
    ).toBe("transient");
    expect(classifyOperationFailure("config unfreeze cleanup pending: source RPC unavailable")).toBe(
      "transient",
    );
    expect(classifyOperationFailure("source unmount cleanup pending: source RPC unavailable")).toBe(
      "transient",
    );
    expect(
      classifyOperationFailure(
        "gateway bender retirement config freeze failed: openclaw config is dirty",
      ),
    ).toBe("transient");
    expect(
      classifyOperationFailure(
        '/restore/default: 500 {"error":"restore failed","message":"system config writer lock is busy"}',
      ),
    ).toBe("transient");
    expect(
      classifyOperationFailure(
        '/restore/default: 500 {"message":"channel did not connect; fleet will retry"}',
      ),
    ).toBe("transient");
    expect(
      classifyOperationFailure(
        "target gateway shared-b is not migration-ready " +
          "(desiredStatus=draining, desiredRelease=12, liveRelease=12); " +
          "requires running with a converged release",
      ),
    ).toBe("transient");
    expect(
      classifyOperationFailure(
        "[migration-http] local SSH public key is missing for alice",
      ),
    ).toBe("transient");
    expect(
      classifyOperationFailure(
        "[migration-activation:alice] source has no applied fingerprint; converge it before migration",
      ),
    ).toBe("transient");
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

  it.each([
    ["source quiesce load timeout", "/quiesce/shared-0 timed out after 60000ms (http://octogee-gateway-shared-0.octogee-test.svc.cluster.local:3003/quiesce/shared-0)"],
    ["scheduler hold load timeout", "/scheduler/shared-0 timed out after 60000ms (http://octogee-gateway-shared-0.octogee-test.svc.cluster.local:3003/scheduler/shared-0)"],
    ["gateway RPC socket dropped before the connect response", '/scheduler/shared-0: 500 {"error":"scheduler migration failed","message":"socket closed before connect response"}'],
    ["unmount socket dropped before the connect response", '/unmount/shared-0: 500 {"error":"unmount failed","message":"socket closed before connect response","code":"connect-failed"}'],
    ["scheduler fence still held by a handoff that has not settled", '/scheduler/shared-0: 500 {"error":"scheduler migration failed","message":"Cron agent octogee-sep17-coach is held for migration mig-placement-190929cbf8f86906bee813bffa1a4157:scheduler:1"}'],
    ["bounded quiesce that could not settle after the stop", "quiesce did not drain: 1 still running on shared-0 for slug=alice"],
    ["older provisioner's quiesce whose own hold did not drain", '/quiesce/shared-0: 500 {"error":"quiesce failed","message":"Scheduler runs are still draining for alice"}'],
    ["source gateway with no ready pod while OpenClaw restarts", "expected exactly one ready pod for transport=shared-50fedc9f5f74; found 0"],
    ["gateway with no running pod", "expected exactly one running pod for transport=shared-0; found 0"],
    ["gateway mid-roll with two ready pods", "expected exactly one ready pod for transport=shared-0; found 2"],
    ["Builder computer whose OpenClaw has not initialized this boot's workspace identities", 'target gateway ceckert-s-7b9a4acb scheduler did not become ready within 120000ms: /scheduler/ceckert-s-7b9a4acb: 500 {"error":"scheduler migration failed","message":"OpenClaw workspace identities are not initialized for this boot"}'],
  ])("classifies a pre-cutover %s as transient so placement re-arms it", (_name, error) => {
    expect(classifyOperationFailure(error)).toBe("transient");
  });

  it.each([
    ["cutover already committed but the customer moved on", "migration cutover already committed to shared-1; customer now owned by shared-2 — source cleanup left to the eviction sweep"],
    ["declared source mismatch", "declared source shared-0 does not match resolved source shared-1"],
    ["customer already on target", "customer already on shared-1"],
    ["quiesce refused because of scheduled jobs", "migration blocked: octogee-alice-coach has enabled scheduled jobs; source retained"],
    ["scheduler proof failure", "scheduler hold did not prove a drained matching operation"],
    ["a socket message that is not the connect drop", "socket hang up while writing"],
  ])("keeps %s terminal", (_name, error) => {
    expect(classifyOperationFailure(error)).toBe("terminal");
  });

  it("classifies the gateway mutation writer-lock-busy response as transient", () => {
    expect(
      classifyOperationFailure(
        "finish-rsync-import failed: system config mutation unavailable: writer-lock-busy",
      ),
    ).toBe("transient");
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

  it.each([
    { attempts: 0, status: "pending", delay: 30_000 },
    { attempts: 1, status: "pending", delay: 120_000 },
    { attempts: 2, status: "failed", delay: null },
  ])("handles Compute stop timeout after $attempts prior retirement attempts as $status", ({ attempts, status, delay }) => {
    const error = "helm uninstall failed: stop octogee-pool-44847785: operation operation-1789782653823-65bcc3f4e6af7-3edab86e-7a35a62e did not finish within 300000ms";
    const steps = [{ name: "helm-uninstall", status: "failed" as const, error }];
    const update = buildOperationCompletionUpdate({
      op: { kind: "retire-gateway", origin: "automatic", attempts, attemptHistory: [] },
      result: { steps, success: false, error },
      steps,
      now,
    });

    expect(update.status).toBe(status);
    expect(update.attempts).toBe(attempts + 1);
    expect(update.attemptHistory).toEqual([
      expect.objectContaining({ classification: "transient", error, steps }),
    ]);
    if (delay !== null) {
      expect(update.nextAttemptAt).toBe(now + delay);
      expect(update.expireAt).toEqual(FieldValue.delete());
    }
  });

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
      expireAt: Timestamp.fromMillis(now + OPERATION_JOURNAL_RETENTION_MS),
      attempts: 1,
      steps: [{ name: "spawn-green", status: "done" }],
      error: FieldValue.delete(),
      rolledBack: false,
      nextAttemptAt: FieldValue.delete(),
      waitingOn: FieldValue.delete(),
      output: FieldValue.delete(),
    });
  });

  it("stamps a 30-day TTL twin on every terminal journal row", () => {
    const succeeded = buildOperationCompletionUpdate({
      op: { attempts: 0, attemptHistory: [] },
      result: { steps: [], success: true },
      steps: [],
      now,
    });
    const failed = buildOperationCompletionUpdate({
      op: { attempts: MAX_OPERATION_ATTEMPTS, attemptHistory: [] },
      result: { steps: [], success: false, error: "missing gatewayId in op.input" },
      steps: [],
      now,
    });

    expect(failed.status).toBe("failed");
    expect(OPERATION_JOURNAL_RETENTION_MS).toBe(30 * 24 * 60 * 60_000);
    for (const update of [succeeded, failed]) {
      expect(update.expireAt).toBeInstanceOf(Timestamp);
      expect((update.expireAt as Timestamp).toMillis()).toBe(
        now + OPERATION_JOURNAL_RETENTION_MS,
      );
    }
  });

  it("clears a stale TTL twin when a transient failure requeues the operation", () => {
    const update = buildOperationCompletionUpdate({
      op: { attempts: 1, attemptHistory: [] },
      result: { steps: [], success: false, error: "context deadline exceeded" },
      steps: [],
      now,
    });

    expect(update.status).toBe("pending");
    expect(update.expireAt).toEqual(FieldValue.delete());
  });

  it("atomically scrubs identifying operation input only on verified success", () => {
    const update = buildOperationCompletionUpdate({
      op: {
        attempts: 1,
        attemptHistory: [{
          attempt: 1,
          startedAt: 1,
          completedAt: 2,
          error: "failed to delete alice@example.com",
          classification: "transient",
          steps: [],
        }],
      },
      result: {
        steps: [],
        success: true,
        scrubInputOnSuccess: true,
        output: { archiveId: "archive-random" },
      },
      steps: [{ name: "delete-stripe-customer:cus_identifying", status: "done" }],
      now,
    });
    expect(update).toMatchObject({ status: "succeeded", output: { archiveId: "archive-random" } });
    expect(update.input).toEqual(FieldValue.delete());
    expect(update.inputUid).toEqual(FieldValue.delete());
    expect(update.createdBy).toEqual(FieldValue.delete());
    expect(update.attemptHistory).toEqual(FieldValue.delete());
    expect(update.steps).toEqual([]);
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

  it("keeps a durable retirement freeze obligation level-triggered after the normal retry cap", () => {
    const retirementFencePending = {
      gatewayId: "bender",
      operationId: "retire-1",
    };
    const update = buildOperationCompletionUpdate({
      op: { attempts: MAX_OPERATION_ATTEMPTS, attemptHistory: [] },
      result: {
        steps: [],
        success: false,
        error: "gateway bender retirement config checkpoint changed before teardown",
        output: { retirementFencePending },
      },
      steps: [],
      now,
    });

    expect(update.status).toBe("pending");
    expect(update.output).toEqual({ retirementFencePending });
    expect(update.nextAttemptAt).toBe(now + retryBackoffMs(MAX_OPERATION_ATTEMPTS + 1));
  });

  it("keeps a customer deletion context fence level-triggered after the normal retry cap", () => {
    const deletionFencePending = { deletionId: "delete-1" };
    const update = buildOperationCompletionUpdate({
      op: { attempts: MAX_OPERATION_ATTEMPTS, attemptHistory: [] },
      result: {
        steps: [],
        success: false,
        error: "customer suspension cleanup context pending",
        output: { deletionFencePending },
      },
      steps: [],
      now,
    });

    expect(update.status).toBe("pending");
    expect(update.output).toEqual({ deletionFencePending });
  });

  it("keeps an ordinary customer cleanup failure level-triggered after the normal retry cap", () => {
    const deletionCleanupRetry = { deletionId: "delete-1" };
    const update = buildOperationCompletionUpdate({
      op: { attempts: MAX_OPERATION_ATTEMPTS, attemptHistory: [] },
      result: {
        steps: [],
        success: false,
        error: "mattermost: service unavailable",
        output: { deletionCleanupRetry },
      },
      steps: [],
      now,
    });
    expect(update.status).toBe("pending");
    expect(update.output).toEqual({ deletionCleanupRetry });
  });

  it("fails a blocked customer deletion terminally instead of level-triggered retry", () => {
    const deletionBlocked = { deletionId: "delete-1", step: "delete-posthog-person-data" };
    const update = buildOperationCompletionUpdate({
      op: { kind: "erase-customer", attempts: 0, attemptHistory: [] },
      result: {
        steps: [],
        success: false,
        error: "PostHog person deletion refused: merged with another customer (uid-2)",
        output: { deletionBlocked },
      },
      steps: [],
      now,
    });
    expect(update.status).toBe("failed");
    expect(update.output).toEqual({ deletionBlocked });
    expect(update.attemptHistory).toEqual([
      expect.objectContaining({ attempt: 1, classification: "terminal" }),
    ]);
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

  it("keeps an active durable customer migration V2 retryable beyond the normal cap", () => {
    const update = buildOperationCompletionUpdate({
      op: {
        attempts: MAX_OPERATION_ATTEMPTS,
        attemptHistory: [],
        customerMigrationV2: { phase: "promotionIntent" } as never,
      },
      result: {
        steps: [],
        success: false,
        error: "customer migration V2 retry pending: status 503: response lost",
      },
      steps: [],
      now,
    });

    expect(update.status).toBe("pending");
    expect(update.nextAttemptAt).toBe(now + retryBackoffMs(MAX_OPERATION_ATTEMPTS + 1));
  });

  it("keeps an automatic Builder return retryable beyond the cap for a transient cause", () => {
    const update = buildOperationCompletionUpdate({
      op: {
        id: "builder-return-run-alice",
        kind: "migrate-customer",
        origin: "automatic",
        input: {
          source: "builder-activation-lease",
          fromGatewayId: "run-alice",
        },
        attempts: MAX_OPERATION_ATTEMPTS,
        attemptHistory: [],
      },
      result: {
        steps: [],
        success: false,
        error: "/restore/default transport failed: fetch failed",
      },
      steps: [],
      now,
    });

    expect(update.status).toBe("pending");
    expect(update.attempts).toBe(MAX_OPERATION_ATTEMPTS + 1);
    expect(update.nextAttemptAt).toBe(now + retryBackoffMs(MAX_OPERATION_ATTEMPTS + 1));
  });

  it("fails a Builder return after the migration-ready precondition exhausts its retry budget", () => {
    const update = buildOperationCompletionUpdate({
      op: {
        id: "builder-return-run-alice",
        kind: "migrate-customer",
        origin: "automatic",
        input: {
          source: "builder-activation-lease",
          fromGatewayId: "run-alice",
        },
        attempts: MAX_OPERATION_ATTEMPTS - 1,
        attemptHistory: [],
      },
      result: {
        steps: [],
        success: false,
        error:
          "source gateway run-alice is not migration-ready " +
          "(desiredStatus=running, desiredRelease=4, liveRelease=3); " +
          "requires running or draining with a converged release",
      },
      steps: [],
      now,
    });

    expect(update.status).toBe("failed");
    expect(update.attempts).toBe(MAX_OPERATION_ATTEMPTS);
  });

  it("keeps deterministic continuous placement demand retryable without creating new operations", () => {
    const update = buildOperationCompletionUpdate({
      op: {
        id: `placement-${"a".repeat(32)}`,
        kind: "migrate-customer",
        origin: "automatic",
        input: { source: "continuous-placement-policy" },
        attempts: MAX_OPERATION_ATTEMPTS,
        attemptHistory: [],
      },
      result: {
        steps: [],
        success: false,
        error:
          "target gateway shared-b is not migration-ready " +
          "(desiredStatus=draining, desiredRelease=12, liveRelease=12); " +
          "requires running with a converged release",
      },
      steps: [],
      now,
    });

    expect(update.status).toBe("pending");
    expect(update.attempts).toBe(MAX_OPERATION_ATTEMPTS + 1);
    expect(update.nextAttemptAt).toBe(now + retryBackoffMs(MAX_OPERATION_ATTEMPTS + 1));
  });

  it("bounds level-triggered attempt history", () => {
    const history = Array.from({ length: MAX_OPERATION_ATTEMPT_HISTORY }, (_, index) => ({
      attempt: index + 1,
      startedAt: index,
      completedAt: index + 1,
      error: "fetch failed",
      classification: "transient" as const,
      steps: [],
    }));
    const update = buildOperationCompletionUpdate({
      op: {
        id: "builder-return-run-alice",
        kind: "migrate-customer",
        origin: "automatic",
        input: { source: "builder-activation-lease", fromGatewayId: "run-alice" },
        attempts: MAX_OPERATION_ATTEMPT_HISTORY,
        attemptHistory: history,
      },
      result: { steps: [], success: false, error: "fetch failed" },
      steps: [],
      now,
    });

    expect(update.attemptHistory).toHaveLength(MAX_OPERATION_ATTEMPT_HISTORY);
    expect((update.attemptHistory as Array<{ attempt: number }>)[0]?.attempt).toBe(2);
  });

  it("still terminalizes a validation failure for an automatic Builder return", () => {
    const update = buildOperationCompletionUpdate({
      op: {
        id: "builder-return-run-alice",
        kind: "migrate-customer",
        origin: "automatic",
        input: {
          source: "builder-activation-lease",
          fromGatewayId: "run-alice",
        },
        attempts: MAX_OPERATION_ATTEMPTS,
      },
      result: {
        steps: [],
        success: false,
        error: "target assignment belongs to another Builder",
      },
      steps: [],
      now,
    });

    expect(update.status).toBe("failed");
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
