import { isDeepStrictEqual } from "node:util";
import { GATEWAYS_COLLECTION } from "@octogee/shared/types/fleet-controller";
import type { GatewayVmClient } from "./lib/compute-vm.js";
import { nativeReturnSourceIdentity, nativeReturnSourceStopped } from "./lib/native-return-source-fence.js";
import { FieldValue, Timestamp, type Firestore } from "firebase-admin/firestore";
import { GLM_GATEWAYS_COLLECTION, GLM_OPERATIONS_COLLECTION, type OperationStatus } from "@octogee/shared/types/glm";
import { mirroredOrScan, type FleetInformer } from "./fleet-informer.js";
import { OPERATION_JOURNAL_RETENTION_MS } from "./operation-retry.js";

export const NATIVE_RETURN_HOLD_REAPER_CREATOR = "glm-controller-native-return-hold-reaper";

export interface NativeReturnHoldReaperDeps {
  db: Pick<Firestore, "collection" | "runTransaction">;
  informer: Pick<FleetInformer, "glmGateways">;
  vm: Pick<GatewayVmClient, "describe">;
  log: (msg: string) => void;
  now: () => number;
}

export interface NativeReturnHoldReaperResult {
  scanned: number;
  released: number;
}

type ReturnOperationStatus = OperationStatus | "missing";

const TERMINAL: ReadonlySet<ReturnOperationStatus> = new Set(["succeeded", "failed", "rolled-back", "missing"]);

function heldReturnOperationId(data: FirebaseFirestore.DocumentData | undefined): string | null {
  const home = data?.vmHome;
  if (!home || typeof home !== "object") return null;
  const id = (home as Record<string, unknown>).returnOperationId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function returnOperationStatus(snap: FirebaseFirestore.DocumentSnapshot): ReturnOperationStatus {
  if (!snap.exists) return "missing";
  const status = snap.data()?.status;
  if (typeof status !== "string") {
    throw new Error(`return operation ${snap.id} has a malformed status (${String(status)}); hold retained`);
  }
  return status as OperationStatus;
}

function releaseJournalId(gatewayId: string, returnOperationId: string): string {
  return `native-return-hold-release-${gatewayId}-${returnOperationId}`;
}

function rollbackStillOwnsSource(runtime: FirebaseFirestore.DocumentData | undefined, desired: FirebaseFirestore.DocumentData,
  op: FirebaseFirestore.DocumentData | undefined, user: FirebaseFirestore.DocumentData | undefined, gatewayId: string): boolean {
  return [runtime?.runtime === "gce-vm", ["failed", "rolled-back"].includes(op?.status), op?.kind === "migrate-customer",
    op?.cutoverCommittedAt === undefined, op?.input?.uid === desired.ownerUid, op?.input?.fromGatewayId === gatewayId,
    user?.provisioning?.openclaw?.gatewayId === gatewayId, desired.desiredStatus === "running"].every(Boolean);
}

async function releaseTerminalHold(
  deps: NativeReturnHoldReaperDeps,
  gatewayId: string,
  returnOperationId: string,
): Promise<ReturnOperationStatus | null> {
  const gatewayRef = deps.db.collection(GLM_GATEWAYS_COLLECTION).doc(gatewayId);
  const operationRef = deps.db.collection(GLM_OPERATIONS_COLLECTION).doc(returnOperationId);
  const journalRef = deps.db.collection(GLM_OPERATIONS_COLLECTION).doc(releaseJournalId(gatewayId, returnOperationId));
  const rootRef = deps.db.collection(GATEWAYS_COLLECTION).doc(gatewayId);
  const [held, terminal, root] = await Promise.all([gatewayRef.get(), operationRef.get(), rootRef.get()]);
  if (heldReturnOperationId(held.data()) !== returnOperationId || !TERMINAL.has(returnOperationStatus(terminal))) return null;
  const runtime = held.data(), desired = root.data(), op = terminal.data();
  if (desired?.gatewayClass !== "builder" || typeof desired.ownerUid !== "string") throw new Error("source ownership unavailable; hold retained");
  const userRef = deps.db.collection("users").doc(desired.ownerUid);
  const owner = await userRef.get();
  const user = owner.data();
  const rollback = rollbackStillOwnsSource(runtime, desired, op, user, gatewayId);
  if (!rollback) {
    const identity = nativeReturnSourceIdentity(runtime, desired);
    if (!identity || !await nativeReturnSourceStopped(deps.vm, identity)) throw new Error("exact source is not stopped or absent; hold retained");
  }
  return deps.db.runTransaction(async (tx) => {
    const [gateway, operation, journal, currentRoot, currentUser] = await Promise.all([
      tx.get(gatewayRef), tx.get(operationRef), tx.get(journalRef), tx.get(rootRef), tx.get(userRef),
    ]);
    if (![isDeepStrictEqual(gateway.data(), runtime), isDeepStrictEqual(operation.data(), op),
      isDeepStrictEqual(currentRoot.data(), desired), isDeepStrictEqual(currentUser.data(), user)].every(Boolean)) return null;
    const status = returnOperationStatus(operation);
    if (!TERMINAL.has(status)) return null;
    const now = deps.now();
    tx.update(gatewayRef, {
      "vmHome.returnOperationId": FieldValue.delete(),
      "vmHome.checkpointRequestedAt": FieldValue.delete(),
      "vmHome.parkRequestedAt": FieldValue.delete(),
    });
    if (!journal.exists) {
      tx.set(journalRef, {
        kind: "migrate-customer",
        status: "succeeded",
        origin: "automatic",
        createdBy: NATIVE_RETURN_HOLD_REAPER_CREATOR,
        createdAt: now,
        startedAt: now,
        completedAt: now,
        lastProgressAt: now,
        expireAt: Timestamp.fromMillis(now + OPERATION_JOURNAL_RETENTION_MS),
        gatewayId,
        input: { gatewayId, returnOperationId, returnOperationStatus: status },
        output: { released: true },
        steps: [],
      });
    }
    return status;
  });
}

export async function runNativeReturnHoldReaperTick(
  deps: NativeReturnHoldReaperDeps,
): Promise<NativeReturnHoldReaperResult> {
  const docs = await mirroredOrScan(
    deps.informer.glmGateways(),
    () => deps.db.collection(GLM_GATEWAYS_COLLECTION).get(),
  );
  let released = 0;
  for (const doc of docs) {
    const returnOperationId = heldReturnOperationId(doc.data());
    if (returnOperationId === null) continue;
    try {
      const status = await releaseTerminalHold(deps, doc.id, returnOperationId);
      if (status === null) continue;
      released += 1;
      deps.log(
        `[native-return-hold-reaper] ⚠ released the native return hold on ${doc.id}: ` +
        `return operation ${returnOperationId} is ${status} and never released it`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.log(`[native-return-hold-reaper] ⚠ ${doc.id}: hold for ${returnOperationId} not released — ${message}`);
    }
  }
  return { scanned: docs.length, released };
}

export interface StartNativeReturnHoldReaperDeps extends NativeReturnHoldReaperDeps {
  intervalMs: number;
  runTick?: (deps: NativeReturnHoldReaperDeps) => Promise<NativeReturnHoldReaperResult>;
}

export function startNativeReturnHoldReaper(deps: StartNativeReturnHoldReaperDeps): () => void {
  const tick = deps.runTick ?? runNativeReturnHoldReaperTick;
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
        deps.log(`[native-return-hold-reaper] ⚠ tick failed — ${message}`);
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
