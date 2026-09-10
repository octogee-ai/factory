import type { Firestore } from "firebase-admin/firestore";
import {
  GLM_OPERATIONS_COLLECTION,
  isOperationAuditRow,
  type Operation,
} from "@octogee/shared/types/glm";
import { GATEWAYS_COLLECTION } from "@octogee/shared/types/fleet-controller";
import { GATEWAY_ASSIGNMENTS_SUBCOLLECTION } from "@octogee/shared/types/gateway-releases";
import { operationNeedsDurableRestartResume } from "./operation-retry.js";

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

interface LegacyMigrationReapResult {
  reaped: boolean;
  gateMessage?: string;
}

async function reapLegacyMigrationWithGateRecovery(input: {
  deps: StuckOpReaperDeps;
  doc: FirebaseFirestore.QueryDocumentSnapshot;
  operation: Operation;
  now: number;
  error: string;
}): Promise<LegacyMigrationReapResult | null> {
  const gate = legacyMigrationGate(input.doc.id, input.operation);
  if (!gate) return null;
  const assignmentRef = input.deps.db
    .collection(GATEWAYS_COLLECTION)
    .doc(gate.fromGatewayId)
    .collection(GATEWAY_ASSIGNMENTS_SUBCOLLECTION)
    .doc(gate.uid);
  const userRef = input.deps.db.collection("users").doc(gate.uid);
  return input.deps.db.runTransaction(async (txn) => {
    const [operationSnap, assignmentSnap, userSnap] = await Promise.all([
      txn.get(input.doc.ref),
      txn.get(assignmentRef),
      txn.get(userRef),
    ]);
    if (!operationSnap.exists) return { reaped: false };
    const current = operationSnap.data() as Operation;
    if (!operationIsStillStale(current, input.now, input.deps.stalenessMs)) {
      return { reaped: false };
    }
    const currentGate = legacyMigrationGate(input.doc.id, current);
    const assignment = assignmentSnap.exists ? assignmentSnap.data() : undefined;
    const exactOwnedGate = assignmentIsOwnedByMigration({
      assignment,
      user: userSnap.exists ? userSnap.data() : undefined,
      gate,
      currentGate,
    });
    if (exactOwnedGate) {
      txn.update(assignmentRef, {
        state: "serving",
        updatedAt: input.now,
        updatedByOperationId: gate.operationId,
      });
    }
    txn.update(input.doc.ref, {
      status: "failed",
      completedAt: input.now,
      error: input.error,
    });
    if (exactOwnedGate) {
      return {
        reaped: true,
        gateMessage:
          `[stuck-op-reaper] restored source assignment gateway=${gate.fromGatewayId} ` +
          `uid=${gate.uid} owner=${gate.operationId}`,
      };
    }
    if (assignment?.state === "quiescing") {
      return {
        reaped: true,
        gateMessage:
          `[stuck-op-reaper] source assignment recovery skipped gateway=${gate.fromGatewayId} ` +
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
    const operation = data as Operation;
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
        const legacyResult = await reapLegacyMigrationWithGateRecovery({
          deps,
          doc,
          operation: data,
          now,
          error,
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
