import { describe, expect, it } from "vitest";
import type { Firestore, Transaction } from "firebase-admin/firestore";
import { sharedAgentAnchorMigrationScope, sharedAssignedSourceSurgeAnchorScope } from "./shared-agent-anchor-migration.js";

function fixture(kind: "v2" | "legacy" = "v2") {
  const operationId = "move-bob", migrationId = `mig-${operationId}`;
  const source = "shared-source", target = "shared-target";
  const root = (gatewayId: string) => ({ gatewayId, createdAt: 1, createdBy: "test", updatedAt: 1, updatedBy: "test", latestRelease: 1,
    desiredRelease: 1, liveRelease: 1, desiredStatus: "running", configSchemaVersion: 1, profile: null, gatewayClass: "shared", imageProfile: "standard",
    sizingTier: null, gcpProject: null, gatewayContainerSecurityContext: null, serviceAccountName: null, serviceAccount: null, builderAccess: null,
    ownerUid: null, builderSlug: null, modelBrokerLimits: null, preemption: null });
  const v2 = { phase: "sourceQuiesced", operationId, migrationId, uid: "uid-bob", slug: "bob", sourceGatewayId: source, targetGatewayId: target, sourceEpoch: 7, sourceAssignmentMode: "assigned" };
  const handoff = { migrationId: `${migrationId}:scheduler:1:claim:50`, uid: "uid-bob", slug: "bob", fromGatewayId: source, toGatewayId: target,
    forwardRecovery: { schemaVersion: 1, phase: "source-flushed", sourceEpoch: 7 } };
  const operation: Record<string, any> = { kind: "migrate-customer", status: "running", startedAt: 50, cancellationRequestedAt: 60,
    input: { uid: "uid-bob", fromGatewayId: source, toGatewayId: target }, ...(kind === "v2" ? { customerMigrationV2: v2 } : { schedulerHandoff: handoff }) };
  const assigned = { uid: "uid-bob", slug: "bob", gatewayId: source, epoch: 7, state: "quiescing", updatedByOperationId: operationId };
  const records: Record<string, unknown> = {
    [`glmOperations/${operationId}`]: operation, [`gateways/${source}`]: root(source), [`gateways/${target}`]: root(target),
    [`gateways/${source}/assignments/uid-bob`]: assigned,
    "users/uid-bob": { username: "bob", provisioning: { openclaw: { gatewayId: source, migration: { operationId, state: "moving" } } } },
  };
  const collection = (path: string): any => ({ path, query: true, where: () => collection(path), limit: () => collection(path), doc: (id: string) => ({ path: `${path}/${id}`, collection: (name: string) => collection(`${path}/${id}/${name}`) }) });
  const db = { collection } as unknown as Firestore;
  const txn = { get: async (ref: { path: string; query?: boolean }) => ref.query
    ? { size: Object.keys(records).filter(path => path.startsWith(`${ref.path}/`)).length,
      docs: Object.entries(records).filter(([path]) => path.startsWith(`${ref.path}/`)).map(([path, data]) => ({ id: path.split("/").at(-1), data: () => data })) }
    : { exists: Object.hasOwn(records, ref.path), data: () => records[ref.path] } } as unknown as Transaction;
  const request = { gatewayId: target, slug: "bob", migrationId };
  const expected = { migrationId, claimStartedAt: 50, sourceGatewayId: source, sourceEpoch: 7 };
  return { operation, v2, handoff, assigned, records, db, txn, source, target, read: (changes = {}) => sharedAgentAnchorMigrationScope(db, txn, { ...request, ...changes }), expected };
}

describe("cancelled Shared migration anchor custody", () => {
  it.each(["v2", "legacy"] as const)("continues exact %s anchor read and report revalidation after the forward boundary", async kind => {
    const f = fixture(kind);
    expect(await f.read()).toMatchObject({ uid: "uid-bob", assignmentEpoch: 7, assignmentState: "quiescing", migration: f.expected });
    expect(await f.read({ expected: f.expected })).toMatchObject({ migration: f.expected });
  });
  it.each(["phase", "claim", "migration", "uid", "slug", "source", "target", "epoch", "assignment"])("rejects cancelled V2 anchor admission after %s changes", async change => {
    const f = fixture();
    if (change === "phase") f.v2.phase = "preSynced";
    if (change === "claim") f.operation.startedAt = 51;
    if (change === "migration") f.v2.migrationId = "mig-other";
    if (change === "uid") f.v2.uid = "other";
    if (change === "slug") f.v2.slug = "other";
    if (change === "source") f.v2.sourceGatewayId = "other";
    if (change === "target") f.v2.targetGatewayId = "other";
    if (change === "epoch") f.v2.sourceEpoch = 8;
    if (change === "assignment") f.assigned.epoch = 8;
    expect(await f.read({ expected: f.expected })).toBeNull();
  });
  it.each(["missing", "schema", "operation", "slug", "epoch"])("rejects cancelled legacy anchor admission with a %s checkpoint mismatch", async change => {
    const f = fixture("legacy");
    if (change === "missing") delete f.operation.schedulerHandoff.forwardRecovery;
    if (change === "schema") f.handoff.forwardRecovery.schemaVersion = 2;
    if (change === "operation") f.handoff.migrationId = "mig-other:scheduler:1:claim:50";
    if (change === "slug") f.handoff.slug = "other";
    if (change === "epoch") f.handoff.forwardRecovery.sourceEpoch = 8;
    expect(await f.read()).toBeNull();
  });
});


function surgeFixture() {
  const f = fixture();
  const original = "11111111-1111-4111-8111-111111111111", receiving = "22222222-2222-4222-8222-222222222222";
  const sourcePod = "33333333-3333-4333-8333-333333333333", migrationId = `surge-${f.target}-${original}`;
  const marker = { operationId: migrationId, targetPodUid: original, receivingPodUid: receiving };
  const assignment: Record<string, any> = { ...f.assigned, gatewayId: f.target, updatedByOperationId: migrationId, updatedAt: 50, sharedSurgeForwardRecovery: marker };
  f.records[`gateways/${f.target}/assignments/uid-bob`] = assignment;
  f.records["users/uid-bob"] = { username: "bob", provisioning: { openclaw: { gatewayId: f.target, status: "complete", migration: { operationId: migrationId, state: "moving", startedAt: 50 } } } };
  const request = { gatewayId: f.target, slug: "bob", migrationId, podUid: receiving };
  const expected = { migrationId, claimStartedAt: 50, sourceGatewayId: f.target, sourceEpoch: 7 };
  return { ...f, marker, assignment, receiving, original, sourcePod, expected,
    readTarget: (podUid = receiving) => sharedAgentAnchorMigrationScope(f.db, f.txn, { ...request, podUid, expected }),
    readSource: (podUid = sourcePod) => sharedAssignedSourceSurgeAnchorScope(f.db, f.txn, { ...request, podUid, uid: "uid-bob" }),
  };
}

describe("Shared surge rebound receiving pod", () => {
  it("admits only the durably rebound receiving pod under the original scheduler operation", async () => {
    const f = surgeFixture();
    expect(await f.readTarget()).toMatchObject({ migration: f.expected });
    expect(await f.readTarget(f.original)).toBeNull();
    expect(await f.readTarget(f.sourcePod)).toBeNull();
    expect(await f.readSource(f.receiving)).toBeNull();
    expect(await f.readSource()).toMatchObject({ sourceSurge: f.expected });
  });
  it.each(["missing", "operation", "logical-target", "receiving", "malformed"])("rejects replacement receiving authority after %s marker changes", async change => {
    const f = surgeFixture();
    if (change === "missing") delete f.assignment.sharedSurgeForwardRecovery;
    if (change === "operation") f.marker.operationId = "other";
    if (change === "logical-target") f.marker.targetPodUid = f.sourcePod;
    if (change === "receiving") f.marker.receivingPodUid = f.sourcePod;
    if (change === "malformed") f.marker.receivingPodUid = "not-a-pod-uid";
    expect(await f.readTarget()).toBeNull();
  });
});
