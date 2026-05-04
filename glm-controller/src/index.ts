import { randomUUID } from "node:crypto";
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore, FieldValue, type Firestore } from "firebase-admin/firestore";
import {
  GLM_GATEWAYS_COLLECTION,
  GLM_OPERATIONS_COLLECTION,
  type GatewayDesiredState,
  type Operation,
} from "../../shared/types/glm.js";
import { buildInstancesMap, diffInstancesMap } from "./reconcile-plan.js";
import { createLoggingHelmRunner, type HelmRunner } from "./helm-runner.js";
import {
  routeOperation,
  stubHandler,
  type OperationHandlers,
} from "./operation-router.js";
import { createOperationContext } from "./operation-context.js";
import { createMigrateCustomerHandler } from "./handlers/migrate-customer.js";
import { createMigrationClient } from "../../scripts/lib/fleet-migration-client.js";

const log = (msg: string) => console.log(msg);

const RECONCILE_DEBOUNCE_MS = 1_000;
const HELM_RELEASE = process.env.HELM_RELEASE ?? "octogee";
const HELM_CHART = process.env.HELM_CHART ?? "/charts/octogee";
const NAMESPACE = process.env.K8S_NAMESPACE ?? "octogee";
const FLEET_CONTROLLER_PORT = process.env.FLEET_CONTROLLER_PORT ?? "3003";

interface ControllerDeps {
  db: Firestore;
  helm: HelmRunner;
  handlers: OperationHandlers;
  log: (msg: string) => void;
}

export function startReconciler(deps: ControllerDeps): () => void {
  let timer: NodeJS.Timeout | null = null;

  const tick = async () => {
    timer = null;
    try {
      const snap = await deps.db.collection(GLM_GATEWAYS_COLLECTION).get();
      const desired: GatewayDesiredState[] = snap.docs.map(
        (d) => d.data() as GatewayDesiredState,
      );
      const desiredMap = buildInstancesMap(desired);
      const actualMap = await deps.helm.readDeployedInstances({
        release: HELM_RELEASE,
        namespace: NAMESPACE,
      });
      const changes = diffInstancesMap(actualMap, desiredMap);
      if (changes.length === 0) {
        deps.log(
          `[glm-controller] reconcile tick: no changes (${desired.length} desired, ${Object.keys(actualMap).length} actual)`,
        );
        return;
      }
      deps.log(
        `[glm-controller] reconcile tick: ${changes.length} change(s) — ${changes.map((c) => `${c.kind}:${c.instanceName}`).join(", ")}`,
      );
      await deps.helm.upgrade({
        release: HELM_RELEASE,
        chart: HELM_CHART,
        namespace: NAMESPACE,
        instances: desiredMap,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.log(`[glm-controller] ⚠ reconcile tick failed: ${message}`);
    }
  };

  const unsub = deps.db.collection(GLM_GATEWAYS_COLLECTION).onSnapshot(
    () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void tick(), RECONCILE_DEBOUNCE_MS);
    },
    (err) => deps.log(`[glm-controller] ⚠ gateways snapshot error: ${String(err)}`),
  );

  return () => {
    unsub();
    if (timer) clearTimeout(timer);
  };
}

export function startOperationWorker(deps: ControllerDeps): () => void {
  const unsub = deps.db
    .collection(GLM_OPERATIONS_COLLECTION)
    .where("status", "==", "pending")
    .onSnapshot(
      async (snap) => {
        for (const change of snap.docChanges()) {
          if (change.type !== "added") continue;
          const op = { ...(change.doc.data() as Operation), id: change.doc.id };
          await processOperation(op, change.doc.ref, deps);
        }
      },
      (err) => deps.log(`[glm-controller] ⚠ operations snapshot error: ${String(err)}`),
    );

  return unsub;
}

async function processOperation(
  op: Operation,
  ref: FirebaseFirestore.DocumentReference,
  deps: ControllerDeps,
): Promise<void> {
  // Atomic claim: only this pod transitions pending → running. Two
  // controller replicas (or a re-fired snapshot listener) racing on the
  // same op would otherwise both update independently and run the work
  // twice. The transaction asserts the precondition; the loser's branch
  // returns claimed=false and bails before doing any work.
  let claimed = false;
  try {
    claimed = await deps.db.runTransaction(async (txn) => {
      const fresh = await txn.get(ref);
      if (!fresh.exists) return false;
      const data = fresh.data() as Operation | undefined;
      if (data?.status !== "pending") return false;
      txn.update(ref, { status: "running", startedAt: Date.now() });
      return true;
    });
  } catch (err) {
    deps.log(
      `[glm-controller] claim transaction failed op=${op.id}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }
  if (!claimed) {
    deps.log(`[glm-controller] op=${op.id} already claimed — skipping`);
    return;
  }

  deps.log(`[glm-controller] claim op=${op.id} kind=${op.kind}`);

  const { ctx, steps } = createOperationContext({
    persist: async (next) => {
      await ref.update({ steps: next });
    },
    log: deps.log,
    opId: op.id,
  });

  const result = await routeOperation(op, deps.handlers, ctx);
  await ref.update({
    status: result.success ? "succeeded" : "failed",
    completedAt: Date.now(),
    steps: steps.length > 0 ? steps : result.steps,
    error: result.error ?? FieldValue.delete(),
    rolledBack: result.rolledBack ?? false,
  });

  deps.log(
    `[glm-controller] op=${op.id} → ${result.success ? "succeeded" : "failed"}${result.error ? ` (${result.error})` : ""}`,
  );
}

async function main(): Promise<void> {
  initializeApp({ credential: applicationDefault() });
  const db = getFirestore();
  const helm = createLoggingHelmRunner(log);

  const handlers = await buildHandlers(db, log);

  const deps: ControllerDeps = { db, helm, handlers, log };

  log(
    `[glm-controller] starting — namespace=${NAMESPACE} release=${HELM_RELEASE} chart=${HELM_CHART}`,
  );

  const stopReconciler = startReconciler(deps);
  const stopWorker = startOperationWorker(deps);

  const shutdown = () => {
    log("[glm-controller] shutdown signal — stopping subscribers");
    stopReconciler();
    stopWorker();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

async function buildHandlers(
  db: Firestore,
  logFn: (msg: string) => void,
): Promise<OperationHandlers> {
  const secret = process.env.FLEET_CONTROLLER_SECRET;
  if (!secret) {
    throw new Error(
      "FLEET_CONTROLLER_SECRET is not set — required for migrate-customer. Refusing to start with stub handlers.",
    );
  }

  const migrateCustomer = createMigrateCustomerHandler({
    readUser: async (uid) => {
      const doc = await db.collection("users").doc(uid).get();
      if (!doc.exists) return null;
      const data = doc.data() as
        | { username?: string; provisioning?: { openclaw?: { slug?: string; gatewayId?: string } } }
        | undefined;
      const oc = data?.provisioning?.openclaw ?? {};
      const slug = oc.slug ?? data?.username;
      const currentGatewayId = oc.gatewayId;
      if (!slug || !currentGatewayId) return null;
      return { slug, currentGatewayId };
    },
    cutoverFirestore: async (uid, toGatewayId) => {
      await db
        .collection("users")
        .doc(uid)
        .update({ "provisioning.openclaw.gatewayId": toGatewayId });
    },
    resolveGatewayUrl: (gatewayId) => resolveGatewayUrlFromFirestore(db, gatewayId),
    buildClient: (resolveSync) =>
      createMigrationClient({ secret, resolveGatewayUrl: resolveSync, log: logFn }),
    genMigrationId: () => `mig-${Date.now()}-${randomUUID().slice(0, 8)}`,
    now: () => Date.now(),
    log: logFn,
  });

  return {
    "add-gateway": stubHandler("add-gateway", logFn),
    "migrate-customer": migrateCustomer,
    "retire-gateway": stubHandler("retire-gateway", logFn),
    rollout: stubHandler("rollout", logFn),
  };
}

async function resolveGatewayUrlFromFirestore(
  db: Firestore,
  gatewayId: string,
): Promise<string> {
  const doc = await db.collection(GLM_GATEWAYS_COLLECTION).doc(gatewayId).get();
  if (!doc.exists) {
    throw new Error(`gateway not registered in glmGateways: ${gatewayId}`);
  }
  const data = doc.data() as GatewayDesiredState | undefined;
  const instanceName = data?.instanceName;
  if (!instanceName) {
    throw new Error(`glmGateways/${gatewayId} missing instanceName`);
  }
  return `http://octogee-gateway-${instanceName}.${NAMESPACE}.svc.cluster.local:${FLEET_CONTROLLER_PORT}`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
