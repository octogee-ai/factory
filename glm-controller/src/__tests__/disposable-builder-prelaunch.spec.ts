import { disposableBuilderBootMode } from "@octogee/core/disposable-builder-prelaunch";
import { createJournalFixtureStore, fixtureDocumentsAt, journalRowsAtPaths } from "@octogee/core/testing/journal-store";
import { describe, expect, it, vi } from "vitest";
import type { GatewayRuntimeDoc, ReleasePayload } from "@octogee/shared/types/gateway-releases";
import type { DurableGateway } from "../converge-gateway.js";
import { markGatewayLive, refineGatewayConvergenceAction, shouldReconcileDisposablePrelaunch } from "../index.js";
import { reconcileSurgeCustomerHandoff, type SurgeCustomerHandoffDeps, type SurgePrelaunchState } from "../surge-customer-handoff.js";

const repository = "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway-builder";
const imageTag = `f554548-oc2026.7.1@sha256:${"b".repeat(64)}`;
const desiredImage = { imageRepository: repository, imageTag };
const artifact: ReleasePayload = {
  imageRepository: repository.replace(/-builder$/, ""),
  imageTag: imageTag.replace(/b{64}$/, "a".repeat(64)),
  profileImages: { builder: desiredImage },
};

function fixture() {
  const gateway: DurableGateway = {
    gatewayId: "jefe-run", createdAt: 1, createdBy: "test", updatedAt: 2, updatedBy: "test",
    latestRelease: 2, desiredRelease: 2, liveRelease: 1, desiredStatus: "running",
    configSchemaVersion: 1, profile: "builder", gatewayClass: "builder", imageProfile: "builder",
    sizingTier: "s", gcpProject: null, gatewayContainerSecurityContext: null,
    serviceAccountName: null, serviceAccount: null, builderAccess: null,
    ownerUid: "uid-jefe", builderSlug: "jefe", modelBrokerLimits: null,
    allocation: { kind: "disposable-builder", schemaVersion: 1, leaseId: "lease-67", generation: 67, claimedByUid: "uid-jefe" },
  };
  const lease = {
    leaseId: "lease-67", generation: 67, status: "provisioning", targetGatewayId: gateway.gatewayId,
    sourceGatewayId: "shared-blue", sourceAssignmentEpoch: 3, builderSlug: "jefe",
  };
  const user = { username: "jefe", provisioning: { openclaw: { gatewayId: "shared-blue", slug: "jefe", activationLease: lease } } };
  const runtime = {
    docKind: "runtime", gatewayId: gateway.gatewayId, release: 2, lifecycle: "serving", runtime: "gce-vm",
    helm: { ...desiredImage },
    heartbeat: { status: "booting", version: imageTag, mountedCustomers: [] },
  } as unknown as GatewayRuntimeDoc & { runtime?: string };
  const documents = new Map<string, unknown>([
    ["gateways/jefe-run", gateway],
    ["users/uid-jefe", user],
    ["glmGateways/jefe-run", runtime],
    ["gateways/shared-blue", { ...gateway, gatewayId: "shared-blue", gatewayClass: "shared", profile: "standard", imageProfile: "standard", allocation: null, ownerUid: null, builderSlug: null }],
    ["gateways/shared-blue/assignments/uid-jefe", { uid: "uid-jefe", slug: "jefe", gatewayId: "shared-blue", source: "onboarding", state: "serving", epoch: 3 }],
  ]) as Map<string, Record<string, unknown>>;
  const backing = fixtureDocumentsAt(documents);
  const writes = vi.fn((path: string, row: Record<string, unknown>) => backing.set(path, row));
  const store = createJournalFixtureStore(journalRowsAtPaths(documents), { documents: { ...backing, set: writes } });
  const target = { uid: "vm-r2", name: "vm-r2", podIP: "10.0.0.1", ready: false, terminating: false, crashLooping: false };
  const targetHealth = {
    status: "booting" as "booting" | "ready", version: imageTag, fleetSignatureCapability: "gateway-scoped" as const,
    handoffReleased: false, prelaunchState: "held" as SurgePrelaunchState, mountedCustomers: [] as string[],
  };
  const pods = [target];
  const sourceHealth = { ...targetHealth, version: "ab10fce-oc2026.7.1" };
  const releaseTarget = vi.fn();
  const surgeDeps = {
    listPods: async () => ({ pods, observedPodUids: pods.map((pod) => pod.uid) }),
    readPodHealth: async (pod: { uid: string }) => pod.uid === target.uid ? targetHealth : sourceHealth,
    readAssignments: async () => [],
    releaseTarget,
    log: vi.fn(),
  } as unknown as SurgeCustomerHandoffDeps;
  const reconcileSurgeHandoff = vi.fn((input) => reconcileSurgeCustomerHandoff(surgeDeps, input));
  const refine = () => refineGatewayConvergenceAction({
    passDeps: { store, reconcileSurgeHandoff }, gateway, artifact, runtime,
    helmObserved: { ...desiredImage, replicas: 1, ownerUid: gateway.ownerUid, builderSlug: gateway.builderSlug },
    action: { kind: "steady" },
  });
  const markLive = () => markGatewayLive({ store, log: vi.fn() }, gateway, artifact, true);
  const bootMode = () => store.transaction({ label: "test.boot-mode", readOnly: true }, (transaction) =>
    disposableBuilderBootMode({ reader: transaction, gateway }));
  return { gateway, lease, user, runtime, documents, pods, targetHealth, releaseTarget, reconcileSurgeHandoff, refine, markLive, bootMode, writes, store };
}

describe("disposable Builder prelaunch release refresh", () => {
  it("marks a resumed same-release VM serving only after verifying its held prelaunch", async () => {
    const h = fixture();
    h.gateway.liveRelease = 2;
    h.runtime.lifecycle = "provisioning";
    Object.assign(h.runtime.heartbeat, { lastHeartbeatAt: Date.now() });
    await expect(shouldReconcileDisposablePrelaunch(h.store, h.gateway)).resolves.toBe(true);
    await expect(h.refine()).resolves.toEqual({ kind: "mark-live", prelaunchRefresh: true });
    await h.markLive();
    expect(h.documents.get("glmGateways/jefe-run")).toMatchObject({ lifecycle: "serving", release: 2 });
    expect(h.releaseTarget).not.toHaveBeenCalled();
  });
  it.each([
    ["stale heartbeat", (h: ReturnType<typeof fixture>) => { Object.assign(h.runtime.heartbeat, { lastHeartbeatAt: 1 }); }],
    ["future heartbeat", (h: ReturnType<typeof fixture>) => { Object.assign(h.runtime.heartbeat, { lastHeartbeatAt: Date.now() + 60_000 }); }],
    ["serving lifecycle", (h: ReturnType<typeof fixture>) => { h.runtime.lifecycle = "serving"; }],
    ["failed lifecycle", (h: ReturnType<typeof fixture>) => { h.runtime.lifecycle = "failed"; }],
    ["released target", (h: ReturnType<typeof fixture>) => { h.targetHealth.handoffReleased = true; }],
    ["changed source epoch", (h: ReturnType<typeof fixture>) => { h.lease.sourceAssignmentEpoch++; }],
    ["occupied target", (h: ReturnType<typeof fixture>) => { h.documents.set("gateways/jefe-run/assignments/uid-jefe", { state: "serving" }); }],
  ])("does not resume a same-release VM with %s", async (_name, change) => {
    const h = fixture(); h.gateway.liveRelease = 2; h.runtime.lifecycle = "provisioning";
    Object.assign(h.runtime.heartbeat, { lastHeartbeatAt: Date.now() });
    change(h);
    await expect(h.refine()).resolves.toEqual({ kind: "steady" });
    expect(h.writes).not.toHaveBeenCalled();
  });
  it("does not requeue same-release serving gateways as prelaunch", async () => {
    const h = fixture(); h.gateway.liveRelease = 2;
    await expect(shouldReconcileDisposablePrelaunch(h.store, h.gateway)).resolves.toBe(false);
  });
  it("rechecks same-release heartbeat freshness when committing", async () => {
    const h = fixture(); h.gateway.liveRelease = 2; h.runtime.lifecycle = "provisioning";
    Object.assign(h.runtime.heartbeat, { lastHeartbeatAt: Date.now() });
    await expect(h.refine()).resolves.toEqual({ kind: "mark-live", prelaunchRefresh: true });
    Object.assign(h.runtime.heartbeat, { lastHeartbeatAt: 1 });
    await h.markLive();
    expect(h.writes).not.toHaveBeenCalled();
  });
  it("converges release 2 while the exact release-1 allocation remains empty and held on Shared", async () => {
    const h = fixture();
    await expect(shouldReconcileDisposablePrelaunch(h.store, h.gateway)).resolves.toBe(true);
    await expect(h.refine()).resolves.toEqual({ kind: "mark-live", prelaunchRefresh: true });
    expect(h.reconcileSurgeHandoff).toHaveBeenCalledWith(expect.objectContaining({ requiresCustomerMigration: false }));
    expect(h.releaseTarget).not.toHaveBeenCalled();
    expect(h.lease.status).toBe("provisioning");
    expect(h.user.provisioning.openclaw.gatewayId).toBe("shared-blue");
  });
});


describe("prelaunch release admission boundaries", () => {
  it.each(["cluster", undefined])("does not admit a %s runtime to the VM refresh exception", async (runtime) => {
    const h = fixture();
    h.runtime.runtime = runtime;
    await expect(shouldReconcileDisposablePrelaunch(h.store, h.gateway)).resolves.toBe(false);
    await expect(h.refine()).resolves.toEqual({ kind: "steady" });
    expect(h.reconcileSurgeHandoff).toHaveBeenCalledWith(expect.objectContaining({ requiresCustomerMigration: true }));
    expect(h.releaseTarget).not.toHaveBeenCalled();
  });

  it("keeps two held cluster pods behind ordinary migration without releasing either process gate", async () => {
    const h = fixture();
    h.runtime.runtime = "cluster";
    h.pods.unshift({ ...h.pods[0], uid: "pod-r1", name: "pod-r1", podIP: "10.0.0.2" });
    await expect(h.refine()).resolves.toEqual({ kind: "steady" });
    expect(h.reconcileSurgeHandoff).toHaveBeenCalledWith(expect.objectContaining({ requiresCustomerMigration: true }));
    expect(h.releaseTarget).not.toHaveBeenCalled();
    expect(h.writes).not.toHaveBeenCalled();
    expect(h.lease.status).toBe("provisioning");
    expect(h.user.provisioning.openclaw.gatewayId).toBe("shared-blue");
  });

  it.each(["activating", "active", "returning", "failed"])("keeps a %s lease behind ordinary migration", async (status) => {
    const h = fixture();
    h.lease.status = status;
    await expect(shouldReconcileDisposablePrelaunch(h.store, h.gateway)).resolves.toBe(false);
    await expect(h.refine()).resolves.toEqual({ kind: "steady" });
    expect(h.reconcileSurgeHandoff).toHaveBeenCalledWith(expect.objectContaining({ requiresCustomerMigration: true }));
  });

  it.each(["activationOperationId", "activatingAt", "activeAt"])("rejects provisioning records with %s history", async (field) => {
    const h = fixture();
    Object.assign(h.lease, { [field]: 1 });
    await expect(h.refine()).resolves.toEqual({ kind: "steady" });
  });

  it.each([
    ["a different allocation generation", (h: ReturnType<typeof fixture>) => { h.lease.generation++; }],
    ["a different owner", (h: ReturnType<typeof fixture>) => { h.gateway.allocation!.claimedByUid = "someone-else"; }],
    ["a foreign target", (h: ReturnType<typeof fixture>) => { h.lease.targetGatewayId = "other-target"; }],
    ["an already-assigned owner", (h: ReturnType<typeof fixture>) => { h.user.provisioning.openclaw.gatewayId = h.gateway.gatewayId; }],
    ["a moved source assignment", (h: ReturnType<typeof fixture>) => { h.lease.sourceAssignmentEpoch++; }],
    ["a missing source assignment", (h: ReturnType<typeof fixture>) => { h.documents.delete("gateways/shared-blue/assignments/uid-jefe"); }],
    ["an occupied target", (h: ReturnType<typeof fixture>) => { h.documents.set("gateways/jefe-run/assignments/uid-jefe", { state: "serving" }); }],
  ])("rejects %s", async (_name, change) => {
    const h = fixture();
    change(h);
    await expect(h.refine()).resolves.toEqual({ kind: "steady" });
  });

  it.each([
    ["the previous runtime release", (h: ReturnType<typeof fixture>) => { h.runtime.release = 1; }],
    ["a different runtime digest", (h: ReturnType<typeof fixture>) => { h.runtime.helm.imageTag = imageTag.replace(/b/g, "c"); }],
    ["a stale heartbeat", (h: ReturnType<typeof fixture>) => { h.runtime.heartbeat.version = "ab10fce-oc2026.7.1"; }],
    ["mounted runtime data", (h: ReturnType<typeof fixture>) => { h.runtime.heartbeat.mountedCustomers = ["jefe"]; }],
  ])("rejects %s", async (_name, change) => {
    const h = fixture();
    change(h);
    await expect(h.refine()).resolves.toEqual({ kind: "steady" });
  });

  it.each([
    ["a hydrated process gate", (h: ReturnType<typeof fixture>) => { h.targetHealth.prelaunchState = "hydrated"; }],
    ["a released readiness hold", (h: ReturnType<typeof fixture>) => { h.targetHealth.handoffReleased = true; }],
    ["a mounted tenant", (h: ReturnType<typeof fixture>) => { h.targetHealth.mountedCustomers = ["jefe"]; }],
    ["another image", (h: ReturnType<typeof fixture>) => { h.targetHealth.version = "ab10fce-oc2026.7.1"; }],
  ])("requires direct empty held-target evidence despite %s", async (_name, change) => {
    const h = fixture();
    change(h);
    await expect(h.refine()).resolves.toEqual({ kind: "steady" });
    expect(h.releaseTarget).not.toHaveBeenCalled();
  });

  it("does not treat general handoff readiness as a held prelaunch proof", async () => {
    const h = fixture();
    h.reconcileSurgeHandoff.mockResolvedValue({ ready: true });
    await expect(h.refine()).resolves.toEqual({ kind: "steady" });
  });
});

describe("prelaunch release commit fencing", () => {
  it("marks only the release live while keeping the native heartbeat and provisioning lease", async () => {
    const h = fixture();
    await expect(h.refine()).resolves.toEqual({ kind: "mark-live", prelaunchRefresh: true });
    await h.markLive();
    expect(h.documents.get("gateways/jefe-run")).toMatchObject({ liveRelease: 2 });
    expect(h.documents.get("glmGateways/jefe-run")).toMatchObject({ release: 2, heartbeat: h.runtime.heartbeat });
    expect(h.lease.status).toBe("provisioning");
    expect(h.releaseTarget).not.toHaveBeenCalled();
  });

  it.each([
    ["lease advancement", (h: ReturnType<typeof fixture>) => { h.lease.status = "activating"; }],
    ["retirement", (h: ReturnType<typeof fixture>) => { h.documents.set("gateways/jefe-run", { ...h.gateway, desiredStatus: "retired" }); }],
    ["a superseding desired release", (h: ReturnType<typeof fixture>) => { h.documents.set("gateways/jefe-run", { ...h.gateway, desiredRelease: 3, latestRelease: 3 }); }],
    ["a replaced allocation", (h: ReturnType<typeof fixture>) => { h.documents.set("gateways/jefe-run", { ...h.gateway, allocation: { ...h.gateway.allocation, generation: 68 } }); h.lease.generation = 68; }],
    ["an assignment appearing", (h: ReturnType<typeof fixture>) => { h.documents.set("gateways/jefe-run/assignments/uid-jefe", { state: "serving" }); }],
    ["runtime platform replacement", (h: ReturnType<typeof fixture>) => { h.runtime.runtime = "cluster"; }],
    ["runtime replacement", (h: ReturnType<typeof fixture>) => { h.runtime.heartbeat.version = "other-version"; }],
  ])("does not write after %s races with admission", async (_name, change) => {
    const h = fixture();
    await expect(h.refine()).resolves.toEqual({ kind: "mark-live", prelaunchRefresh: true });
    change(h);
    await h.markLive();
    expect(h.writes).not.toHaveBeenCalled();
  });
});


describe("broker boot mode uses the same prelaunch authority", () => {
  it("boots the current target owner normally while its activation lease is still activating", async () => {
    const h = fixture();
    h.lease.status = "activating";
    Object.assign(h.lease, { activationOperationId: "builder-activate-jefe-run-g67" });
    h.user.provisioning.openclaw.gatewayId = h.gateway.gatewayId;
    h.documents.set("gateways/jefe-run/assignments/uid-jefe", { uid: "uid-jefe", slug: "jefe", gatewayId: "jefe-run", source: "onboarding", state: "serving", epoch: 4 });
    await expect(h.bootMode()).resolves.toEqual({ mode: "normal" });
  });

  it("returns prelaunch only for the exact source assignment and empty target", async () => {
    const h = fixture();
    await expect(h.bootMode()).resolves.toEqual({ mode: "prelaunch" });
    h.lease.sourceAssignmentEpoch++;
    await expect(h.bootMode()).rejects.toThrow("prelaunch authority is inconsistent");
  });
  it("boots safely while the source serves and retains the current activation after its final pause", async () => {
    const h = fixture(); h.lease.status = "activating"; Object.assign(h.lease, { activationOperationId: "builder-activate-jefe-run-g67" });
    await expect(h.bootMode()).resolves.toEqual({ mode: "prelaunch" });
    Object.assign(h.documents.get(`gateways/${h.lease.sourceGatewayId}/assignments/uid-jefe`)!, { state: "quiescing" });
    await expect(h.bootMode()).resolves.toEqual({ mode: "activating", migrationId: "mig-builder-activate-jefe-run-g67" });
  });
  it.each(["active", "returning"])("retains normal boot when %s", async status => {
    const h = fixture(); h.lease.status = status; h.user.provisioning.openclaw.gatewayId = h.gateway.gatewayId;
    h.documents.set("gateways/jefe-run/assignments/uid-jefe", { uid: "uid-jefe", slug: "jefe", gatewayId: "jefe-run", source: "onboarding", state: "serving", epoch: 4 });
    await expect(h.bootMode()).resolves.toEqual({ mode: "normal" });
  });
});
