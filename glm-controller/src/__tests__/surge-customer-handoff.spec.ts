import { describe, expect, it, vi } from "vitest";
import { MigrationDrainPendingError } from "@octogee/core/fleet-migration-client";
import { reconcileSurgeCustomerHandoff, assertSurgeAssignmentCoverage,
  type SurgeAssignment, type SurgePod, type SurgePodHealth } from "../surge-customer-handoff.js";
import { MIGRATE_STATE, CROSS_VERSION, oldPod, targetPod, abandonedPodUid, abandonedOperationId,
  otherGatewayOperationId, assignment, createSurgeHandoffHarness } from "./fixtures/surge-customer-handoff.js";

const harness = (input: Parameters<typeof createSurgeHandoffHarness>[1] = {}) => createSurgeHandoffHarness(vi.fn, input);

describe("surge customer handoff", () => {
  it("keeps source ingress closed when a shared target release has an unknown outcome", async () => {
    const h = harness({ assignments: [assignment("u1", "alice")], releaseErrorBeforeCommit: new Error("connection refused") });
    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default", desiredImageTag: "new-sha", requiresCustomerMigration: true, stateMigration: MIGRATE_STATE,
    })).rejects.toThrow("connection refused");
    expect(h.deps.resumeSourceIngress).not.toHaveBeenCalled();
    expect(h.assignments()[0].state).toBe("quiescing");
  });

  it("tags post-observation handoff lines and nested progress lines with the owning operation id", async () => {
    const h = harness();
    vi.mocked(h.deps.reportMigrationProgress).mockRejectedValueOnce(new Error("pod gone"));
    vi.mocked(h.deps.waitForSourceIdle).mockRejectedValueOnce(new MigrationDrainPendingError("coach is active"));
    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default", desiredImageTag: "new-sha", requiresCustomerMigration: true,
      disposableBuilderGateway: false, stateMigration: MIGRATE_STATE,
    })).resolves.toEqual({ ready: false });
    const lines = vi.mocked(h.deps.log).mock.calls.map(([message]) => message);
    expect(lines).toContainEqual(expect.stringMatching(/^\[surge-handoff\] waiting for Builder activity to finish gateway=default: coach is active op=surge-default-target-uid$/u));
    expect(lines).toContainEqual(expect.stringMatching(/^🔴 \[migration\] destination progress unavailable: Error: pod gone;.* migrationId=surge-default-target-uid builder=alice op=surge-default-target-uid$/u));
    expect(lines.filter((line) => line.includes(" op=")).every((line) => line.match(/ op=/gu)?.length === 1)).toBe(true);
  });

  it.each([false, true])("keeps source assignments serving when coach or voice work defers a roll (Builder=%s)", async (builder) => {
    const h = harness();
    vi.mocked(h.deps.waitForSourceIdle).mockRejectedValueOnce(new MigrationDrainPendingError("coach is active"));
    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default", desiredImageTag: "new-sha", requiresCustomerMigration: true,
      disposableBuilderGateway: builder, stateMigration: MIGRATE_STATE,
    })).resolves.toEqual({ ready: false });
    expect(h.deps.markAssignment).not.toHaveBeenCalled();
    expect(h.deps.quiesce).not.toHaveBeenCalled();
    expect(h.deps.transfer).not.toHaveBeenCalled();
    expect(h.deps.releaseTarget).not.toHaveBeenCalled();
    expect(h.deps.resumeSourceIngress).toHaveBeenCalledWith(expect.objectContaining({ slug: "alice", sourcePod: oldPod }));
    expect(h.assignments().every((item) => item.state === "serving")).toBe(true);
    expect(h.deps.reportMigrationProgress).toHaveBeenCalledWith(expect.objectContaining({ event: expect.objectContaining({ phase: "waiting-for-builder-idle", status: "pending" }) }));
    expect(h.deps.recordMigrationProgress).toHaveBeenCalledWith({
      gatewayId: "default",
      uid: h.assignments()[0].uid,
      event: expect.objectContaining({ phase: "waiting-for-builder-idle", status: "pending", source: oldPod.name, migrationId: h.operationId }),
    });
  });

  it("checks every mounted Builder before gating anyone and releases all earlier voice holds on defer", async () => {
    const h = harness();
    vi.mocked(h.deps.waitForSourceIdle).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new MigrationDrainPendingError("voice is active"));
    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default", desiredImageTag: "new-sha", requiresCustomerMigration: true, stateMigration: MIGRATE_STATE,
    })).resolves.toEqual({ ready: false });
    expect(h.deps.markAssignment).not.toHaveBeenCalled();
    expect(vi.mocked(h.deps.resumeSourceIngress).mock.calls.map(([input]) => input.slug).sort()).toEqual(["alice", "bob"]);
  });

  it.each([false, true])("restores source admission when new work races the final gate (Builder=%s)", async (builder) => {
    const h = harness({ assignments: [assignment("u1", "alice")] });
    vi.mocked(h.deps.quiesce).mockRejectedValueOnce(new MigrationDrainPendingError("new coach turn"));
    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default", desiredImageTag: "new-sha", requiresCustomerMigration: true,
      disposableBuilderGateway: builder, stateMigration: MIGRATE_STATE,
    })).resolves.toEqual({ ready: false });
    expect(h.events).toEqual(["assignment:u1:quiescing", "assignment:u1:serving"]);
    expect(h.deps.waitForSourceIdle).toHaveBeenCalledOnce();
    expect(h.deps.resumeSourceIngress).toHaveBeenCalledOnce();
    expect(vi.mocked(h.deps.resumeSourceIngress).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(h.deps.markAssignment).mock.invocationCallOrder[1],
    );
    expect(h.deps.flush).not.toHaveBeenCalled();
    expect(h.deps.releaseTarget).not.toHaveBeenCalled();
    expect(h.assignments()[0].state).toBe("serving");
  });

  it("reports failed source resume instead of hiding it as a pending drain", async () => {
    const h = harness();
    vi.mocked(h.deps.waitForSourceIdle).mockRejectedValueOnce(new MigrationDrainPendingError("coach active"));
    vi.mocked(h.deps.resumeSourceIngress).mockRejectedValueOnce(new Error("voice resume unavailable"));
    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default", desiredImageTag: "new-sha", requiresCustomerMigration: true, stateMigration: MIGRATE_STATE,
    })).rejects.toThrow(/voice resume unavailable/);
    expect(h.deps.markAssignment).not.toHaveBeenCalled();
  });

  it("rejects the ambiguous short heartbeat for a pinned OpenClaw image tag", async () => {
    const h = harness({
      pods: [{ ...targetPod, ready: true }],
      assignments: [],
      targetVersion: "27b966b",
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "27b966b-oc2026.7.1",
      requiresCustomerMigration: false,
      stateMigration: MIGRATE_STATE,
    })).resolves.toEqual({ ready: false });
  });

  it("refuses to hand off a user mirror that has no exact assignment document", () => {
    expect(() => assertSurgeAssignmentCoverage(
      [assignment("u1", "alice")],
      [{ uid: "u1", slug: "alice" }, { uid: "u2", slug: "bob" }],
    )).toThrow(/missing assignment.*u2\/bob/);
    expect(() => assertSurgeAssignmentCoverage(
      [assignment("u1", "alice")],
      [{ uid: "u1", slug: "alice" }],
    )).not.toThrow();
  });

  it("leaves a healthy first-install pod for pod-side self-release", async () => {
    const h = harness({ pods: [targetPod], assignments: [] });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: false,
      stateMigration: MIGRATE_STATE,
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual([]);
  });

  it("marks an empty held disposable Builder prelaunch live without releasing it", async () => {
    const h = harness({
      pods: [targetPod],
      assignments: [],
      bootingUids: [targetPod.uid],
      prelaunchByUid: { [targetPod.uid]: "held" },
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "builder-alice",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: false,
      disposableBuilderGateway: true,
      stateMigration: MIGRATE_STATE,
    })).resolves.toEqual({ ready: true, prelaunchHeld: true });

    expect(h.events).toEqual([]);
    expect(h.deps.releaseTarget).not.toHaveBeenCalled();
    expect(h.deps.unreserveTargetOpenClaw).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "an assignment",
      assignments: [assignment("u1", "alice")],
      targetMountedCustomers: [] as string[],
      expectedEvents: ["unreserve-target:target-uid:alice"],
    },
    {
      name: "a tenant mount",
      assignments: [] as SurgeAssignment[],
      targetMountedCustomers: ["alice"],
      expectedEvents: [] as string[],
    },
  ])("keeps held disposable prelaunch closed when it already has $name", async ({
    assignments,
    targetMountedCustomers,
    expectedEvents,
  }) => {
    const h = harness({
      pods: [targetPod],
      assignments,
      targetMountedCustomers,
      bootingUids: [targetPod.uid],
      prelaunchByUid: { [targetPod.uid]: "held" },
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "builder-alice",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: false,
      disposableBuilderGateway: true,
      stateMigration: MIGRATE_STATE,
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual(expectedEvents);
    expect(h.deps.releaseTarget).not.toHaveBeenCalled();
  });

  it("finalizes a Builder source as quiesce, flush, reserve target, stop source, copy, verify", async () => {
    const h = harness({ assignments: [assignment("u1", "alice")] });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: false,
      disposableBuilderGateway: true,
      stateMigration: MIGRATE_STATE,
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual([
      "assignment:u1:quiescing",
      "quiesce:alice",
      "flush:old-uid:alice:migration-final",
      "hold-target:target-uid:alice",
      "stop-source:old-uid:alice",
      "transfer:alice",
      "digest:old-uid:alice",
      "digest:target-uid:alice",
      "release:target-uid",
    ]);
    expect(h.deps.transfer).toHaveBeenCalledWith(expect.objectContaining({
      loadStrategy: "standard",
      configTransferMode: "configured-builder-system-config",
      expectedSystemConfigCommit: "a".repeat(40),
    }));
  });

  it("uses the expedited load only for a terminating disposable-gateway source", async () => {
    const h = harness({
      pods: [{ ...oldPod, ready: false, terminating: true }, targetPod],
      assignments: [assignment("u1", "alice")],
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: false,
      disposableBuilderGateway: true,
      stateMigration: MIGRATE_STATE,
    })).resolves.toEqual({ ready: false });

    expect(h.deps.transfer).toHaveBeenCalledWith(expect.objectContaining({
      loadStrategy: "expedited",
      configTransferMode: "configured-builder-system-config",
    }));
  });

  it("rolls back a failed Builder handoff by holding the target, resuming the source, then reopening", async () => {
    const h = harness({
      assignments: [assignment("u1", "alice")],
      transferError: new Error("configured Builder durable path is invalid"),
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: false,
      disposableBuilderGateway: true,
      stateMigration: MIGRATE_STATE,
    })).rejects.toThrow("configured Builder durable path is invalid");

    expect(h.events).toEqual([
      "assignment:u1:quiescing",
      "quiesce:alice",
      "flush:old-uid:alice:migration-final",
      "hold-target:target-uid:alice",
      "stop-source:old-uid:alice",
      "transfer:alice",
      "hold-target:target-uid:alice",
      "resume-source:old-uid:alice",
      "assignment:u1:serving",
    ]);
    expect(h.deps.discardTargetCustomer).not.toHaveBeenCalled();
    expect(h.deps.releaseTarget).not.toHaveBeenCalled();
    expect(h.assignments()).toEqual([
      expect.objectContaining({ state: "serving", updatedByOperationId: h.operationId }),
    ]);
  });

  it("reports the divergent configured Builder digest pair before rolling back", async () => {
    const sourceDigestHash = "a".repeat(64);
    const targetDigestHash = "b".repeat(64);
    const h = harness({
      assignments: [assignment("u1", "alice")],
      resumeSourceError: new Error("source resume refused"),
      digestByPodUid: {
        [oldPod.uid]: { fileCount: 110, totalBytes: 1_172_920, sha256: sourceDigestHash },
        [targetPod.uid]: { fileCount: 109, totalBytes: 1_172_920, sha256: targetDigestHash },
      },
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: false,
      disposableBuilderGateway: true,
      stateMigration: MIGRATE_STATE,
    })).rejects.toThrow(
      "configured Builder handoff failed and its source could not be resumed: " +
        "handoff=durable session digest mismatch for alice sourcePod=gateway-old targetPod=gateway-new: " +
        `source(files=110 bytes=1172920 sha256=${sourceDigestHash}) ` +
        `target(files=109 bytes=1172920 sha256=${targetDigestHash}); resume=source resume refused`,
    );

    expect(h.deps.log).toHaveBeenCalledWith(expect.stringContaining(
      "preserving configured Builder target state after failed handoff gateway=default slugs=alice: " +
        "durable session digest mismatch for alice sourcePod=gateway-old targetPod=gateway-new: " +
        "source(files=110 bytes=1172920",
    ));
    expect(h.deps.releaseTarget).not.toHaveBeenCalled();
    expect(h.deps.resumeSourceOpenClaw).toHaveBeenCalledOnce();
  });

  it("keeps the roster gated when a Builder rollback cannot resume its source", async () => {
    const h = harness({
      assignments: [assignment("u1", "alice")],
      transferError: new Error("rsync failed"),
      resumeSourceError: new Error("source resume refused"),
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: false,
      disposableBuilderGateway: true,
      stateMigration: MIGRATE_STATE,
    })).rejects.toThrow(
      "configured Builder handoff failed and its source could not be resumed: " +
        "handoff=rsync failed; resume=source resume refused",
    );

    expect(h.events).toEqual([
      "assignment:u1:quiescing",
      "quiesce:alice",
      "flush:old-uid:alice:migration-final",
      "hold-target:target-uid:alice",
      "stop-source:old-uid:alice",
      "transfer:alice",
      "hold-target:target-uid:alice",
      "resume-source:old-uid:alice",
    ]);
    expect(h.assignments()).toEqual([
      expect.objectContaining({ state: "quiescing", updatedByOperationId: h.operationId }),
    ]);
  });

  it("copies from a quiesced legacy source that predates the OpenClaw process gate", async () => {
    const h = harness({
      assignments: [assignment("u1", "alice")],
      stopSourceLegacy: true,
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: false,
      disposableBuilderGateway: true,
      stateMigration: MIGRATE_STATE,
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual([
      "assignment:u1:quiescing",
      "quiesce:alice",
      "flush:old-uid:alice:migration-final",
      "hold-target:target-uid:alice",
      "stop-source:old-uid:alice",
      "transfer:alice",
      "digest:old-uid:alice",
      "digest:target-uid:alice",
      "release:target-uid",
    ]);
    expect(h.deps.resumeSourceOpenClaw).not.toHaveBeenCalled();
    expect(h.deps.log).toHaveBeenCalledWith(
      expect.stringContaining("predates the OpenClaw process gate"),
    );
  });

  it("restores the roster without a resume when the source stop never landed", async () => {
    const h = harness({
      assignments: [assignment("u1", "alice")],
      stopSourceError: new Error("source pod connection reset"),
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: false,
      disposableBuilderGateway: true,
      stateMigration: MIGRATE_STATE,
    })).rejects.toThrow("source pod connection reset");

    expect(h.events).toEqual([
      "assignment:u1:quiescing",
      "quiesce:alice",
      "flush:old-uid:alice:migration-final",
      "hold-target:target-uid:alice",
      "stop-source:old-uid:alice",
      "assignment:u1:serving",
    ]);
    expect(h.deps.transfer).not.toHaveBeenCalled();
    expect(h.deps.resumeSourceOpenClaw).not.toHaveBeenCalled();
    expect(h.assignments()).toEqual([
      expect.objectContaining({ state: "serving", updatedByOperationId: h.operationId }),
    ]);
  });

  it("still resumes the source when the rollback target hold fails", async () => {
    const h = harness({
      assignments: [assignment("u1", "alice")],
      transferError: new Error("rsync failed"),
      holdTargetError: new Error("target unreachable"),
      holdTargetErrorFromCall: 2,
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: false,
      disposableBuilderGateway: true,
      stateMigration: MIGRATE_STATE,
    })).rejects.toThrow("rsync failed");

    expect(h.events).toContain("resume-source:old-uid:alice");
    expect(h.events.at(-1)).toBe("assignment:u1:serving");
    expect(h.deps.log).toHaveBeenCalledWith(
      expect.stringContaining("rollback target hold failed"),
    );
  });

  it("keeps a terminating shared-gateway source on the standard load", async () => {
    const h = harness({
      pods: [{ ...oldPod, ready: false, terminating: true }, targetPod],
      assignments: [assignment("u1", "alice")],
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: false,
      disposableBuilderGateway: false,
      stateMigration: MIGRATE_STATE,
    })).resolves.toEqual({ ready: false });

    expect(h.deps.transfer).toHaveBeenCalledWith(expect.objectContaining({
      loadStrategy: "standard",
      configTransferMode: "activation-manifest",
    }));
  });

  it("selects a replacement that reports the complete OpenClaw-qualified image tag", async () => {
    const h = harness({
      assignments: [assignment("u1", "alice")],
      targetVersion: "cf36a88-oc2026.7.1",
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "cf36a88-oc2026.7.1",
      requiresCustomerMigration: true,
      stateMigration: MIGRATE_STATE,
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual([
      "assignment:u1:quiescing",
      "quiesce:alice",
      "transfer:alice",
      "digest:old-uid:alice",
      "digest:target-uid:alice",
      "release:target-uid",
    ]);
  });

  it("gates each assignment only when its serial transfer begins", async () => {
    const h = harness();

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      stateMigration: MIGRATE_STATE,
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual([
      "assignment:u1:quiescing",
      "quiesce:alice",
      "transfer:alice",
      "digest:old-uid:alice",
      "digest:target-uid:alice",
      "assignment:u2:quiescing",
      "quiesce:bob",
      "transfer:bob",
      "digest:old-uid:bob",
      "digest:target-uid:bob",
      "release:target-uid",
    ]);
    expect(h.assignments().every((item) => item.updatedByOperationId === h.operationId)).toBe(true);
    const progress = vi.mocked(h.deps.reportMigrationProgress).mock.calls.map(([input]) => input);
    expect(progress.every((input) => input.targetPod.uid === targetPod.uid)).toBe(true);
    expect(progress.map((input) => `${input.event.slug}:${input.event.phase}:${input.event.status}`)).toContain("alice:quiesce-and-finalize-source:done");
    expect(progress.at(-1)?.event).toMatchObject({ slug: "bob", phase: "serving-handoff", status: "pending" });
  });

  it("carries durable state across an OpenClaw version change", async () => {
    const h = harness();
    await reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default", desiredImageTag: "new-sha", requiresCustomerMigration: true,
      stateMigration: CROSS_VERSION,
    });
    expect(h.deps.quiesce).toHaveBeenCalled();
    expect(h.deps.transfer).toHaveBeenCalled();
    expect(h.deps.readDurableSessionDigest).toHaveBeenCalled();
    expect(h.events.at(-1)).toBe("release:target-uid");
  });

  it("gates but does not transfer an assigned customer that the source never mounted", async () => {
    const pods = [oldPod, targetPod];
    const targetMountedCustomers: string[] = [];
    const h = harness({
      pods,
      assignments: [
        assignment("u1", "alice"),
        assignment("u2", "posthog-smoke-v0"),
      ],
      sourceMountedCustomers: ["alice"],
      targetMountedCustomers,
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      stateMigration: MIGRATE_STATE,
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual([
      "assignment:u1:quiescing",
      "quiesce:alice",
      "transfer:alice",
      "digest:old-uid:alice",
      "digest:target-uid:alice",
      "assignment:u2:quiescing",
      "release:target-uid",
    ]);

    pods.splice(0, pods.length, { ...targetPod, ready: true });
    targetMountedCustomers.push("alice", "posthog-smoke-v0");
    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      stateMigration: MIGRATE_STATE,
    })).resolves.toEqual({ ready: true });
    expect(h.events.slice(-2)).toEqual([
      "assignment:u1:serving",
      "assignment:u2:serving",
    ]);
  });

  it("fails closed when the source mounts a customer without an assignment", async () => {
    const h = harness({
      assignments: [assignment("u1", "alice")],
      sourceMountedCustomers: ["alice", "orphan"],
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      stateMigration: MIGRATE_STATE,
    })).rejects.toThrow("source mounted customer orphan has no assignment");

    expect(h.events).toEqual([]);
  });

  it("restores owned assignments only after Kubernetes removes the old pod", async () => {
    const h = harness({
      pods: [{ ...targetPod, ready: true }],
      targetReleased: true,
      targetMountedCustomers: ["alice"],
      assignments: [assignment("u1", "alice", {
        state: "quiescing",
        updatedByOperationId: "surge-default-target-uid",
      })],
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      stateMigration: MIGRATE_STATE,
    })).resolves.toEqual({ ready: true });

    expect(h.events).toEqual(["assignment:u1:serving"]);
  });

  it("settles a Ready completed target without retrying its terminal attempt", async () => {
    const h = harness({ pods: [{ ...targetPod, ready: true }], targetReleased: true,
      assignments: [assignment("u1", "alice")], targetMountedCustomers: ["alice"],
      terminalTargetByUid: { [targetPod.uid]: { migrationId: "surge-default-target-uid", slug: "alice", targetPodUid: targetPod.uid } } });
    await expect(reconcileSurgeCustomerHandoff(h.deps, { gatewayId: "default", desiredImageTag: "new-sha",
      requiresCustomerMigration: true, disposableBuilderGateway: true, stateMigration: MIGRATE_STATE }))
      .resolves.toEqual({ ready: true });
    expect(h.events).toEqual([]);
    expect(h.deps.waitForSourceIdle).not.toHaveBeenCalled();
  });

  it("waits for a completed target to become Ready without requiring a different pod", async () => {
    const pods = [{ ...targetPod }], booting = [targetPod.uid];
    const phases: Record<string, SurgePodHealth["prelaunchState"]> = { [targetPod.uid]: "starting" };
    const h = harness({ pods, bootingUids: booting, prelaunchByUid: phases, targetReleased: true,
      assignments: [assignment("u1", "alice")], targetMountedCustomers: ["alice"],
      terminalTargetByUid: { [targetPod.uid]: { migrationId: "surge-default-target-uid", slug: "alice", targetPodUid: targetPod.uid } } });
    const input = { gatewayId: "default", desiredImageTag: "new-sha", requiresCustomerMigration: true,
      disposableBuilderGateway: true, stateMigration: MIGRATE_STATE };
    await expect(reconcileSurgeCustomerHandoff(h.deps, input)).resolves.toEqual({ ready: false });
    expect(h.deps.log).not.toHaveBeenCalledWith(expect.stringContaining("waiting for a replacement pod"));
    pods[0] = { ...targetPod, ready: true };
    booting.splice(0);
    phases[targetPod.uid] = "serving";
    await expect(reconcileSurgeCustomerHandoff(h.deps, input)).resolves.toEqual({ ready: true });
    expect(h.events).toEqual([]);
    expect(h.deps.waitForSourceIdle).not.toHaveBeenCalled();
  });

  it("does not mark a source-less released replacement ready until every assigned customer is mounted", async () => {
    const h = harness({
      pods: [{ ...targetPod, ready: true }],
      targetReleased: true,
      assignments: [assignment("u1", "alice", {
        state: "quiescing",
        updatedByOperationId: "surge-default-target-uid",
      })],
      targetMountedCustomers: [],
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      stateMigration: MIGRATE_STATE,
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual([]);
    expect(h.assignments()[0]).toMatchObject({
      state: "quiescing",
      updatedByOperationId: "surge-default-target-uid",
    });
    expect(h.deps.log).toHaveBeenCalledWith(expect.stringContaining("assigned mounted roster"));
  });

  it("waits with both pods gated after target readiness opens", async () => {
    const h = harness({
      pods: [oldPod, { ...targetPod, ready: true }],
      targetReleased: true,
      assignments: [assignment("u1", "alice", {
        state: "quiescing",
        updatedByOperationId: "surge-default-target-uid",
      })],
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      stateMigration: MIGRATE_STATE,
    })).resolves.toEqual({ ready: false });
    expect(h.events).toEqual([]);
  });

  it("releases a sourceless shared target, then heals its owned roster gates", async () => {
    const pods: SurgePod[] = [targetPod];
    const h = harness({
      pods,
      targetMountedCustomers: ["alice"],
      assignments: [assignment("u1", "alice", {
        state: "quiescing",
        updatedByOperationId: "surge-default-target-uid",
      })],
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      stateMigration: MIGRATE_STATE,
    })).resolves.toEqual({ ready: false });
    expect(h.events).toEqual(["release:target-uid"]);

    h.setTargetReleased(true);
    pods[0] = { ...targetPod, ready: true };
    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      stateMigration: MIGRATE_STATE,
    })).resolves.toEqual({ ready: true });
    expect(h.events).toEqual([
      "release:target-uid",
      "assignment:u1:serving",
    ]);
  });

  it("does not accept source loss while the old pod still exists but is NotReady", async () => {
    const h = harness({ pods: [{ ...oldPod, ready: false }, targetPod] });

    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(reconcileSurgeCustomerHandoff(h.deps, {
        gatewayId: "default",
        desiredImageTag: "new-sha",
        requiresCustomerMigration: true,
        stateMigration: MIGRATE_STATE,
      })).resolves.toEqual({ ready: false });
    }
    expect(h.events).toEqual([]);
  });

  it("releases an empty release migration without requiring a healthy source pod", async () => {
    const h = harness({
      pods: [{ ...oldPod, ready: false }, targetPod],
      assignments: [],
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "trial-op-000001",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      stateMigration: MIGRATE_STATE,
      ownerlessOperatorPrewarm: true,
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual(["release:target-uid"]);
  });

  it("keeps a non-empty operator prewarm closed while its source pod is NotReady", async () => {
    const h = harness({
      pods: [{ ...oldPod, ready: false }, targetPod],
      assignments: [assignment("u1", "alice")],
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "trial-op-000001",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      stateMigration: MIGRATE_STATE,
      ownerlessOperatorPrewarm: true,
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual([]);
  });

  it("leaves an empty same-release replacement to the pod-side readiness gate", async () => {
    const h = harness({
      pods: [{ ...oldPod, ready: false }, targetPod],
      assignments: [],
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "trial-op-000001",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: false,
      stateMigration: MIGRATE_STATE,
      ownerlessOperatorPrewarm: true,
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual([]);
  });

  it("does not bypass source health for an empty customer gateway release migration", async () => {
    const h = harness({
      pods: [{ ...oldPod, ready: false }, targetPod],
      assignments: [],
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      stateMigration: MIGRATE_STATE,
      ownerlessOperatorPrewarm: false,
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual([]);
  });

  it("reclaims an abandoned surge gate before retrying the verified handoff", async () => {
    const h = harness({
      assignments: [assignment("u1", "alice", {
        state: "quiescing",
        updatedByOperationId: abandonedOperationId,
      })],
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      stateMigration: MIGRATE_STATE,
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual([
      "assignment:u1:serving",
      "assignment:u1:quiescing",
      "quiesce:alice",
      "transfer:alice",
      "digest:old-uid:alice",
      "digest:target-uid:alice",
      "release:target-uid",
    ]);
    expect(h.assignments()[0]).toMatchObject({
      state: "quiescing",
      updatedByOperationId: h.operationId,
    });
  });

  it("reclaims the completed prior handoff when its target becomes the next Ready source", async () => {
    const priorTargetUid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const priorTarget = {
      ...oldPod,
      uid: priorTargetUid,
      name: "gateway-prior-target",
    };
    const priorOperationId = `surge-default-${priorTargetUid}`;
    const h = harness({
      pods: [priorTarget, targetPod],
      assignments: [assignment("u1", "alice", {
        state: "quiescing",
        updatedByOperationId: priorOperationId,
      })],
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      stateMigration: MIGRATE_STATE,
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual([
      "assignment:u1:serving",
      "assignment:u1:quiescing",
      "quiesce:alice",
      "transfer:alice",
      `digest:${priorTargetUid}:alice`,
      "digest:target-uid:alice",
      "release:target-uid",
    ]);
    expect(h.assignments()[0]).toMatchObject({
      state: "quiescing",
      updatedByOperationId: h.operationId,
    });
  });

  it("reopens an abandoned surge gate while Kubernetes replaces the missing target", async () => {
    const h = harness({
      pods: [oldPod],
      assignments: [assignment("u1", "alice", {
        state: "quiescing",
        updatedByOperationId: abandonedOperationId,
      })],
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      stateMigration: MIGRATE_STATE,
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual(["assignment:u1:serving"]);
    expect(h.assignments()[0]).toMatchObject({
      state: "serving",
      updatedByOperationId: abandonedOperationId,
    });
  });

  it("keeps an assignment gated while its owner pod object is terminating", async () => {
    const h = harness({
      pods: [oldPod],
      observedPodUids: [oldPod.uid, abandonedPodUid],
      assignments: [assignment("u1", "alice", {
        state: "quiescing",
        updatedByOperationId: abandonedOperationId,
      })],
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      stateMigration: MIGRATE_STATE,
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual([]);
    expect(h.assignments()[0]).toMatchObject({
      state: "quiescing",
      updatedByOperationId: abandonedOperationId,
    });
  });

  it("reopens an abandoned surge gate after the replacement becomes the only pod", async () => {
    const h = harness({
      pods: [{ ...targetPod, ready: true }],
      targetReleased: true,
      targetMountedCustomers: ["alice"],
      assignments: [assignment("u1", "alice", {
        state: "quiescing",
        updatedByOperationId: abandonedOperationId,
      })],
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      stateMigration: MIGRATE_STATE,
    })).resolves.toEqual({ ready: true });

    expect(h.events).toEqual(["assignment:u1:serving"]);
    expect(h.assignments()[0]).toMatchObject({
      state: "serving",
      updatedByOperationId: h.operationId,
    });
  });

  it("does not reclaim a surge gate while its owning pod still exists", async () => {
    const h = harness({
      assignments: [assignment("u1", "alice", {
        state: "quiescing",
        updatedByOperationId: "surge-default-old-uid",
      })],
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      stateMigration: MIGRATE_STATE,
    })).rejects.toThrow(/foreign assignment gate/);
    expect(h.events).toEqual([]);
  });

  it("does not reclaim a surge gate owned by a gateway with a shared prefix", async () => {
    const h = harness({
      assignments: [assignment("u1", "alice", {
        state: "quiescing",
        updatedByOperationId: otherGatewayOperationId,
      })],
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      stateMigration: MIGRATE_STATE,
    })).rejects.toThrow(/foreign assignment gate/);
    expect(h.events).toEqual([]);
  });

  it("reclaims a lease whose owning operation is no longer running", async () => {
    const h = harness({
      assignments: [assignment("u1", "alice", {
        state: "quiescing",
        updatedByOperationId: "placement-f061f700711dbdec1d7f8f2add33d1d3",
      })],
      ownerOperations: {
        "placement-f061f700711dbdec1d7f8f2add33d1d3": { status: "failed" },
      },
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      stateMigration: MIGRATE_STATE,
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual([
      "assignment:u1:serving",
      "assignment:u1:quiescing",
      "quiesce:alice",
      "transfer:alice",
      "digest:old-uid:alice",
      "digest:target-uid:alice",
      "release:target-uid",
    ]);
    expect(h.deps.log).toHaveBeenCalledWith(expect.stringContaining(
      "owner=placement-f061f700711dbdec1d7f8f2add33d1d3: owning operation is failed",
    ));
  });

  it("does not reopen a terminal migration's source gate before native recovery", async () => {
    const owner = "builder-activate-alice-s-12345678-g1";
    const h = harness({ assignments: [assignment("u1", "alice", { state: "quiescing", updatedByOperationId: owner })],
      ownerOperations: { [owner]: { status: "failed", sourceRecoveryPending: true } },
    });
    await expect(reconcileSurgeCustomerHandoff(h.deps, { gatewayId: "default", desiredImageTag: "new-sha", requiresCustomerMigration: true, stateMigration: MIGRATE_STATE })).rejects.toThrow(/foreign assignment gate/);
    expect(h.events).toEqual([]);
    expect(h.assignments()[0].state).toBe("quiescing");
  });

  it("reclaims a lease whose owning operation no longer exists", async () => {
    const h = harness({
      assignments: [assignment("u1", "alice", {
        state: "quiescing",
        updatedByOperationId: "placement-deleted",
      })],
      ownerOperations: { "placement-deleted": null },
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      stateMigration: MIGRATE_STATE,
    })).resolves.toEqual({ ready: false });

    expect(h.events[0]).toBe("assignment:u1:serving");
    expect(h.deps.log).toHaveBeenCalledWith(expect.stringContaining(
      "owner=placement-deleted: owning operation no longer exists",
    ));
  });

  it("refuses a foreign migration gate", async () => {
    const h = harness({
      assignments: [assignment("u1", "alice", {
        state: "quiescing",
        updatedByOperationId: "migrate-customer-op",
      })],
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      stateMigration: MIGRATE_STATE,
    })).rejects.toThrow(/foreign assignment gate/);
    expect(h.events).toEqual([]);
  });

  it("reopens its assignments when transfer fails before target release", async () => {
    const h = harness({
      assignments: [assignment("u1", "alice")],
      transferError: new Error("rsync failed"),
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      stateMigration: MIGRATE_STATE,
    })).rejects.toThrow("rsync failed");
    expect(h.events).toEqual([
      "assignment:u1:quiescing",
      "quiesce:alice",
      "transfer:alice",
      "discard:alice",
      "assignment:u1:serving",
    ]);
  });

  it("preserves configured Builder target state when its transfer fails", async () => {
    const h = harness({
      assignments: [assignment("u1", "alice")],
      transferError: new Error("rsync failed"),
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      disposableBuilderGateway: true,
      stateMigration: MIGRATE_STATE,
    })).rejects.toThrow("rsync failed");

    expect(h.events).toEqual([
      "assignment:u1:quiescing",
      "quiesce:alice",
      "flush:old-uid:alice:migration-final",
      "hold-target:target-uid:alice",
      "stop-source:old-uid:alice",
      "transfer:alice",
      "hold-target:target-uid:alice",
      "resume-source:old-uid:alice",
      "assignment:u1:serving",
    ]);
    expect(h.deps.discardTargetCustomer).not.toHaveBeenCalled();
  });

  it.each(["old-image", "source-held", "source-unready", "source-terminating", "source-missing-roster", "source-migrating",
    "target-starting", "target-hydrated", "target-released", "target-mounted", "target-migrating", "target-terminating",
    "missing-held-proof", "false-held-proof", "wrong-terminal-slug", "quiescing-assignment", "third-observed-uid",
    "budget-spent", "changed-after-budget", "epoch-after-budget", "owner-after-budget", "source-name-after-budget"])("refuses cancelled-target replacement when %s", async fault => {
    const pods = [{ ...oldPod }, { ...targetPod }];
    const assigned = assignment("u1", "alice", fault === "quiescing-assignment" ? { state: "quiescing", updatedByOperationId: "foreign" } : {});
    const h = harness({ pods, observedPodUids: fault === "third-observed-uid" ? [oldPod.uid, targetPod.uid, "pending"] : undefined,
      assignments: [assigned],
      evictionBudgetSpent: fault === "budget-spent" });
    if (fault === "source-unready") pods[0].ready = false;
    if (fault === "source-terminating") pods[0].terminating = true;
    if (fault === "target-terminating") pods[1].terminating = true;
    vi.mocked(h.deps.readPodHealth).mockImplementation(async pod => ({
      status: pod.uid === oldPod.uid ? "ready" : "booting", version: pod.uid === oldPod.uid ? "old-sha" : "new-sha",
      fleetSignatureCapability: "gateway-scoped", handoffReleased: pod.uid === targetPod.uid && fault === "target-released",
      prelaunchState: pod.uid === oldPod.uid ? fault === "source-held" ? "held" : "serving" :
        fault === "target-starting" ? "starting" : fault === "target-hydrated" ? "hydrated" : "held",
      mountedCustomers: pod.uid === oldPod.uid ? fault === "source-missing-roster" ? [] : ["alice"] : fault === "target-mounted" ? ["alice"] : [],
      migratingIn: (pod.uid === oldPod.uid && fault === "source-migrating") || (pod.uid === targetPod.uid && fault === "target-migrating") ? ["alice"] : [],
      ...(pod.uid === targetPod.uid ? { terminalTarget: { migrationId: h.operationId, targetPodUid: pod.uid,
        slug: fault === "wrong-terminal-slug" ? "bob" : "alice",
        ...(fault === "missing-held-proof" ? {} : { processHeld: fault !== "false-held-proof" }) } } : {}),
    }));
    if (["changed-after-budget", "epoch-after-budget", "owner-after-budget", "source-name-after-budget"].includes(fault)) vi.mocked(h.deps.claimCrashLoopEviction).mockImplementation(async () => {
      if (fault === "changed-after-budget") pods[0].ready = false;
      if (fault === "epoch-after-budget") assigned.epoch += 1;
      if (fault === "owner-after-budget") assigned.updatedByOperationId = "another-operation";
      if (fault === "source-name-after-budget") pods[0].name = "another-source";
      return { allowed: true, count: 1, budget: 3 };
    });
    await reconcileSurgeCustomerHandoff(h.deps, { gatewayId: "default", desiredImageTag: "new-sha", requiresCustomerMigration: true,
      disposableBuilderGateway: fault !== "old-image", stateMigration: MIGRATE_STATE });
    expect(h.deps.deleteCancelledTarget).not.toHaveBeenCalled();
    expect(h.deps.waitForSourceIdle).not.toHaveBeenCalled();
    expect(h.events).toEqual([]);
  });

  it("discards every target customer touched when a later transfer fails", async () => {
    const h = harness({
      transferError: new Error("bob rsync failed"),
      transferErrorSlug: "bob",
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      stateMigration: MIGRATE_STATE,
    })).rejects.toThrow("bob rsync failed");

    expect(h.events).toEqual([
      "assignment:u1:quiescing",
      "quiesce:alice",
      "transfer:alice",
      "digest:old-uid:alice",
      "digest:target-uid:alice",
      "assignment:u2:quiescing",
      "quiesce:bob",
      "transfer:bob",
      "discard:bob",
      "discard:alice",
      "assignment:u1:serving",
      "assignment:u2:serving",
    ]);
  });

  it("cleans stale target mounts before replaying a handoff", async () => {
    const h = harness({ targetMountedCustomers: ["alice"] });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      stateMigration: MIGRATE_STATE,
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual([
      "assignment:u1:quiescing",
      "discard:alice",
      "assignment:u1:serving",
      "assignment:u1:quiescing",
      "quiesce:alice",
      "transfer:alice",
      "digest:old-uid:alice",
      "digest:target-uid:alice",
      "assignment:u2:quiescing",
      "quiesce:bob",
      "transfer:bob",
      "digest:old-uid:bob",
      "digest:target-uid:bob",
      "release:target-uid",
    ]);
  });

  it("preserves a configured Builder target mount before replaying a handoff", async () => {
    const h = harness({
      assignments: [assignment("u1", "alice")],
      targetMountedCustomers: ["alice"],
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      disposableBuilderGateway: true,
      stateMigration: MIGRATE_STATE,
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual([
      "assignment:u1:quiescing",
      "quiesce:alice",
      "flush:old-uid:alice:migration-final",
      "hold-target:target-uid:alice",
      "stop-source:old-uid:alice",
      "transfer:alice",
      "digest:old-uid:alice",
      "digest:target-uid:alice",
      "release:target-uid",
    ]);
    expect(h.deps.discardTargetCustomer).not.toHaveBeenCalled();
  });

  it("transfers into a held prelaunch Builder target whose OpenClaw is intentionally stopped", async () => {
    const h = harness({
      assignments: [assignment("u1", "alice")],
      bootingUids: [targetPod.uid],
      prelaunchByUid: { [targetPod.uid]: "hydrated" },
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      disposableBuilderGateway: true,
      stateMigration: MIGRATE_STATE,
    })).resolves.toEqual({ ready: false });

    expect(h.events).toContain("transfer:alice");
    expect(h.events).toContain("release:target-uid");
  });

  it("keeps a booting non-prelaunch target out of transfer", async () => {
    const booting = harness({
      assignments: [assignment("u1", "alice")],
      bootingUids: [targetPod.uid],
    });
    await expect(reconcileSurgeCustomerHandoff(booting.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      disposableBuilderGateway: true,
      stateMigration: MIGRATE_STATE,
    })).resolves.toEqual({ ready: false });
    expect(booting.events).toEqual([]);

    const starting = harness({
      assignments: [assignment("u1", "alice")],
      bootingUids: [targetPod.uid],
      prelaunchByUid: { [targetPod.uid]: "starting" },
    });
    await expect(reconcileSurgeCustomerHandoff(starting.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      disposableBuilderGateway: true,
      stateMigration: MIGRATE_STATE,
    })).resolves.toEqual({ ready: false });
    expect(starting.events).toEqual([]);
  });

  it("retries the handoff for a Builder target left released but held by a rollback race", async () => {
    const h = harness({
      assignments: [assignment("u1", "alice")],
      targetReleased: true,
      bootingUids: [targetPod.uid],
      prelaunchByUid: { [targetPod.uid]: "hydrated" },
      targetMountedCustomers: ["alice"],
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      disposableBuilderGateway: true,
      stateMigration: MIGRATE_STATE,
    })).resolves.toEqual({ ready: false });

    expect(h.events).toContain("transfer:alice");
    expect(h.events).toContain("release:target-uid");
  });

  it("resumes a held NotReady Builder source instead of waiting forever and restores its roster", async () => {
    const h = harness({
      pods: [{ ...oldPod, ready: false }, targetPod],
      assignments: [{ ...assignment("u1", "alice"), state: "quiescing", updatedByOperationId: "surge-default-target-uid" }],
      bootingUids: [oldPod.uid, targetPod.uid],
      prelaunchByUid: { [oldPod.uid]: "held", [targetPod.uid]: "hydrated" },
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      disposableBuilderGateway: true,
      stateMigration: MIGRATE_STATE,
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual(["resume-source:old-uid:alice", "assignment:u1:serving"]);
  });

  it("releases source voice admission before restoring a recovered Builder assignment", async () => {
    const h = harness({
      pods: [{ ...oldPod, ready: false }, targetPod],
      assignments: [{ ...assignment("u1", "alice"), state: "quiescing", updatedByOperationId: "surge-default-target-uid" }],
      bootingUids: [oldPod.uid, targetPod.uid],
      prelaunchByUid: { [oldPod.uid]: "held", [targetPod.uid]: "hydrated" },
    });
    vi.mocked(h.deps.resumeSourceIngress).mockImplementation(async () => {
      expect(h.assignments()[0].state).toBe("quiescing");
    });
    await reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default", desiredImageTag: "new-sha", requiresCustomerMigration: true,
      disposableBuilderGateway: true, stateMigration: MIGRATE_STATE,
    });
    expect(h.deps.resumeSourceIngress).toHaveBeenCalledWith(expect.objectContaining({ slug: "alice", sourcePod: expect.objectContaining({ uid: oldPod.uid }) }));
    expect(h.assignments()[0].state).toBe("serving");
  });

  it("keeps a recovered Builder gated if its voice admission cannot resume", async () => {
    const h = harness({
      pods: [{ ...oldPod, ready: false }, targetPod],
      assignments: [{ ...assignment("u1", "alice"), state: "quiescing", updatedByOperationId: "surge-default-target-uid" }],
      bootingUids: [oldPod.uid, targetPod.uid],
      prelaunchByUid: { [oldPod.uid]: "held", [targetPod.uid]: "hydrated" },
    });
    vi.mocked(h.deps.resumeSourceIngress).mockRejectedValueOnce(new Error("voice admission unavailable"));
    await reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default", desiredImageTag: "new-sha", requiresCustomerMigration: true,
      disposableBuilderGateway: true, stateMigration: MIGRATE_STATE,
    });
    expect(h.assignments()[0].state).toBe("quiescing");
    expect(h.deps.log).toHaveBeenCalledWith(expect.stringContaining("voice admission unavailable"));
  });

  it("does not read assignments for a Barn whose source is missing or NotReady", async () => {
    const h = harness({
      pods: [{ ...oldPod, ready: false }, targetPod],
      bootingUids: [oldPod.uid],
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      stateMigration: MIGRATE_STATE,
    })).resolves.toEqual({ ready: false });

    expect(h.deps.readAssignments).not.toHaveBeenCalled();
    expect(h.events).toEqual([]);
  });

  it("leaves a NotReady non-held Builder source to recover on its own", async () => {
    const h = harness({
      pods: [{ ...oldPod, ready: false }, targetPod],
      assignments: [assignment("u1", "alice")],
      bootingUids: [oldPod.uid, targetPod.uid],
      prelaunchByUid: { [oldPod.uid]: "serving", [targetPod.uid]: "hydrated" },
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      disposableBuilderGateway: true,
      stateMigration: MIGRATE_STATE,
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual([]);
  });

  it("unreserves a sourceless reserved Builder target so it may rebuild from durable state", async () => {
    const h = harness({
      pods: [targetPod],
      assignments: [assignment("u1", "alice")],
      bootingUids: [targetPod.uid],
      prelaunchByUid: { [targetPod.uid]: "held" },
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      disposableBuilderGateway: true,
      stateMigration: MIGRATE_STATE,
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual(["unreserve-target:target-uid:alice"]);
  });

  it("leaves assignments open when a legacy source cannot begin a scoped handoff", async () => {
    const h = harness({
      assignments: [assignment("u1", "alice")],
      fleetSignatureCapabilityByUid: { [oldPod.uid]: "legacy" },
    });
    const input = {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      stateMigration: MIGRATE_STATE,
    };

    await expect(reconcileSurgeCustomerHandoff(h.deps, input)).resolves.toEqual({ ready: false });
    await expect(reconcileSurgeCustomerHandoff(h.deps, input)).resolves.toEqual({ ready: false });

    expect(h.events).toEqual([]);
    expect(h.deps.readAssignments).not.toHaveBeenCalled();
    expect(h.deps.quiesce).not.toHaveBeenCalled();
    expect(h.deps.releaseTarget).not.toHaveBeenCalled();
  });

  it("does not settle a ready legacy target through assignment or release control", async () => {
    const h = harness({
      pods: [{ ...targetPod, ready: true }],
      assignments: [assignment("u1", "alice", {
        state: "quiescing",
        updatedByOperationId: "surge-default-target-uid",
      })],
      targetReleased: true,
      targetMountedCustomers: ["alice"],
      fleetSignatureCapabilityByUid: { [targetPod.uid]: "legacy" },
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      stateMigration: MIGRATE_STATE,
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual([]);
    expect(h.deps.readAssignments).not.toHaveBeenCalled();
    expect(h.deps.releaseTarget).not.toHaveBeenCalled();
  });

  it("gates only the stale target customer when retry cleanup fails", async () => {
    const h = harness({
      targetMountedCustomers: ["alice"],
      discardError: new Error("stale target cleanup failed"),
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      stateMigration: MIGRATE_STATE,
    })).rejects.toThrow("stale target cleanup failed");

    expect(h.events).toEqual([
      "assignment:u1:quiescing",
      "discard:alice",
    ]);
    expect(h.assignments().find((item) => item.uid === "u2")?.state).toBe("serving");
  });

  it("keeps admission closed when batch cleanup fails and attempts every touched customer", async () => {
    const h = harness({
      transferError: new Error("bob rsync failed"),
      transferErrorSlug: "bob",
      discardError: new Error("target cleanup failed"),
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      stateMigration: MIGRATE_STATE,
    })).rejects.toThrow(/target cleanup failed/);

    expect(h.events).toEqual([
      "assignment:u1:quiescing",
      "quiesce:alice",
      "transfer:alice",
      "digest:old-uid:alice",
      "digest:target-uid:alice",
      "assignment:u2:quiescing",
      "quiesce:bob",
      "transfer:bob",
      "discard:bob",
      "discard:alice",
    ]);
  });

  it("rolls back an earlier roster gate when a later gate write fails", async () => {
    const h = harness({ markErrorUid: "u2" });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      stateMigration: MIGRATE_STATE,
    })).rejects.toThrow("assignment write failed");
    expect(h.events).toEqual([
      "assignment:u1:quiescing",
      "quiesce:alice",
      "transfer:alice",
      "digest:old-uid:alice",
      "digest:target-uid:alice",
      "assignment:u2:quiescing",
      "discard:alice",
      "assignment:u1:serving",
    ]);
  });

  it("keeps admission closed when a failed target import cannot be discarded", async () => {
    const h = harness({
      assignments: [assignment("u1", "alice")],
      transferError: new Error("rsync failed"),
      discardError: new Error("target cleanup failed"),
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      stateMigration: MIGRATE_STATE,
    })).rejects.toThrow(/target cleanup failed/);
    expect(h.events).toEqual([
      "assignment:u1:quiescing",
      "quiesce:alice",
      "transfer:alice",
      "discard:alice",
    ]);
  });

  it("confirms a committed target release when its HTTP response is lost", async () => {
    const h = harness({
      assignments: [assignment("u1", "alice")],
      releaseErrorAfterCommit: new Error("connection reset"),
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      stateMigration: MIGRATE_STATE,
    })).resolves.toEqual({ ready: false });
    expect(h.events).toEqual([
      "assignment:u1:quiescing",
      "quiesce:alice",
      "transfer:alice",
      "digest:old-uid:alice",
      "digest:target-uid:alice",
      "release:target-uid",
    ]);
  });

  it("retries a digest-verified Builder target release after it returns to hold", async () => {
    const wait = vi.fn(async () => undefined);
    const h = harness({
      assignments: [assignment("u1", "alice")],
      prelaunchByUid: { [targetPod.uid]: "hydrated" },
      releaseErrorBeforeCommit: new Error("target supervisor restarted"),
      releaseErrorBeforeCommitOnce: true,
      wait,
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      disposableBuilderGateway: true,
      stateMigration: MIGRATE_STATE,
    })).resolves.toEqual({ ready: false });

    expect(wait).toHaveBeenCalledWith(7_000);
    expect(h.events).toEqual([
      "assignment:u1:quiescing",
      "quiesce:alice",
      "flush:old-uid:alice:migration-final",
      "hold-target:target-uid:alice",
      "stop-source:old-uid:alice",
      "transfer:alice",
      "digest:old-uid:alice",
      "digest:target-uid:alice",
      "release:target-uid",
      "release:target-uid",
    ]);
    expect(h.deps.resumeSourceOpenClaw).not.toHaveBeenCalled();
  });

  it("confirms a Builder target release that commits during the retry delay", async () => {
    const target = { release: () => undefined };
    const wait = vi.fn(async () => {
      target.release();
    });
    const h = harness({
      assignments: [assignment("u1", "alice")],
      releaseErrorBeforeCommit: new Error("connection reset"),
      wait,
    });
    target.release = () => h.setTargetReleased(true);

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      disposableBuilderGateway: true,
      stateMigration: MIGRATE_STATE,
    })).resolves.toEqual({ ready: false });

    expect(wait).toHaveBeenCalledWith(7_000);
    expect(h.events).toEqual([
      "assignment:u1:quiescing",
      "quiesce:alice",
      "flush:old-uid:alice:migration-final",
      "hold-target:target-uid:alice",
      "stop-source:old-uid:alice",
      "transfer:alice",
      "digest:old-uid:alice",
      "digest:target-uid:alice",
      "release:target-uid",
    ]);
    expect(h.deps.resumeSourceOpenClaw).not.toHaveBeenCalled();
  });

  it("keeps admission closed when target release cannot be confirmed", async () => {
    const h = harness({
      assignments: [assignment("u1", "alice")],
      releaseErrorBeforeCommit: new Error("connection refused"),
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      stateMigration: MIGRATE_STATE,
    })).rejects.toThrow("connection refused");
    expect(h.events).toEqual([
      "assignment:u1:quiescing",
      "quiesce:alice",
      "transfer:alice",
      "digest:old-uid:alice",
      "digest:target-uid:alice",
      "release:target-uid",
    ]);
    expect(h.assignments()[0]).toMatchObject({
      state: "quiescing",
      updatedByOperationId: h.operationId,
    });
  });
  it("stands down instead of converging a pod a pending release replaces", async () => {
    const h = harness();

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      stateMigration: MIGRATE_STATE,
      supersedingImageTag: "next-sha",
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual([]);
    expect(h.assignments().every((item) => item.state === "serving")).toBe(true);
  });

  it("resumes a held Builder source while standing down for a pending release", async () => {
    const h = harness({
      pods: [{ ...oldPod, ready: false }, targetPod],
      assignments: [assignment("u1", "alice", {
        state: "quiescing",
        updatedByOperationId: "surge-default-target-uid",
      })],
      bootingUids: [oldPod.uid, targetPod.uid],
      prelaunchByUid: { [oldPod.uid]: "held", [targetPod.uid]: "hydrated" },
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      disposableBuilderGateway: true,
      stateMigration: MIGRATE_STATE,
      supersedingImageTag: "next-sha",
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual(["resume-source:old-uid:alice", "assignment:u1:serving"]);
  });

  it("releases a live source voice hold when superseding a held Builder target", async () => {
    const h = harness({
      assignments: [{ ...assignment("u1", "alice"), state: "quiescing", updatedByOperationId: "surge-default-target-uid" }],
      prelaunchByUid: { [targetPod.uid]: "hydrated" },
    });
    vi.mocked(h.deps.resumeSourceIngress).mockImplementation(async () => {
      expect(h.assignments()[0].state).toBe("quiescing");
    });
    await reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default", desiredImageTag: "new-sha", requiresCustomerMigration: true,
      disposableBuilderGateway: true, stateMigration: MIGRATE_STATE, supersedingImageTag: "next-sha",
    });
    expect(h.deps.resumeSourceIngress).toHaveBeenCalledOnce();
    expect(h.assignments()[0].state).toBe("serving");
  });

  it.each([false, true])("keeps source admission closed when a superseded target may be executing (held=%s)", async (held) => {
    const h = harness({
      pods: [{ ...oldPod, ready: !held }, targetPod],
      assignments: [{ ...assignment("u1", "alice"), state: "quiescing", updatedByOperationId: "surge-default-target-uid" }],
      bootingUids: [targetPod.uid, ...(held ? [oldPod.uid] : [])],
      prelaunchByUid: { [oldPod.uid]: held ? "held" : "serving", [targetPod.uid]: "starting" },
    });
    await reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default", desiredImageTag: "new-sha", requiresCustomerMigration: true,
      disposableBuilderGateway: true, stateMigration: MIGRATE_STATE, supersedingImageTag: "next-sha",
    });
    expect(h.deps.resumeSourceOpenClaw).not.toHaveBeenCalled();
    expect(h.deps.resumeSourceIngress).not.toHaveBeenCalled();
    expect(h.assignments()[0].state).toBe("quiescing");
  });

  it("unreserves a sourceless Builder target while standing down for a pending release", async () => {
    const h = harness({
      pods: [targetPod],
      assignments: [assignment("u1", "alice")],
      bootingUids: [targetPod.uid],
      prelaunchByUid: { [targetPod.uid]: "held" },
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      disposableBuilderGateway: true,
      stateMigration: MIGRATE_STATE,
      supersedingImageTag: "next-sha",
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual(["unreserve-target:target-uid:alice"]);
  });

  it("still settles a released target while a rollout is queued", async () => {
    const h = harness({
      pods: [{ ...targetPod, ready: true }],
      targetReleased: true,
      targetMountedCustomers: ["alice"],
      assignments: [assignment("u1", "alice")],
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      stateMigration: MIGRATE_STATE,
      supersedingImageTag: "next-sha",
    })).resolves.toEqual({ ready: true });
  });

  it("reopens a gated lease for the sourceless target it unreserves while standing down", async () => {
    const h = harness({
      pods: [targetPod],
      assignments: [assignment("u1", "alice", {
        state: "quiescing",
        updatedByOperationId: "surge-default-target-uid",
      })],
      bootingUids: [targetPod.uid],
      prelaunchByUid: { [targetPod.uid]: "held" },
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      disposableBuilderGateway: true,
      stateMigration: MIGRATE_STATE,
      supersedingImageTag: "next-sha",
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual([
      "unreserve-target:target-uid:alice",
      "assignment:u1:serving",
    ]);
  });

  it("retains its source gate when a superseded shared target has unknown execution state", async () => {
    const h = harness({
      assignments: [assignment("u1", "alice", {
        state: "quiescing",
        updatedByOperationId: "surge-default-target-uid",
      })],
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      stateMigration: MIGRATE_STATE,
      supersedingImageTag: "next-sha",
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual([]);
    expect(h.assignments()[0]).toMatchObject({ state: "quiescing" });
  });

  it("retains an abandoned source gate until a superseded shared target is known held", async () => {
    const h = harness({
      assignments: [assignment("u1", "alice", {
        state: "quiescing",
        updatedByOperationId: abandonedOperationId,
      })],
    });

    await expect(reconcileSurgeCustomerHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresCustomerMigration: true,
      stateMigration: MIGRATE_STATE,
      supersedingImageTag: "next-sha",
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual([]);
    expect(h.assignments()[0]).toMatchObject({ state: "quiescing" });
  });
});

describe("crash-looping surge target self-heal", () => {
  const wedgedTarget: SurgePod = { ...targetPod, crashLooping: true };
  const input = { gatewayId: "default", desiredImageTag: "new-sha", requiresCustomerMigration: false, stateMigration: MIGRATE_STATE };

  it("deletes an unreachable crash-looping target so a fresh pod restarts the handoff, while the predecessor keeps serving", async () => {
    const h = harness({ pods: [oldPod, wedgedTarget], unreachableUids: [wedgedTarget.uid] });

    await expect(reconcileSurgeCustomerHandoff(h.deps, input)).resolves.toEqual({ ready: false });

    expect(h.deps.claimCrashLoopEviction).toHaveBeenCalledExactlyOnceWith({ gatewayId: "default", imageTag: "new-sha", pod: wedgedTarget });
    expect(h.deps.deleteCrashLoopingPod).toHaveBeenCalledExactlyOnceWith({ gatewayId: "default", pod: wedgedTarget });
    expect(h.events).toEqual([`delete-pod:${wedgedTarget.uid}`]);
    expect(h.deps.log).toHaveBeenCalledWith(expect.stringMatching(/deleted crash-looping surge target pod=gateway-new \(eviction 1 of 3 for image new-sha\)/));
  });

  it("leaves the pod in place once the eviction budget for that image is spent, so a broken release stays visible", async () => {
    const h = harness({ pods: [oldPod, wedgedTarget], unreachableUids: [wedgedTarget.uid], evictionBudgetSpent: true });

    await reconcileSurgeCustomerHandoff(h.deps, input).catch(() => undefined);

    expect(h.deps.deleteCrashLoopingPod).not.toHaveBeenCalled();
    expect(h.deps.log).toHaveBeenCalledWith(expect.stringMatching(/leaving crash-looping surge target pod=gateway-new in place: the eviction budget of 3 for image new-sha is spent/));
  });

  it("leaves the pod alone when it is the only pod, when it is merely unreachable, or when it is Ready", async () => {
    const alone = harness({ pods: [wedgedTarget], unreachableUids: [wedgedTarget.uid] });
    await reconcileSurgeCustomerHandoff(alone.deps, input);
    expect(alone.deps.deleteCrashLoopingPod).not.toHaveBeenCalled();

    const unreachable = harness({ pods: [oldPod, targetPod], unreachableUids: [targetPod.uid] });
    await reconcileSurgeCustomerHandoff(unreachable.deps, input);
    expect(unreachable.deps.deleteCrashLoopingPod).not.toHaveBeenCalled();

    const readyButFlagged = harness({ pods: [{ ...oldPod, crashLooping: true }, targetPod] });
    await reconcileSurgeCustomerHandoff(readyButFlagged.deps, input);
    expect(readyButFlagged.deps.deleteCrashLoopingPod).not.toHaveBeenCalled();
  });
});
