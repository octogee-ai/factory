import { randomUUID } from "node:crypto";
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore, FieldValue, type Firestore } from "firebase-admin/firestore";
import {
  GLM_GATEWAYS_COLLECTION,
  GLM_OPERATIONS_COLLECTION,
  type GatewayDesiredState,
  type Operation,
} from "../../shared/types/glm.js";
import {
  buildHelmTargetMap,
  buildInstancesMap,
  deriveFleetImageTag,
  diffInstancesMap,
} from "./reconcile-plan.js";
import {
  createHelmSubprocessRunner,
  createLoggingHelmRunner,
  spawnHelm,
  type HelmRunner,
} from "./helm-runner.js";
import {
  routeOperation,
  type OperationHandlers,
} from "./operation-router.js";
import { createOperationContext } from "./operation-context.js";
import { computeBootstrapWrites } from "./bootstrap.js";
import { createAddGatewayHandler } from "./handlers/add-gateway.js";
import { createMigrateCustomerHandler } from "./handlers/migrate-customer.js";
import { createRetireGatewayHandler } from "./handlers/retire-gateway.js";
import { createRolloutHandler } from "./handlers/rollout.js";
import { createDeprovisionCustomerHandler } from "./handlers/deprovision-customer.js";
import { loadCustomerCleanupContext } from "./lib/customer-ops/cleanup-context.js";
import { createGiteaCleanupClient } from "./lib/customer-ops/gitea.js";
import { createMmCleanupClient } from "./lib/customer-ops/mattermost.js";
import { signFleetRequest } from "../../scripts/lib/fleet-signature.js";
import { SIGNATURE_HEADER } from "../../shared/types/fleet-controller.js";
import { getStorage } from "firebase-admin/storage";
import { getAuth } from "firebase-admin/auth";
import { createMigrationClient } from "../../scripts/lib/fleet-migration-client.js";
import { provisionGatewayAuthSecret } from "../../scripts/lib/secret-manager.js";
import { listGatewayBuilds } from "../../scripts/lib/artifact-registry.js";
import { workspaceSlugsForUser } from "../../scripts/lib/workspace-slugs.js";
import { deleteAuthUserTolerantOfMissing } from "../../scripts/lib/firebase-auth-helpers.js";
import { startHttpServer } from "./http-server.js";

const log = (msg: string) => console.log(msg);

const RECONCILE_DEBOUNCE_MS = 1_000;
const RECONCILE_RETRY_MS_DEFAULT = 30_000;
const HELM_RELEASE = process.env.HELM_RELEASE ?? "octogee";
const HELM_CHART = process.env.HELM_CHART ?? "/charts/octogee";
const NAMESPACE = process.env.K8S_NAMESPACE ?? "octogee";
const FLEET_CONTROLLER_PORT = process.env.FLEET_CONTROLLER_PORT ?? "3003";
const HTTP_PORT = parseInt(process.env.HTTP_PORT ?? "8080", 10);

interface ControllerDeps {
  db: Firestore;
  helm: HelmRunner;
  handlers: OperationHandlers;
  log: (msg: string) => void;
  /** Retry interval after a failed reconcile tick. Defaults to 30s. */
  reconcileRetryMs?: number;
}

async function readMountedByGatewayId(
  db: Firestore,
): Promise<Map<string, readonly string[]>> {
  const snap = await db.collection("gateways").get();
  const out = new Map<string, readonly string[]>();
  for (const doc of snap.docs) {
    const data = doc.data() as { mountedCustomers?: unknown };
    const mounted = Array.isArray(data.mountedCustomers)
      ? (data.mountedCustomers.filter((s): s is string => typeof s === "string"))
      : [];
    out.set(doc.id, mounted);
  }
  return out;
}

export function startReconciler(deps: ControllerDeps): () => void {
  let debounceTimer: NodeJS.Timeout | null = null;
  let retryTimer: NodeJS.Timeout | null = null;
  let inFlight = false;
  let stopped = false;
  const retryMs = deps.reconcileRetryMs ?? RECONCILE_RETRY_MS_DEFAULT;

  const tick = async () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    if (inFlight) return;
    inFlight = true;
    try {
      const snap = await deps.db.collection(GLM_GATEWAYS_COLLECTION).get();
      const desired: GatewayDesiredState[] = snap.docs.map(
        (d) => d.data() as GatewayDesiredState,
      );
      const actualMap = await deps.helm.readDeployedInstances({
        release: HELM_RELEASE,
        namespace: NAMESPACE,
      });
      const mountedByGatewayId = await readMountedByGatewayId(deps.db);
      const desiredMap = buildInstancesMap(desired);
      const changes = diffInstancesMap(actualMap, desiredMap);
      const targetMap = buildHelmTargetMap(desired, actualMap, mountedByGatewayId);
      const preservedDrift = changes.filter(
        (c) =>
          c.kind === "drift" &&
          Object.prototype.hasOwnProperty.call(targetMap, c.instanceName),
      );
      if (preservedDrift.length > 0) {
        deps.log(
          `[glm-controller] drift detected (preserved, not removed): ${preservedDrift.map((d) => d.instanceName).join(", ")}`,
        );
      }
      const targetVsActual = diffInstancesMap(actualMap, targetMap);
      const upgradeNeeded = targetVsActual.length > 0;
      if (!upgradeNeeded) {
        deps.log(
          `[glm-controller] reconcile tick: no changes (${desired.length} desired, ${Object.keys(actualMap).length} actual)`,
        );
        return;
      }
      const summary = targetVsActual
        .map((c) => `${c.kind === "drift" ? "remove" : c.kind}:${c.instanceName}`)
        .join(", ");
      deps.log(
        `[glm-controller] reconcile tick: ${targetVsActual.length} change(s) — ${summary}`,
      );
      await deps.helm.upgrade({
        release: HELM_RELEASE,
        chart: HELM_CHART,
        namespace: NAMESPACE,
        instances: targetMap,
        fleetImageTag: deriveFleetImageTag(desired),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.log(
        `[glm-controller] ⚠ reconcile tick failed: ${message} — retry in ${retryMs}ms`,
      );
      if (!stopped) {
        retryTimer = setTimeout(() => void tick(), retryMs);
      }
    } finally {
      inFlight = false;
    }
  };

  const unsub = deps.db.collection(GLM_GATEWAYS_COLLECTION).onSnapshot(
    () => {
      if (stopped) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => void tick(), RECONCILE_DEBOUNCE_MS);
    },
    (err) => deps.log(`[glm-controller] ⚠ gateways snapshot error: ${String(err)}`),
  );

  return () => {
    stopped = true;
    unsub();
    if (debounceTimer) clearTimeout(debounceTimer);
    if (retryTimer) clearTimeout(retryTimer);
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

  const status = result.success ? "succeeded" : "failed";
  const errSuffix = result.error ? ` (${result.error})` : "";
  deps.log(`[glm-controller] op=${op.id} → ${status}${errSuffix}`);
}

async function main(): Promise<void> {
  initializeApp({ credential: applicationDefault() });
  const db = getFirestore();
  const helm =
    process.env.HELM_RUNNER_MODE === "stub"
      ? createLoggingHelmRunner(log)
      : createHelmSubprocessRunner({ runHelm: spawnHelm, log });

  const handlers = await buildHandlers(db, log, helm);

  const deps: ControllerDeps = { db, helm, handlers, log };

  log(
    `[glm-controller] starting — namespace=${NAMESPACE} release=${HELM_RELEASE} chart=${HELM_CHART}`,
  );

  await bootstrapGlmGateways(deps);

  const stopReconciler = startReconciler(deps);
  const stopWorker = startOperationWorker(deps);
  const stopHttp = startHttpServer({
    db,
    log,
    port: HTTP_PORT,
    verifyIdToken: async (token) => {
      const decoded = await getAuth().verifyIdToken(token);
      return { uid: decoded.uid };
    },
    workspaceSlugsForUser,
    provisionGatewayAuthSecret,
    listGatewayBuilds,
    deleteAuthUserTolerantOfMissing: (uid) => deleteAuthUserTolerantOfMissing(uid, getAuth()),
  });

  const shutdown = () => {
    log("[glm-controller] shutdown signal — stopping subscribers");
    stopReconciler();
    stopWorker();
    stopHttp();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

export async function bootstrapGlmGateways(deps: ControllerDeps): Promise<void> {
  let actualMap;
  try {
    actualMap = await deps.helm.readDeployedInstances({
      release: HELM_RELEASE,
      namespace: NAMESPACE,
    });
  } catch (err) {
    deps.log(
      `[glm-controller] ⚠ bootstrap skipped — failed to read helm state: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }
  const snap = await deps.db.collection(GLM_GATEWAYS_COLLECTION).get();
  const known = new Set(snap.docs.map((d) => d.id));
  const writes = computeBootstrapWrites(actualMap, known);
  if (writes.length === 0) {
    deps.log(
      `[glm-controller] bootstrap: ${Object.keys(actualMap).length} helm instance(s) already registered, no writes`,
    );
    return;
  }
  for (const w of writes) {
    try {
      await deps.db.collection(GLM_GATEWAYS_COLLECTION).doc(w.gatewayId).create(w.doc);
      deps.log(
        `[glm-controller] bootstrap: registering existing instance ${w.doc.instanceName} as glmGateways/${w.gatewayId}`,
      );
    } catch (err) {
      if ((err as { code?: number })?.code === 6) {
        deps.log(
          `[glm-controller] bootstrap: skip ${w.gatewayId} — operator wrote a doc between snapshot and create`,
        );
        continue;
      }
      throw err;
    }
  }
}

async function buildHandlers(
  db: Firestore,
  logFn: (msg: string) => void,
  helm: HelmRunner,
): Promise<OperationHandlers> {
  const secret = process.env.FLEET_CONTROLLER_SECRET;
  if (!secret) {
    throw new Error(
      "FLEET_CONTROLLER_SECRET is not set — required for migrate-customer. Refusing to start with stub handlers.",
    );
  }

  const addGateway = createAddGatewayHandler({
    helm,
    readGatewayHeartbeat: async (gatewayId) => {
      const doc = await db.collection("gateways").doc(gatewayId).get();
      if (!doc.exists) return null;
      const data = doc.data() as
        | { lastHeartbeatAt?: { toMillis?: () => number } | number | Date }
        | undefined;
      const raw = data?.lastHeartbeatAt;
      if (raw == null) return null;
      let ms: number | null = null;
      if (typeof raw === "number") ms = raw;
      else if (raw instanceof Date) ms = raw.getTime();
      else if (typeof (raw as { toMillis?: () => number }).toMillis === "function") {
        ms = (raw as { toMillis: () => number }).toMillis();
      }
      return ms == null ? null : { lastHeartbeatAt: ms };
    },
    helmRenderTimeoutMs: 60_000,
    heartbeatTimeoutMs: 240_000,
    pollIntervalMs: 5_000,
    now: () => Date.now(),
    wait: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: logFn,
  });

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

  const retireGateway = createRetireGatewayHandler({
    helm,
    readGatewayLiveState: async (gatewayId) => {
      const doc = await db.collection("gateways").doc(gatewayId).get();
      if (!doc.exists) return null;
      const data = doc.data() as
        | { mountedCustomers?: unknown; inFlightJobId?: unknown }
        | undefined;
      const mounted = Array.isArray(data?.mountedCustomers)
        ? (data!.mountedCustomers as unknown[]).filter((s): s is string => typeof s === "string")
        : [];
      const inFlightJobId =
        typeof data?.inFlightJobId === "string" && data.inFlightJobId.length > 0
          ? data.inFlightJobId
          : null;
      return { mountedCustomers: mounted, inFlightJobId };
    },
    readGlmGatewayInstanceName: async (gatewayId) => {
      const doc = await db.collection(GLM_GATEWAYS_COLLECTION).doc(gatewayId).get();
      if (!doc.exists) return null;
      const data = doc.data() as GatewayDesiredState | undefined;
      return data?.instanceName ?? null;
    },
    deleteGlmGateway: async (gatewayId) => {
      await db.collection(GLM_GATEWAYS_COLLECTION).doc(gatewayId).delete();
    },
    deleteGatewayHeartbeat: async (gatewayId) => {
      await db.collection("gateways").doc(gatewayId).delete();
    },
    // archiveAuthTokenSecret intentionally omitted — leaves the SM
    // secret in place so re-creating the gateway with the same id is
    // idempotent. Auth tokens rotate per pod boot anyway.
    helmUninstallTimeoutMs: 90_000,
    pollIntervalMs: 5_000,
    now: () => Date.now(),
    wait: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: logFn,
  });

  const rollout = createRolloutHandler({
    helm,
    readCurrentSpec: async (gatewayId) => {
      const doc = await db.collection(GLM_GATEWAYS_COLLECTION).doc(gatewayId).get();
      if (!doc.exists) return null;
      const data = doc.data() as GatewayDesiredState | undefined;
      if (!data?.instanceName || !data.imageRepository || !data.imageTag) return null;
      return {
        instanceName: data.instanceName,
        imageRepository: data.imageRepository,
        imageTag: data.imageTag,
      };
    },
    updateGlmGatewayImage: async (gatewayId, imageRepository, imageTag) => {
      await db.collection(GLM_GATEWAYS_COLLECTION).doc(gatewayId).update({
        imageRepository,
        imageTag,
      });
    },
    readGatewayHeartbeat: async (gatewayId) => {
      const doc = await db.collection("gateways").doc(gatewayId).get();
      if (!doc.exists) return null;
      const data = doc.data() as
        | { version?: unknown; lastHeartbeatAt?: { toMillis?: () => number } | number | Date }
        | undefined;
      const version = typeof data?.version === "string" ? data.version : null;
      const raw = data?.lastHeartbeatAt;
      let lastHeartbeatAt = 0;
      if (typeof raw === "number") lastHeartbeatAt = raw;
      else if (raw instanceof Date) lastHeartbeatAt = raw.getTime();
      else if (typeof (raw as { toMillis?: () => number })?.toMillis === "function") {
        lastHeartbeatAt = (raw as { toMillis: () => number }).toMillis();
      }
      return { version, lastHeartbeatAt };
    },
    helmRenderTimeoutMs: 60_000,
    heartbeatTimeoutMs: 240_000,
    pollIntervalMs: 5_000,
    now: () => Date.now(),
    wait: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: logFn,
  });

  const deprovisionCustomer = buildDeprovisionCustomerHandler(db, secret, logFn);

  return {
    "add-gateway": addGateway,
    "migrate-customer": migrateCustomer,
    "retire-gateway": retireGateway,
    rollout,
    "deprovision-customer": deprovisionCustomer,
  };
}

function buildDeprovisionCustomerHandler(
  db: Firestore,
  secret: string,
  logFn: (msg: string) => void,
) {
  const giteaApiUrl =
    // eslint-disable-next-line sonarjs/no-clear-text-protocols -- in-cluster ClusterIP service, not internet-facing
    process.env.GIT_API_URL ?? "http://gitea-http.octogee.svc.cluster.local:3000/api/v1";
  const giteaToken = process.env.GIT_API_TOKEN ?? "";
  const giteaOrg = process.env.GIT_ORG ?? "octogee";
  const mmBaseUrl = process.env.MM_URL ?? "";
  const mmAdminToken = process.env.MM_ADMIN_TOKEN ?? "";

  const gitea = createGiteaCleanupClient({
    apiUrl: giteaApiUrl,
    token: giteaToken,
    log: logFn,
  });
  const mattermost = createMmCleanupClient({
    baseUrl: mmBaseUrl,
    adminToken: mmAdminToken,
    log: logFn,
  });

  return createDeprovisionCustomerHandler({
    loadCleanupContext: (uid) => loadCustomerCleanupContext({ db, giteaOrg }, uid),
    unmountFromGateway: (gatewayId, slug) =>
      callUnmountRpc(db, secret, gatewayId, slug, logFn),
    cloudCleanup: {
      gitea,
      mattermost,
      nukeUserFirestore: async (uid) => {
        const userRef = db.collection("users").doc(uid);
        await db.recursiveDelete(userRef.collection("secrets"));
        await db.recursiveDelete(userRef.collection("settings"));
        await db.recursiveDelete(userRef.collection("deploys"));
        await db.recursiveDelete(userRef.collection("customers"));
        await db.recursiveDelete(userRef.collection("workspaces"));
        await userRef.delete();
        await db.recursiveDelete(db.collection("customerStats").doc(uid));
      },
      nukeWsTickets: async (uid) => {
        // Firestore batches max out at 500 writes; chunk so a customer
        // with thousands of historical wsTickets doesn't fail the
        // firestore step. (Copilot review)
        const FIRESTORE_BATCH_LIMIT = 500;
        const snap = await db.collection("wsTickets").where("uid", "==", uid).get();
        for (let i = 0; i < snap.docs.length; i += FIRESTORE_BATCH_LIMIT) {
          const batch = db.batch();
          for (const doc of snap.docs.slice(i, i + FIRESTORE_BATCH_LIMIT)) {
            batch.delete(doc.ref);
          }
          await batch.commit();
        }
        return { deleted: snap.size };
      },
      deleteAvatar: async (uid) => {
        const file = getStorage().bucket().file(`avatars/${uid}`);
        const [exists] = await file.exists();
        if (exists) await file.delete();
      },
      deleteAuthUser: async (uid) => {
        try {
          await getAuth().deleteUser(uid);
        } catch (err) {
          // Match on Firebase's structured `.code` rather than message
          // substring — avoids swallowing unrelated errors. (Review-agent)
          const code = (err as { code?: string } | null | undefined)?.code;
          if (code === "auth/user-not-found") return;
          throw err;
        }
      },
      log: logFn,
    },
    now: () => Date.now(),
    log: logFn,
  });
}

// loadCustomerCleanupContext moved to lib/customer-ops/cleanup-context.ts
// for direct testability. Wiring layer here just adapts the call shape.

async function callUnmountRpc(
  db: Firestore,
  secret: string,
  gatewayId: string,
  slug: string,
  log: (msg: string) => void,
): Promise<void> {
  // Resolve gateway URL by reading the same Firestore desired-state doc
  // the migrate-customer handler uses.
  const url = await resolveGatewayUrlFromFirestore(db, gatewayId);
  const migrationId = `deprov-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const body = JSON.stringify({ migrationId, slug });
  const signature = signFleetRequest(secret, migrationId, body);
  const resp = await fetch(`${url}/unmount/${gatewayId}`, {
    method: "POST",
    headers: { "content-type": "application/json", [SIGNATURE_HEADER]: signature },
    body,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "<no body>");
    throw new Error(`unmount failed: ${resp.status} ${text.slice(0, 200)}`);
  }
  log(`[deprovision] unmount RPC ok gatewayId=${gatewayId} slug=${slug}`);
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
