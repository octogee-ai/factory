import { FieldValue, type Firestore } from "firebase-admin/firestore";
import {
  GLM_OPERATIONS_COLLECTION,
  isOperationAuditRow,
  type Operation,
} from "@octogee/shared/types/glm";
import { GATEWAYS_COLLECTION } from "@octogee/shared/types/fleet-controller";
import { customerRuntimeMutationFenced, GATEWAY_ASSIGNMENTS_SUBCOLLECTION } from "@octogee/shared/types/gateway-releases";
import { operationNeedsDurableRestartResume } from "./operation-retry.js";
import { MIGRATE_CUSTOMER_KIND, RETIRE_GATEWAY_KIND } from "./operation-kinds.js";

export const REAPED_OPERATION_ERROR_PREFIX = "reaped: ";

export function isReapedOperationError(error: unknown): boolean {
  return typeof error === "string" && error.startsWith(REAPED_OPERATION_ERROR_PREFIX);
}

export interface StuckOpReaperDeps {
  db: Firestore;
  log: (msg: string) => void;
  now: () => number;
  
  stalenessMs: number;
}

export interface StuckOpReaperResult {
  scanned: number;
  reaped: number;
}

function readMillis(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (v instanceof Date) return v.getTime();
  if (v != null && typeof (v as { toMillis?: () => number }).toMillis === "function") {
    return (v as { toMillis: () => number }).toMillis();
  }
  return null;
}

function legacyMigrationGate(
  operationId: string,
  operation: Operation,
): { operationId: string; uid: string; fromGatewayId: string } | null {
  if (operation.kind !== "migrate-customer" || operation.customerMigrationV2) return null;
  const details = operation.input;
  if (!details || typeof details !== "object") return null;
  const uid = details.uid;
  const fromGatewayId = details.fromGatewayId;
  if (typeof uid !== "string" || uid.length === 0) return null;
  if (typeof fromGatewayId !== "string" || fromGatewayId.length === 0) return null;
  return { operationId, uid, fromGatewayId };
}

function userGatewayId(data: FirebaseFirestore.DocumentData | undefined): string | null {
  const provisioning = data?.provisioning;
  if (!provisioning || typeof provisioning !== "object") return null;
  const openclaw = (provisioning as Record<string, unknown>).openclaw;
  if (!openclaw || typeof openclaw !== "object") return null;
  const gatewayId = (openclaw as Record<string, unknown>).gatewayId;
  return typeof gatewayId === "string" ? gatewayId : null;
}

function operationIsStillStale(
  operation: Operation,
  now: number,
  stalenessMs: number,
): boolean {
  if (operation.status !== "running" || operationNeedsDurableRestartResume(operation)) return false;
  const anchorMs = Math.max(
    readMillis(operation.lastProgressAt) ?? 0,
    readMillis(operation.startedAt) ?? 0,
    readMillis(operation.createdAt) ?? 0,
  );
  return anchorMs > 0 && now - anchorMs >= stalenessMs;
}

function assignmentIsOwnedByMigration(input: {
  assignment: FirebaseFirestore.DocumentData | undefined;
  user: FirebaseFirestore.DocumentData | undefined;
  gate: { operationId: string; uid: string; fromGatewayId: string };
  currentGate: { operationId: string; uid: string; fromGatewayId: string } | null;
}): boolean {
  return input.currentGate?.uid === input.gate.uid &&
    input.currentGate.fromGatewayId === input.gate.fromGatewayId &&
    input.assignment?.state === "quiescing" &&
    input.assignment.updatedByOperationId === input.gate.operationId &&
    userGatewayId(input.user) === input.gate.fromGatewayId;
}

interface ReapResult {
  reaped: boolean;
  gateMessage?: string;
}

function legacyReapAdmission(input: {
  operationSnapshot: FirebaseFirestore.DocumentSnapshot;
  userSnapshot: FirebaseFirestore.DocumentSnapshot | null;
  operationId: string;
  stillReapable: (operation: Operation) => boolean;
  logLabel: string;
}): { operation: Operation } | ReapResult {
  if (!input.operationSnapshot.exists) return { reaped: false };
  const operation = { ...input.operationSnapshot.data(), id: input.operationId } as Operation;
  if (!input.stillReapable(operation)) return { reaped: false };
  if (customerRuntimeMutationFenced(input.userSnapshot?.data())) {
    return { reaped: false, gateMessage: `[${input.logLabel}] source assignment recovery blocked by unresolved customer restore or source transfer` };
  }
  return { operation };
}

async function reapWithLegacyGateRecovery(input: {
  db: Firestore;
  doc: FirebaseFirestore.QueryDocumentSnapshot;
  operation: Operation;
  now: number;
  error: string;
  logLabel: string;
  stillReapable: (current: Operation) => boolean;
}): Promise<ReapResult> {
  const gate = legacyMigrationGate(input.doc.id, input.operation);
  const assignmentRef = gate && input.db
    .collection(GATEWAYS_COLLECTION)
    .doc(gate.fromGatewayId)
    .collection(GATEWAY_ASSIGNMENTS_SUBCOLLECTION)
    .doc(gate.uid);
  const userRef = gate && input.db.collection("users").doc(gate.uid);
  return input.db.runTransaction(async (txn) => {
    const [operationSnap, assignmentSnap, userSnap] = await Promise.all([
      txn.get(input.doc.ref),
      assignmentRef ? txn.get(assignmentRef) : null,
      userRef ? txn.get(userRef) : null,
    ]);
    const admission = legacyReapAdmission({
      operationSnapshot: operationSnap,
      userSnapshot: userSnap,
      operationId: input.doc.id,
      stillReapable: input.stillReapable,
      logLabel: input.logLabel,
    });
    if ("reaped" in admission) return admission;
    const current = admission.operation;
    txn.update(input.doc.ref, {
      status: "failed",
      completedAt: input.now,
      error: input.error,
    });
    if (!gate || !assignmentRef || !assignmentSnap || !userSnap) return { reaped: true };
    const assignment = assignmentSnap.exists ? assignmentSnap.data() : undefined;
    const exactOwnedGate = assignmentIsOwnedByMigration({
      assignment,
      user: userSnap.exists ? userSnap.data() : undefined,
      gate,
      currentGate: legacyMigrationGate(input.doc.id, current),
    });
    if (exactOwnedGate) {
      txn.update(assignmentRef, {
        state: "serving",
        updatedAt: input.now,
        updatedByOperationId: gate.operationId,
      });
      return {
        reaped: true,
        gateMessage:
          `[${input.logLabel}] restored source assignment gateway=${gate.fromGatewayId} ` +
          `uid=${gate.uid} owner=${gate.operationId}`,
      };
    }
    if (assignment?.state === "quiescing") {
      return {
        reaped: true,
        gateMessage:
          `[${input.logLabel}] source assignment recovery skipped gateway=${gate.fromGatewayId} ` +
          `uid=${gate.uid} owner=${String(assignment.updatedByOperationId ?? "none")}`,
      };
    }
    return { reaped: true };
  });
}

export async function runStuckOpReaperTick(
  deps: StuckOpReaperDeps,
): Promise<StuckOpReaperResult> {
  const snap = await deps.db
    .collection(GLM_OPERATIONS_COLLECTION)
    .where("status", "==", "running")
    .get();
  const now = deps.now();

  type StuckRow = { doc: (typeof snap.docs)[number]; data: Operation; ageMin: number };
  const stuck: StuckRow[] = [];
  for (const doc of snap.docs) {
    const data = doc.data() as unknown;
    if (!data || isOperationAuditRow(data)) continue;
    const operation = { ...data as Operation, id: doc.id };
    if (operationNeedsDurableRestartResume(operation)) continue;

    // Liveness = the most recent of (last step progress, claim, creation). A long or
    // resumed roll that is still stepping keeps lastProgressAt fresh and is NOT reaped;
    // only an op with no progress and no recent (re)claim past the budget is stuck.
    const anchorMs = Math.max(
      readMillis(operation.lastProgressAt) ?? 0,
      readMillis(operation.startedAt) ?? 0,
      readMillis(operation.createdAt) ?? 0,
    );
    if (anchorMs <= 0) continue;
    if (now - anchorMs < deps.stalenessMs) continue;
    stuck.push({ doc, data: operation, ageMin: Math.round((now - anchorMs) / 60_000) });
  }

  const budgetMin = Math.round(deps.stalenessMs / 60_000);
  const results = await Promise.allSettled(
    stuck.map(async ({ doc, data, ageMin }) => {
      try {
        const error = `${REAPED_OPERATION_ERROR_PREFIX}op exceeded ${budgetMin}m running budget — controller likely restarted mid-op or the work hung past the inner deadlines`;
        const legacyResult = legacyMigrationGate(doc.id, data) === null
          ? null
          : await reapWithLegacyGateRecovery({
              db: deps.db,
              doc,
              operation: data,
              now,
              error,
              logLabel: "stuck-op-reaper",
              stillReapable: (current) => operationIsStillStale(current, now, deps.stalenessMs),
            });
        if (legacyResult !== null) {
          if (legacyResult.gateMessage) deps.log(legacyResult.gateMessage);
          if (!legacyResult.reaped) return false;
        } else {
          await doc.ref.update({
            status: "failed",
            completedAt: now,
            error,
          });
        }
        deps.log(
          `[stuck-op-reaper] ⚠ reaped ${doc.id} (kind=${data.kind ?? "?"}) after ${ageMin}m`,
        );
        return true;
      } catch (err) {
        deps.log(`[stuck-op-reaper] ⚠ ${doc.id} update failed: ${String(err)}`);
        throw err;
      }
    }),
  );
  const reaped = results.filter((r) => r.status === "fulfilled" && r.value).length;
  return { scanned: snap.docs.length, reaped };
}

export interface ControllerOrphanRecoveryDeps {
  db: Firestore;
  log: (msg: string) => void;
  now: () => number;
  controllerStartedAt: number;
}

export interface ControllerOrphanRecoveryResult {
  scanned: number;
  recovered: number;
}

export const CONTROLLER_ORPHANED_OPERATION_ERROR =
  `${REAPED_OPERATION_ERROR_PREFIX}controller restarted mid-op — the claiming controller exited, so no worker can finish it; failed at boot`;

const BOOT_RECOVERABLE_KINDS: ReadonlySet<string> = new Set([MIGRATE_CUSTOMER_KIND, RETIRE_GATEWAY_KIND]);

function claimedByPreviousController(operation: Operation, controllerStartedAt: number): boolean {
  const claimedAt = readMillis(operation.startedAt);
  return operation.status === "running" &&
    BOOT_RECOVERABLE_KINDS.has(operation.kind) &&
    !operationNeedsDurableRestartResume(operation) &&
    claimedAt !== null &&
    claimedAt < controllerStartedAt;
}

export function rearmedRetireOperationPatch(): Record<string, unknown> {
  return {
    status: "pending",
    startedAt: null,
    completedAt: null,
    steps: [],
    error: FieldValue.delete(),
    lastProgressAt: FieldValue.delete(),
    expireAt: FieldValue.delete(),
  };
}

async function rearmOrphanedRetirement(
  deps: ControllerOrphanRecoveryDeps,
  doc: FirebaseFirestore.QueryDocumentSnapshot,
): Promise<boolean> {
  const rearmed = await deps.db.runTransaction(async (txn) => {
    const snap = await txn.get(doc.ref);
    if (!snap.exists) return false;
    const current = { ...snap.data(), id: doc.id } as Operation;
    if (!claimedByPreviousController(current, deps.controllerStartedAt)) return false;
    txn.update(doc.ref, rearmedRetireOperationPatch());
    return true;
  });
  if (rearmed) {
    deps.log(
      `[boot-orphan-recovery] ⚠ re-armed orphaned ${doc.id} (kind=${RETIRE_GATEWAY_KIND}) claimed by the previous controller; its teardown re-runs from the top`,
    );
  }
  return rearmed;
}

async function failOrphanedMigration(
  deps: ControllerOrphanRecoveryDeps,
  doc: FirebaseFirestore.QueryDocumentSnapshot,
  operation: Operation,
  now: number,
): Promise<boolean> {
  const result = await reapWithLegacyGateRecovery({
    db: deps.db,
    doc,
    operation,
    now,
    error: CONTROLLER_ORPHANED_OPERATION_ERROR,
    logLabel: "boot-orphan-recovery",
    stillReapable: (current) => claimedByPreviousController(current, deps.controllerStartedAt),
  });
  if (result.gateMessage) deps.log(result.gateMessage);
  if (!result.reaped) return false;
  deps.log(
    `[boot-orphan-recovery] ⚠ failed orphaned ${doc.id} (kind=${operation.kind}) claimed by the previous controller`,
  );
  return true;
}

export async function recoverControllerOrphanedOperations(
  deps: ControllerOrphanRecoveryDeps,
): Promise<ControllerOrphanRecoveryResult> {
  const snap = await deps.db
    .collection(GLM_OPERATIONS_COLLECTION)
    .where("status", "==", "running")
    .get();
  const now = deps.now();
  let recovered = 0;
  for (const doc of snap.docs) {
    const data = doc.data() as unknown;
    if (!data || isOperationAuditRow(data)) continue;
    const operation = { ...data as Operation, id: doc.id };
    if (!claimedByPreviousController(operation, deps.controllerStartedAt)) continue;
    try {
      const didRecover = operation.kind === RETIRE_GATEWAY_KIND
        ? await rearmOrphanedRetirement(deps, doc)
        : await failOrphanedMigration(deps, doc, operation, now);
      if (didRecover) recovered += 1;
    } catch (err) {
      deps.log(`[boot-orphan-recovery] ⚠ ${doc.id} recovery failed: ${String(err)}`);
    }
  }
  return { scanned: snap.docs.length, recovered };
}

export interface StartStuckOpReaperDeps extends StuckOpReaperDeps {
  
  intervalMs: number;
  
  runTick?: (deps: StuckOpReaperDeps) => Promise<StuckOpReaperResult>;
}

export function startStuckOpReaper(deps: StartStuckOpReaperDeps): () => void {
  const tick = deps.runTick ?? runStuckOpReaperTick;
  let stopped = false;
  let running = false;
  const timer = setInterval(() => {
    if (stopped || running) return;
    running = true;
    (async () => {
      try {
        await tick(deps);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        deps.log(`[stuck-op-reaper] ⚠ tick failed — ${message}`);
      } finally {
        running = false;
      }
    })();
  }, deps.intervalMs);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
