import { expect, it } from "vitest";
import type { DocumentData, Firestore, Transaction } from "firebase-admin/firestore";
import { Firestore as FirestoreClient } from "firebase-admin/firestore";
import { assertSharedSourceRecoveryPredecessor, postgresImportMaintenanceFailureMatches, readPostgresSourceAgentStores, readSharedSourceRecoveryAuthority, type SourceRecoveryAssignment } from "./shared-source-recovery.js";
import { buildOperationAuditIntent, operationAuditMutationFingerprint } from "./operation-audit.js";
const identity: SourceRecoveryAssignment = { uid: "owner", slug: "livefixture", agentId: "octogee-livefixture-coach", assignmentEpoch: 7,
  assignment: { uid: "owner", slug: "livefixture", gatewayId: "shared-old", state: "serving", epoch: 7 } };
function fixture(migration: "identity" | "database" = "identity") {
  const error = "/finish-rsync-import/shared-new: 500 " + JSON.stringify({ error: "import failed", message:
    `[import:livefixture] agents.create failed for octogee-livefixture-coach (AgentDatabaseMaintenanceRequiredError: Agent ${migration} migration requires stopped-writer maintenance; stop active agents and run openclaw doctor --fix.)` });
  const row = { kind: "migrate-customer", status: "failed", origin: "automatic", createdBy: "glm-controller-placement-policy", attempts: 1,
    startedAt: 100, completedAt: 200, rolledBack: true, error,
    input: { uid: "owner", builderSlug: "livefixture", fromGatewayId: "shared-old", toGatewayId: "shared-new", source: "continuous-placement-policy" },
    schedulerHandoff: { migrationId: "mig-placement:scheduler:1:claim:100", uid: "owner", slug: "livefixture", fromGatewayId: "shared-old", toGatewayId: "shared-new" },
    steps: [...["keys-sync-state", "pre-sync-state", "target-scheduler-ready", "wait-for-active-work", "quiesce-source", "flush-source"].map(name => ({ name, status: "done" })),
      { name: "final-sync-state", status: "failed", error }, ...["scheduler-abort", "unmount-target", "scheduler-resume", "resume-ingress"].map(name => ({ name: `rollback:${name}`, status: "done" }))] };
  return { ...row, attemptHistory: [{ attempt: 1, startedAt: row.startedAt, completedAt: row.completedAt, error: row.error, steps: structuredClone(row.steps) }] };
}
it.each(["identity", "database"] as const)("accepts the exact fully rolled-back automatic placement %s maintenance failure", migration => {
  expect(postgresImportMaintenanceFailureMatches(fixture(migration), "placement", identity, "shared-old")).toBe(true);
});
it.each(["foreign-agent", "wrong-class", "wrong-message", "trailing-text"])("refuses a current database maintenance receipt with %s", changed => {
  const row = fixture("database");
  const failure = JSON.parse(row.error.slice(row.error.indexOf("{")));
  if (changed === "foreign-agent") failure.message = failure.message.replace("octogee-livefixture-coach", "octogee-foreign-coach");
  if (changed === "wrong-class") failure.message = failure.message.replace("AgentDatabaseMaintenanceRequiredError", "OtherError");
  if (changed === "wrong-message") failure.message = failure.message.replace("Agent database migration requires", "Agent database migration needs");
  if (changed === "trailing-text") failure.message += " ignored";
  row.error = "/finish-rsync-import/shared-new: 500 " + JSON.stringify(failure);
  row.steps = row.steps.map(step => step.name === "final-sync-state" ? { ...step, error: row.error } : step);
  row.attemptHistory[0] = { ...row.attemptHistory[0], error: row.error, steps: structuredClone(row.steps) };
  expect(postgresImportMaintenanceFailureMatches(row, "placement", identity, "shared-old")).toBe(false);
});
it.each(["cutover", "verify", "uid", "source", "target", "foreign-agent", "different-error", "rollback", "abort", "unmount", "resume", "ingress", "claim", "attempt", "duplicate", "restore", "transfer", "v2", "cancelled", "history", "null-body"])("refuses PostgreSQL admission with %s", change => {
  const row: any = fixture();
  if (change === "cutover") row.cutoverCommittedAt = 180;
  if (change === "verify") row.steps.push({ name: "verify-target", status: "failed" });
  if (change === "uid") row.input.uid = "foreign";
  if (change === "source") row.input.fromGatewayId = "other";
  if (change === "target") row.input.toGatewayId = "other";
  if (change === "foreign-agent") row.error = row.error.replace("octogee-livefixture-coach", "octogee-foreign-coach");
  if (change === "different-error") row.error = row.error.replace("AgentDatabaseMaintenanceRequiredError", "OtherError");
  if (change === "rollback") row.rolledBack = false;
  if (["abort", "unmount", "resume", "ingress"].includes(change)) row.steps = row.steps.filter((step: any) => step.name !== `rollback:${({ abort: "scheduler-abort", unmount: "unmount-target", resume: "scheduler-resume", ingress: "resume-ingress" } as any)[change]}`);
  if (change === "claim") row.schedulerHandoff.migrationId = "mig-placement:scheduler:1:claim:101";
  if (change === "attempt") row.attempts = 2;
  if (change === "duplicate") row.steps.push({ name: "quiesce-source", status: "done" });
  if (change === "restore") row.restoreAttempt = {};
  if (change === "transfer") row.sourceTransferExecution = {};
  if (change === "v2") row.customerMigrationV2 = {};
  if (change === "cancelled") row.cancellationRequestedAt = 200;
  if (change === "history") row.attemptHistory = [{}];
  if (change === "null-body") row.error = "/finish-rsync-import/shared-new: 500 null";
  expect(postgresImportMaintenanceFailureMatches(row, "placement", identity, "shared-old")).toBe(false);
});
function rosterFixture() {
  const anchors = [identity.agentId, "octogee-livefixture-proj-launch-coach"].map((agentId, index) => ({ agentId, gatewayId: "shared-old", assignmentEpoch: 7,
    storeId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, schema: `agent_${index}` }));
  const projects: Array<{ id: string; data: any }> = [{ id: "launch", data: { agent: { enabled: true } } }];
  const reference = (path: string): any => ({ path, collection: (name: string) => reference(`${path}/${name}`), doc: (id: string) => reference(`${path}/${id}`) });
  const db = { collection: (name: string) => reference(name) } as unknown as Firestore;
  const tx = { get: async ({ path }: { path: string }) => ({ docs: path.endsWith("agentStores") ? anchors.map(row => ({ id: row.agentId, data: () => row })) : projects.map(row => ({ id: row.id, data: () => row.data })) }) } as unknown as Transaction;
  return { anchors, projects, db, tx };
}
it("captures every recorded owned PostgreSQL anchor including project history", async () => {
  const f = rosterFixture();
  expect(await readPostgresSourceAgentStores(f.db, f.tx, [identity])).toEqual(f.anchors.map(({ gatewayId: _gateway, ...anchor }) => ({ uid: "owner", slug: "livefixture", ...anchor })));
});
it.each(["missing-project", "foreign-owner", "epoch", "agent", "store", "schema", "duplicate-uuid"])("refuses a PostgreSQL source roster with %s", async change => {
  const f = rosterFixture();
  if (change === "missing-project") f.anchors.pop();
  if (change === "foreign-owner") f.anchors[0]!.gatewayId = "builder-new-owner";
  if (change === "epoch") f.anchors[0]!.assignmentEpoch++;
  if (change === "agent") f.anchors[0]!.agentId = "octogee-foreign-coach";
  if (change === "store") f.anchors[0]!.storeId = "invalid";
  if (change === "schema") f.anchors[0]!.schema = "unsafe;schema";
  if (change === "duplicate-uuid") f.anchors[1]!.storeId = f.anchors[0]!.storeId;
  await expect(readPostgresSourceAgentStores(f.db, f.tx, [identity])).rejects.toThrow();
});


function authorityFixture(migration: "identity" | "database" = "identity") {
  const anchor = { agentId: identity.agentId, gatewayId: "shared-old", assignmentEpoch: 7, storeId: "00000000-0000-4000-8000-000000000001", schema: "agent_owned" };
  const rows: Record<string, any> = {
    "gateways/shared-old": { gatewayId: "shared-old", gatewayClass: "shared", ownerUid: null, builderSlug: null, desiredStatus: "draining", liveRelease: 1, desiredRelease: 1, latestRelease: 1 },
    "gateways/shared-old/assignments/owner": identity.assignment,
    "users/owner": { username: "livefixture", provisioning: { openclaw: { gatewayId: "shared-old", status: "complete" } } },
    ["users/owner/agentStores/" + identity.agentId]: anchor,
    "glmOperations/placement": fixture(migration),
  };
  const reference = (path: string, filters: any[] = []): any => ({ path, filters, doc: (id: string) => reference(`${path}/${id}`),
    collection: (name: string) => reference(`${path}/${name}`), where: (...filter: any[]) => reference(path, [...filters, filter]) });
  const snap = (key: string) => ({ id: key.split("/").at(-1)!, exists: rows[key] !== undefined, data: () => rows[key] });
  const db = { doc: (path: string) => reference(path), collection: (path: string) => reference(path) } as unknown as Firestore;
  const tx = { get: async (ref: any) => ref.path.split("/").length % 2 === 0 ? snap(ref.path) : { docs: Object.keys(rows)
    .filter(key => key.startsWith(ref.path + "/") && !key.slice(ref.path.length + 1).includes("/"))
    .filter(key => ref.filters.every(([field, operator, value]: any[]) => operator === "in" ? value.includes(rows[key][field]) : rows[key][field] === value)).map(snap) } } as unknown as Transaction;
  return { rows, db, tx };
}

it.each(["identity", "database"] as const)("captures the fully qualified PostgreSQL source authority without changing the %s failed operation", async migration => {
  const f = authorityFixture(migration), before = structuredClone(f.rows);
  const captured = await readSharedSourceRecoveryAuthority(f.db, f.tx, "shared-old");
  expect(captured.postgresAgentStores).toEqual([{ uid: "owner", slug: "livefixture", assignmentEpoch: 7, agentId: identity.agentId,
    storeId: "00000000-0000-4000-8000-000000000001", schema: "agent_owned" }]);
  expect(f.rows).toEqual(before);
});
it("captures tenant stores from a mixed registry while retaining the old Builder's allocation anchors", async () => {
  const f = authorityFixture("database");
  const projectId = "octogee-livefixture-proj-launch-coach";
  f.rows["workspaces/livefixture/projects/launch"] = { agent: { enabled: true } };
  f.rows["users/owner/agentStores/" + projectId] = { agentId: projectId, gatewayId: "shared-old", assignmentEpoch: 7,
    storeId: "00000000-0000-4000-8000-000000000002", schema: "agent_project" };
  f.rows["users/owner/agentStores/octogee-unmatched-route"] = { agentId: "octogee-unmatched-route", gatewayId: "retained-builder", generation: 114,
    storeId: "00000000-0000-4000-8000-000000000003", schema: "agent_builder_default", recordedAt: 1 };
  f.rows["users/owner/agentStores/_gateway-state"] = { kind: "gateway-state", gatewayId: "retained-builder", generation: 114,
    storeId: "00000000-0000-4000-8000-000000000004", schema: "state_builder", recordedAt: 1 };
  const before = structuredClone(f.rows);
  const captured = await readSharedSourceRecoveryAuthority(f.db, f.tx, "shared-old");
  expect(captured.postgresAgentStores).toEqual([
    { uid: "owner", slug: "livefixture", assignmentEpoch: 7, agentId: identity.agentId, storeId: "00000000-0000-4000-8000-000000000001", schema: "agent_owned" },
    { uid: "owner", slug: "livefixture", assignmentEpoch: 7, agentId: projectId, storeId: "00000000-0000-4000-8000-000000000002", schema: "agent_project" },
  ]);
  expect(f.rows).toEqual(before);
});
it.each(["missing-agent-id", "foreign-agent-id", "tenant-agent-id", "similar-service-id"])("refuses an unrecognized allocation record with %s without changing it", async changed => {
  const f = authorityFixture("database"), id = changed === "similar-service-id" ? "octogee-unmatched-route-extra" : "octogee-unmatched-route";
  f.rows["users/owner/agentStores/" + id] = { agentId: changed === "missing-agent-id" ? undefined : changed === "foreign-agent-id" ? "octogee-foreign-coach" : changed === "tenant-agent-id" ? identity.agentId : id,
    gatewayId: "retained-builder", generation: 114, storeId: "00000000-0000-4000-8000-000000000003", schema: "agent_builder_default" };
  const before = structuredClone(f.rows);
  await expect(readSharedSourceRecoveryAuthority(f.db, f.tx, "shared-old")).rejects.toThrow("source recovery PostgreSQL anchor custody changed");
  expect(f.rows).toEqual(before);
});
it.each(["foreign-customer", "gateway", "epoch", "agent-id", "store-id", "schema"])("retains current tenant custody validation with allocation records present: %s", async changed => {
  const f = authorityFixture("database");
  f.rows["users/owner/agentStores/octogee-unmatched-route"] = { agentId: "octogee-unmatched-route", gatewayId: "retained-builder", generation: 114 };
  const anchor = f.rows["users/owner/agentStores/" + identity.agentId];
  if (changed === "foreign-customer") f.rows["users/owner/agentStores/octogee-foreign-coach"] = { ...anchor, agentId: "octogee-foreign-coach" };
  if (changed === "gateway") anchor.gatewayId = "foreign-builder";
  if (changed === "epoch") anchor.assignmentEpoch++;
  if (changed === "agent-id") anchor.agentId = "octogee-foreign-coach";
  if (changed === "store-id") anchor.storeId = "malformed";
  if (changed === "schema") anchor.schema = "unsafe;schema";
  const before = structuredClone(f.rows);
  await expect(readSharedSourceRecoveryAuthority(f.db, f.tx, "shared-old")).rejects.toThrow("source recovery PostgreSQL anchor custody changed");
  expect(f.rows).toEqual(before);
});
it.each(["pending", "running"])("refuses PostgreSQL recovery while a %s source transfer task retains custody", async status => {
  const f = authorityFixture();
  f.rows["glmMigrationTransferTasks/task"] = { status, sourceGatewayId: "shared-old", targetGatewayId: "other" };
  await expect(readSharedSourceRecoveryAuthority(f.db, f.tx, "shared-old")).rejects.toThrow("transfer task is active");
});
it("allows unrelated active housekeeping and transfer tasks", async () => {
  const f = authorityFixture();
  f.rows["glmMigrationTransferTasks/task"] = { status: "running", sourceGatewayId: "unrelated", targetGatewayId: "another" };
  f.rows["glmOperations/housekeeping"] = { kind: "housekeeping", status: "running", input: {} };
  await expect(readSharedSourceRecoveryAuthority(f.db, f.tx, "shared-old")).resolves.toHaveProperty("postgresAgentStores");
});


function addPostgresSourceRoster(f: ReturnType<typeof authorityFixture>): void {
  for (const [index, slug] of ["secondfixture", "thirdfixture", "fourthfixture"].entries()) {
    const uid = `owner-${index}`, operationId = `placement-${index}`, agentId = `octogee-${slug}-coach`;
    f.rows[`gateways/shared-old/assignments/${uid}`] = { uid, slug, gatewayId: "shared-old", state: "serving", epoch: index + 8 };
    f.rows[`users/${uid}`] = { username: slug, provisioning: { openclaw: { gatewayId: "shared-old", status: "complete" } } };
    f.rows[`users/${uid}/agentStores/${agentId}`] = { agentId, gatewayId: "shared-old", assignmentEpoch: index + 8,
      storeId: `00000000-0000-4000-8000-${String(index + 2).padStart(12, "0")}`, schema: `agent_owner_${index}` };
    const row = fixture("database");
    row.error = row.error.replaceAll("livefixture", slug);
    Object.assign(row.input, { uid, builderSlug: slug });
    Object.assign(row.schedulerHandoff, { uid, slug, migrationId: `mig-${operationId}:scheduler:1:claim:${row.startedAt}` });
    row.steps = row.steps.map(step => "error" in step ? { ...step, error: row.error } : step);
    row.attemptHistory = [{ attempt: 1, startedAt: row.startedAt, completedAt: row.completedAt, error: row.error, steps: structuredClone(row.steps) }];
    f.rows[`glmOperations/${operationId}`] = row;
  }
  for (const [index, project] of ["launch", "second", "third"].entries()) {
    const uid = index === 2 ? "owner-0" : identity.uid, slug = index === 2 ? "secondfixture" : identity.slug;
    const agentId = `octogee-${slug}-proj-${project}-coach`;
    f.rows[`workspaces/${slug}/projects/${project}`] = { agent: { enabled: true } };
    f.rows[`users/${uid}/agentStores/${agentId}`] = { agentId, gatewayId: "shared-old", assignmentEpoch: index === 2 ? 8 : 7,
      storeId: `00000000-0000-4000-8000-${String(index + 5).padStart(12, "0")}`, schema: `agent_project_${index}` };
  }
  f.rows["users/owner/agentStores/octogee-unmatched-route"] = { agentId: "octogee-unmatched-route", gatewayId: "retained-builder", generation: 9 };
}
async function spentPostgresPredecessorFixture(fullRoster = false) {
  const f = authorityFixture();
  if (fullRoster) addPostgresSourceRoster(f);
  const source = await readSharedSourceRecoveryAuthority(f.db, f.tx, "shared-old");
  const images = { gateway: "registry/gateway:aaaaaaaa@sha256:" + "a".repeat(64), "gateway-edge": "registry/edge:aaaaaaaa@sha256:" + "b".repeat(64) };
  const sourceSha = "c".repeat(40), operationId = "spent-pg-repair";
  const row = { kind: "restart-gateway", status: "failed", startedAt: 300, completedAt: 600,
    error: "source repair is not ready; outcome remains fenced", input: { gatewayId: "shared-old", sourceRecovery: { ...structuredClone(source), sourceSha, images } } };
  const fence = { kind: "source-recovery", phase: "dispatched", attemptId: operationId, auditId: operationId, gatewayId: "shared-old", startedAt: 400,
    doctor: { requestId: operationId, startedAt: 500, releaseKey: "pinned-native-image" },
    target: { podUid: "source-pod", podName: "source-pod-name", sourceSha, images,
      agents: source.assignments.map(({ uid, slug, agentId, assignmentEpoch }) => ({ uid, slug, agentId, assignmentEpoch })),
      failedExportOperationIds: source.failedExports.map(exported => exported.operationId) },
    installedImage: { podUid: "source-pod", gatewayImageId: "docker-pullable://" + images.gateway, verifiedAt: 450 } };
  return { gatewayId: "shared-old", operationId, row, fence, source };
}
it("admits an exact spent PostgreSQL Doctor predecessor while retaining its captured anchor roster", async () => {
  const f = await spentPostgresPredecessorFixture(), before = structuredClone(f);
  expect(assertSharedSourceRecoveryPredecessor(f)).toEqual({ operationId: f.operationId, input: f.row.input,
    inputFingerprint: operationAuditMutationFingerprint(f.row.input),
    startedAt: f.row.startedAt, completedAt: f.row.completedAt, error: f.row.error, fence: f.fence });
  expect(f).toEqual(before);
});
it.each(["anchor", "schema", "epoch", "missing-roster"])("refuses a spent PostgreSQL predecessor with changed %s", async change => {
  const f = await spentPostgresPredecessorFixture();
  if (change === "anchor") f.source.postgresAgentStores![0]!.storeId = "00000000-0000-4000-8000-999999999999";
  if (change === "schema") f.source.postgresAgentStores![0]!.schema = "different_store";
  if (change === "epoch") { f.source.assignments[0]!.assignmentEpoch++; f.source.postgresAgentStores![0]!.assignmentEpoch++; }
  if (change === "missing-roster") delete f.source.postgresAgentStores;
  expect(() => assertSharedSourceRecoveryPredecessor(f)).toThrow();
});

async function completedPostgresPredecessorFixture() {
  const f = await spentPostgresPredecessorFixture(true);
  return { ...f, fence: { ...f.fence, doctor: { ...f.fence.doctor, completedAt: 550,
    verifiedAgentIds: f.source.postgresAgentStores!.map(store => store.agentId) } } };
}
it("admits an exact successful seven-tenant Doctor ACK after failed readiness without rewriting that ACK", async () => {
  const f = await completedPostgresPredecessorFixture(), before = structuredClone(f);
  expect(f.source.assignments).toHaveLength(4);
  expect(f.source.postgresAgentStores).toHaveLength(7);
  expect(f.fence.doctor.verifiedAgentIds).not.toContain("octogee-unmatched-route");
  expect(f.fence.doctor.releaseKey).not.toBe(f.row.input.sourceRecovery.sourceSha);
  expect(assertSharedSourceRecoveryPredecessor(f)).toEqual({ operationId: f.operationId, input: f.row.input,
    inputFingerprint: operationAuditMutationFingerprint(f.row.input),
    startedAt: f.row.startedAt, completedAt: f.row.completedAt, error: f.row.error, fence: f.fence });
  expect(f).toEqual(before);
});
it("keeps repeated seven-agent source recovery audit admission within Firestore document depth", async () => {
  const f = await completedPostgresPredecessorFixture();
  const client = new FirestoreClient({ projectId: "synthetic-source-recovery-depth" });
  let operationId = f.operationId, row: DocumentData = structuredClone(f.row), fence: DocumentData = structuredClone(f.fence);
  const sizes: number[] = [], depths: number[] = [];
  const depth = (value: unknown): number => value && typeof value === "object"
    ? 1 + Math.max(0, ...Object.values(value).map(depth)) : 0;
  try {
    for (let generation = 0; generation < 32; generation++) {
      const before = structuredClone({ row, fence });
      const supersede = assertSharedSourceRecoveryPredecessor({ ...f, operationId, row, fence });
      const source = row.input.sourceRecovery;
      const input = { gatewayId: f.gatewayId, sourceRecovery: { ...f.source, sourceSha: source.sourceSha,
        images: source.images, supersede } };
      const audit = buildOperationAuditIntent({ actor: "synthetic-operator", forced: false,
        what: "repair Shared source before export", why: "synthetic repeated failed readiness",
        target: { gatewayId: f.gatewayId }, preActionStatus: f.source.root, mutation: input,
        idempotencyKey: `synthetic-source-recovery-${String(generation).padStart(2, "0")}`, now: () => 1_000 + generation * 100 });
      expect(() => client.batch().create(client.doc(`operationAudits/${audit.id}`), audit.document),
        `source recovery generation ${generation}`).not.toThrow();
      const operation = { kind: "restart-gateway", status: "pending", createdBy: "synthetic-operator",
        createdAt: 1_000 + generation * 100, startedAt: null, completedAt: null, input, steps: [], gatewayId: f.gatewayId };
      expect(() => client.batch().create(client.doc(`glmOperations/recovery-${generation}`), operation)).not.toThrow();
      if (generation > 1) {
        sizes.push(JSON.stringify(audit.document).length, JSON.stringify(operation).length);
        depths.push(depth(audit.document), depth(operation));
      }
      expect({ row, fence }).toEqual(before);
      operationId = `synthetic-recovery-${String(generation).padStart(2, "0")}`;
      const startedAt = 1_000 + generation * 100;
      row = { ...row, startedAt, completedAt: startedAt + 90, input };
      fence = { ...fence, attemptId: operationId, auditId: operationId, startedAt: startedAt + 1,
        doctor: { ...fence.doctor, requestId: operationId, startedAt: startedAt + 3, completedAt: startedAt + 5 },
        installedImage: { ...fence.installedImage, verifiedAt: startedAt + 2 } };
    }
    expect(new Set(sizes.filter((_size, index) => index % 2 === 0)).size).toBe(1);
    expect(new Set(sizes.filter((_size, index) => index % 2 === 1)).size).toBe(1);
    expect(new Set(depths.filter((_depth, index) => index % 2 === 0)).size).toBe(1);
    expect(new Set(depths.filter((_depth, index) => index % 2 === 1)).size).toBe(1);
  } finally {
    await client.terminate();
  }
});
it("captures existing nested predecessor input without copying or losing its integrity", async () => {
  const f = await completedPostgresPredecessorFixture();
  const row: DocumentData = structuredClone(f.row);
  row.input.sourceRecovery.supersede = { operationId: "legacy-parent", input: { sourceRecovery: {
    supersede: { operationId: "legacy-ancestor", input: { immutableHistory: "original" } },
  } } };
  const before = structuredClone(row), captured = assertSharedSourceRecoveryPredecessor({ ...f, row });
  expect(captured.input.sourceRecovery.supersede).toBeUndefined();
  expect(captured.inputFingerprint).toBe(operationAuditMutationFingerprint(before.input));
  expect(row).toEqual(before);
  row.input.sourceRecovery.supersede.input.sourceRecovery.supersede.input.immutableHistory = "changed";
  const changed = assertSharedSourceRecoveryPredecessor({ ...f, row });
  expect(changed.input).toEqual(captured.input);
  expect(changed.inputFingerprint).not.toBe(captured.inputFingerprint);
});
const invalidCompletedDoctors: Array<[string, (doctor: DocumentData) => void]> = [
  ["failed", doctor => { doctor.error = "Doctor refused"; }],
  ["before-start", doctor => { doctor.completedAt = doctor.startedAt - 1; }],
  ["after-failure", doctor => { doctor.completedAt = 601; }],
  ["fractional-completion", doctor => { doctor.completedAt = 550.5; }],
  ["missing-completion", doctor => { delete doctor.completedAt; }],
  ["missing-roster", doctor => { delete doctor.verifiedAgentIds; }],
  ["foreign-request", doctor => { doctor.requestId = "another-recovery"; }],
  ["missing-release", doctor => { delete doctor.releaseKey; }],
  ["empty-release", doctor => { doctor.releaseKey = ""; }],
  ["whitespace-release", doctor => { doctor.releaseKey = " "; }],
  ["overlong-release", doctor => { doctor.releaseKey = "r".repeat(513); }],
  ["unknown-field", doctor => { doctor.ready = true; }],
  ["partial-roster", doctor => { doctor.verifiedAgentIds.pop(); }],
  ["empty-roster", doctor => { doctor.verifiedAgentIds = []; }],
  ["foreign-agent", doctor => { doctor.verifiedAgentIds[0] = "octogee-foreign-coach"; }],
  ["extra-agent", doctor => { doctor.verifiedAgentIds.push("octogee-other-coach"); }],
  ["fallback-agent", doctor => { doctor.verifiedAgentIds.push("octogee-unmatched-route"); }],
  ["duplicate-agent", doctor => { doctor.verifiedAgentIds[1] = doctor.verifiedAgentIds[0]; }],
  ["reordered-roster", doctor => { doctor.verifiedAgentIds.reverse(); }],
];
it.each(invalidCompletedDoctors)("refuses a completed PostgreSQL predecessor with %s Doctor proof", async (_name, change) => {
  const f = await completedPostgresPredecessorFixture();change(f.fence.doctor);
  const before = structuredClone(f);
  expect(() => assertSharedSourceRecoveryPredecessor(f)).toThrow("source recovery predecessor is unavailable");
  expect(f).toEqual(before);
});
it("refuses a coach-only ACK when the captured tenant roster also owns project stores", async () => {
  const f = await completedPostgresPredecessorFixture();
  f.fence.doctor.verifiedAgentIds = f.source.assignments.map(assignment => assignment.agentId);
  expect(f.fence.doctor.verifiedAgentIds).toHaveLength(4);
  expect(() => assertSharedSourceRecoveryPredecessor(f)).toThrow("source recovery predecessor is unavailable");
});
it.each(["anchor", "schema", "epoch", "input", "image", "pod", "clock", "cancelled", "running", "completed-recovery"])("retains completed Doctor predecessor %s custody guards", async change => {
  const f = await completedPostgresPredecessorFixture();
  if (change === "anchor") f.source.postgresAgentStores![0]!.storeId = "00000000-0000-4000-8000-999999999999";
  if (change === "schema") f.source.postgresAgentStores![0]!.schema = "different_schema";
  if (change === "epoch") f.source.assignments[0]!.assignmentEpoch++;
  if (change === "input") f.fence.target.sourceSha = "d".repeat(40);
  if (change === "image") f.fence.installedImage.gatewayImageId = "foreign";
  if (change === "pod") f.fence.installedImage.podUid = "another-pod";
  if (change === "clock") f.fence.installedImage.verifiedAt = 501;
  if (change === "cancelled") Object.assign(f.row, { cancellationRequestedAt: 599 });
  if (change === "running") f.row.status = "running";
  if (change === "completed-recovery") Object.assign(f.row, { sourceRuntimeRecovery: {} });
  expect(() => assertSharedSourceRecoveryPredecessor(f)).toThrow();
});
