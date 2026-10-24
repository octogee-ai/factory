import { expect, it } from "vitest";
import type { Firestore, Transaction } from "firebase-admin/firestore";
import { assertSharedSourceRecoveryPredecessor, postgresImportMaintenanceFailureMatches, readPostgresSourceAgentStores, readSharedSourceRecoveryAuthority, type SourceRecoveryAssignment } from "./shared-source-recovery.js";
const identity: SourceRecoveryAssignment = { uid: "owner", slug: "livefixture", agentId: "octogee-livefixture-coach", assignmentEpoch: 7,
  assignment: { uid: "owner", slug: "livefixture", gatewayId: "shared-old", state: "serving", epoch: 7 } };
function fixture() {
  const error = "/finish-rsync-import/shared-new: 500 " + JSON.stringify({ error: "import failed", message:
    "[import:livefixture] agents.create failed for octogee-livefixture-coach (AgentDatabaseMaintenanceRequiredError: Agent identity migration requires stopped-writer maintenance; stop active agents and run openclaw doctor --fix.)" });
  const row = { kind: "migrate-customer", status: "failed", origin: "automatic", createdBy: "glm-controller-placement-policy", attempts: 1,
    startedAt: 100, completedAt: 200, rolledBack: true, error,
    input: { uid: "owner", builderSlug: "livefixture", fromGatewayId: "shared-old", toGatewayId: "shared-new", source: "continuous-placement-policy" },
    schedulerHandoff: { migrationId: "mig-placement:scheduler:1:claim:100", uid: "owner", slug: "livefixture", fromGatewayId: "shared-old", toGatewayId: "shared-new" },
    steps: [...["keys-sync-state", "pre-sync-state", "target-scheduler-ready", "wait-for-active-work", "quiesce-source", "flush-source"].map(name => ({ name, status: "done" })),
      { name: "final-sync-state", status: "failed", error }, ...["scheduler-abort", "unmount-target", "scheduler-resume", "resume-ingress"].map(name => ({ name: `rollback:${name}`, status: "done" }))] };
  return { ...row, attemptHistory: [{ attempt: 1, startedAt: row.startedAt, completedAt: row.completedAt, error: row.error, steps: structuredClone(row.steps) }] };
}
it("accepts the exact fully rolled-back automatic placement maintenance failure", () => {
  expect(postgresImportMaintenanceFailureMatches(fixture(), "placement", identity, "shared-old")).toBe(true);
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


function authorityFixture() {
  const anchor = { agentId: identity.agentId, gatewayId: "shared-old", assignmentEpoch: 7, storeId: "00000000-0000-4000-8000-000000000001", schema: "agent_owned" };
  const rows: Record<string, any> = {
    "gateways/shared-old": { gatewayId: "shared-old", gatewayClass: "shared", ownerUid: null, builderSlug: null, desiredStatus: "draining", liveRelease: 1, desiredRelease: 1, latestRelease: 1 },
    "gateways/shared-old/assignments/owner": identity.assignment,
    "users/owner": { username: "livefixture", provisioning: { openclaw: { gatewayId: "shared-old", status: "complete" } } },
    ["users/owner/agentStores/" + identity.agentId]: anchor,
    "glmOperations/placement": fixture(),
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

it("captures the fully qualified PostgreSQL source authority without changing historical failed operations", async () => {
  const f = authorityFixture(), before = structuredClone(f.rows);
  const captured = await readSharedSourceRecoveryAuthority(f.db, f.tx, "shared-old");
  expect(captured.postgresAgentStores).toEqual([{ uid: "owner", slug: "livefixture", assignmentEpoch: 7, agentId: identity.agentId,
    storeId: "00000000-0000-4000-8000-000000000001", schema: "agent_owned" }]);
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


async function spentPostgresPredecessorFixture() {
  const f = authorityFixture(), source = await readSharedSourceRecoveryAuthority(f.db, f.tx, "shared-old");
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
