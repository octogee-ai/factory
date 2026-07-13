import type { Firestore } from "firebase-admin/firestore";

import {
  GLM_OPERATIONS_COLLECTION,
  isGatewayClass,
  isGatewayProfile,
  resolveGatewayClass,
} from "@octogee/shared/types/glm";
import { GATEWAYS_COLLECTION } from "@octogee/shared/types/fleet-controller";
import {
  isGatewayMutableConfigForGateway,
  type GatewayMutableConfig,
} from "@octogee/shared/types/gateway-mutable-config";
import {
  isGatewayDesiredDoc,
  type GatewayDoc,
} from "@octogee/shared/types/gateway-releases";
import { readGatewayLiveRevisionHeartbeat } from "./gateway-live-release.js";

export type ActivationGatewayClass = "builder" | "operator";

export interface FirestoreDocLike {
  id: string;
  data(): Record<string, unknown>;
}

export interface RolloutBodyError {
  status: number;
  body: Record<string, unknown>;
}

export interface BuilderActivationTarget {
  gatewayId: string;
  gatewayClass: ActivationGatewayClass;
  desiredStatus: "running" | "paused" | "draining" | "retired" | null;
  builderSlug: string | null;
}

export type BuilderActivationPlan =
  | {
      ok:
        | { action: "already-active"; target: BuilderActivationTarget }
        | { action: "wake"; target: BuilderActivationTarget; status: string }
        | { action: "migrate"; target: BuilderActivationTarget };
    }
  | { error: RolloutBodyError };

export type BuilderActivationLeaseResult = {
  statusCode: number;
  body: Record<string, unknown>;
};

type WorkspaceSlugsForUser = (data: { username?: string | null }) => string[];
type DurableActivationGateway = GatewayDoc & GatewayMutableConfig;

function asStringOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function readUserGatewayId(data: Record<string, unknown> | undefined): string | null {
  const provisioning =
    (data?.provisioning as Record<string, unknown> | undefined) ?? {};
  const openclaw =
    (provisioning.openclaw as Record<string, unknown> | undefined) ?? {};
  return asStringOrNull(openclaw.gatewayId);
}

function projectDesiredStatus(
  data: { desiredStatus?: unknown } | undefined,
): "running" | "paused" | "draining" | "retired" | null {
  const v = data?.desiredStatus;
  if (v === "running" || v === "paused" || v === "draining" || v === "retired") return v;
  return null;
}

function resolveCustomerSlug(
  userData: Record<string, unknown>,
  workspaceSlugsForUser: WorkspaceSlugsForUser,
): string | null {
  const provisioning =
    (userData.provisioning as Record<string, unknown> | undefined) ?? {};
  const openclaw =
    (provisioning.openclaw as Record<string, unknown> | undefined) ?? {};
  const openclawSlug = asStringOrNull(openclaw.slug);
  return (
    openclawSlug ??
    workspaceSlugsForUser(userData as { username?: string | null })[0] ??
    null
  );
}

export function findPendingActivationOperation(
  docs: ReadonlyArray<FirestoreDocLike>,
  uid: string,
  gatewayId: string,
  source: string,
): { id: string; kind: unknown } | null {
  for (const doc of docs) {
    const data = doc.data();
    const input =
      typeof data.input === "object" && data.input !== null
        ? (data.input as Record<string, unknown>)
        : {};
    if (
      data.kind === "migrate-customer" &&
      input.uid === uid &&
      input.toGatewayId === gatewayId &&
      input.source === source
    ) {
      return { id: doc.id, kind: data.kind };
    }
  }
  return null;
}

function gatewayActivationClass(
  data: {
    gatewayClass?: unknown;
    profile?: unknown;
    imageProfile?: unknown;
  },
): ActivationGatewayClass | "shared" {
  return resolveGatewayClass({
    gatewayClass: isGatewayClass(data.gatewayClass) ? data.gatewayClass : undefined,
    profile: isGatewayProfile(data.profile) ? data.profile : undefined,
    imageProfile: isGatewayProfile(data.imageProfile) ? data.imageProfile : undefined,
  });
}

function durableActivationGateway(
  doc: FirestoreDocLike,
): DurableActivationGateway | null {
  const data = doc.data();
  if (
    !isGatewayDesiredDoc(data) ||
    data.gatewayId !== doc.id ||
    !isGatewayMutableConfigForGateway(data, doc.id)
  ) {
    return null;
  }
  return data as DurableActivationGateway;
}

function isInactiveDedicatedStatus(
  status: BuilderActivationTarget["desiredStatus"],
): boolean {
  return status === "draining" || status === "retired";
}

export function resolveBuilderActivationPlan(opts: {
  uid: string;
  builderSlug: string;
  currentGatewayId: string | null;
  requestedGatewayClass?: ActivationGatewayClass;
  gateways: ReadonlyArray<FirestoreDocLike>;
  gatewayHeartbeats: ReadonlyMap<string, Record<string, unknown>>;
  pendingOps: ReadonlyArray<FirestoreDocLike>;
}): BuilderActivationPlan {
  if (!opts.currentGatewayId) {
    return {
      error: {
        status: 409,
        body: {
          code: "no-current-gateway-assignment",
          error: "user has no current gateway assignment; assign before activation",
          uid: opts.uid,
        },
      },
    };
  }

  const ownedClassGateways = opts.gateways
    .map((doc): BuilderActivationTarget | null => {
      const data = durableActivationGateway(doc);
      if (!data) return null;
      if (data.ownerUid !== opts.uid) return null;
      const gatewayClass = gatewayActivationClass(data);
      if (gatewayClass === "shared") return null;
      if (opts.requestedGatewayClass && gatewayClass !== opts.requestedGatewayClass) {
        return null;
      }
      return {
        gatewayId: doc.id,
        gatewayClass,
        desiredStatus: projectDesiredStatus(data),
        builderSlug: asStringOrNull(data.builderSlug),
      };
    })
    .filter((v): v is BuilderActivationTarget => v !== null);

  const slugMismatches = ownedClassGateways.filter(
    (gw) => gw.builderSlug !== null && gw.builderSlug !== opts.builderSlug,
  );
  if (slugMismatches.length > 0) {
    return {
      error: {
        status: 409,
        body: {
          code: "owned-activation-gateway-slug-mismatch",
          error: "owned activation gateway builderSlug does not match user slug",
          uid: opts.uid,
          builderSlug: opts.builderSlug,
          gatewayIds: slugMismatches.map((gw) => gw.gatewayId),
        },
      },
    };
  }

  const candidates = ownedClassGateways.filter(
    (gw) => gw.builderSlug === null || gw.builderSlug === opts.builderSlug,
  );
  if (candidates.length === 0) {
    return {
      error: {
        status: 404,
        body: {
          code: "no-owned-dedicated-activation-gateway",
          error: "no owned dedicated activation gateway found",
          uid: opts.uid,
          builderSlug: opts.builderSlug,
          ...(opts.requestedGatewayClass ? { gatewayClass: opts.requestedGatewayClass } : {}),
        },
      },
    };
  }
  if (candidates.length > 1) {
    return {
      error: {
        status: 409,
        body: {
          code: "multiple-owned-activation-gateways",
          error: "multiple owned activation gateways match; operator must choose one",
          uid: opts.uid,
          builderSlug: opts.builderSlug,
          ...(opts.requestedGatewayClass ? { gatewayClass: opts.requestedGatewayClass } : {}),
          gatewayIds: candidates.map((gw) => gw.gatewayId),
        },
      },
    };
  }

  const target = candidates[0];
  if (isInactiveDedicatedStatus(target.desiredStatus)) {
    return {
      error: {
        status: 409,
        body: {
          code: "activation-gateway-not-runnable",
          error: "activation gateway is not runnable",
          gatewayId: target.gatewayId,
          desiredStatus: target.desiredStatus,
        },
      },
    };
  }

  const targetHeartbeat = opts.gatewayHeartbeats.get(target.gatewayId);
  const targetStatus =
    typeof targetHeartbeat?.status === "string"
      ? targetHeartbeat.status
      : "missing";
  if (opts.currentGatewayId === target.gatewayId) {
    if (targetStatus === "ready") return { ok: { action: "already-active", target } };
    return { ok: { action: "wake", target, status: targetStatus } };
  }

  const existing = findPendingActivationOperation(
    opts.pendingOps,
    opts.uid,
    target.gatewayId,
    "builder-activation-lease",
  );
  if (existing) {
    return {
      error: {
        status: 409,
        body: {
          code: "builder-activation-already-running",
          error: "builder activation is already running",
          uid: opts.uid,
          gatewayId: target.gatewayId,
          operationId: existing.id,
          kind: existing.kind,
        },
      },
    };
  }

  if (targetStatus !== "ready") {
    return { ok: { action: "wake", target, status: targetStatus } };
  }
  return { ok: { action: "migrate", target } };
}

export async function requestBuilderActivationLease(opts: {
  db: Firestore;
  uid: string;
  requestedGatewayClass?: ActivationGatewayClass;
  reason?: string;
  createdBy: string;
  workspaceSlugsForUser: WorkspaceSlugsForUser;
  now?: number;
}): Promise<BuilderActivationLeaseResult> {
  const { db, uid } = opts;
  const now = opts.now ?? Date.now();
  const userRef = db.collection("users").doc(uid);
  const [userSnap, gatewaySnap, pendingOpsSnap] = await Promise.all([
    userRef.get(),
    db.collection(GATEWAYS_COLLECTION).get(),
    db
      .collection(GLM_OPERATIONS_COLLECTION)
      .where("status", "in", ["pending", "running"])
      .get(),
  ]);
  if (!userSnap.exists) {
    return {
      statusCode: 404,
      body: { code: "user-not-found", error: "user not found", uid },
    };
  }
  const userData = userSnap.data() as Record<string, unknown>;
  const currentGatewayId = readUserGatewayId(userData);
  const builderSlug = resolveCustomerSlug(userData, opts.workspaceSlugsForUser);
  if (!builderSlug) {
    return {
      statusCode: 409,
      body: {
        code: "no-resolvable-builder-slug",
        error: "user has no resolvable builder slug",
        uid,
      },
    };
  }

  const gatewayRoots = gatewaySnap.docs
    .map((doc) => ({ doc: doc as FirestoreDocLike, root: durableActivationGateway(doc) }))
    .filter((entry): entry is { doc: FirestoreDocLike; root: DurableActivationGateway } =>
      entry.root !== null,
    );
  const gatewayHeartbeats = new Map<string, Record<string, unknown>>();
  const liveHeartbeats = await Promise.all(
    gatewayRoots.map(async ({ root }) => ({
      gatewayId: root.gatewayId,
      heartbeat: await readGatewayLiveRevisionHeartbeat(db, root),
    })),
  );
  for (const { gatewayId, heartbeat } of liveHeartbeats) {
    if (heartbeat) gatewayHeartbeats.set(gatewayId, heartbeat);
  }
  const plan = resolveBuilderActivationPlan({
    uid,
    builderSlug,
    currentGatewayId,
    requestedGatewayClass: opts.requestedGatewayClass,
    gateways: gatewayRoots.map(({ doc }) => doc),
    gatewayHeartbeats,
    pendingOps: pendingOpsSnap.docs as ReadonlyArray<FirestoreDocLike>,
  });
  if ("error" in plan) {
    return {
      statusCode: plan.error.status,
      body: plan.error.body,
    };
  }

  const target = plan.ok.target;
  const leaseBase = {
    gatewayId: target.gatewayId,
    gatewayClass: target.gatewayClass,
    builderSlug,
    requestedAt: now,
    requestedBy: opts.createdBy,
    reason: opts.reason && opts.reason.length > 0 ? opts.reason : "builder-activity",
  };

  if (plan.ok.action === "already-active") {
    await userRef.update({
      "provisioning.openclaw.activationLease": {
        ...leaseBase,
        status: "active",
        activeAt: now,
      },
    });
    return {
      statusCode: 200,
      body: {
        uid,
        builderSlug,
        gatewayId: target.gatewayId,
        gatewayClass: target.gatewayClass,
        status: "active",
        alreadyActive: true,
      },
    };
  }

  const targetRef = db.collection(GATEWAYS_COLLECTION).doc(target.gatewayId);
  if (plan.ok.action === "wake") {
    const batch = db.batch();
    batch.update(targetRef, { desiredStatus: "running" });
    batch.update(userRef, {
      "provisioning.openclaw.activationLease": {
        ...leaseBase,
        status: "waking",
        targetStatus: plan.ok.status,
      },
    });
    await batch.commit();
    return {
      statusCode: 202,
      body: {
        uid,
        builderSlug,
        gatewayId: target.gatewayId,
        gatewayClass: target.gatewayClass,
        status: "waking",
        targetStatus: plan.ok.status,
        retryAfterMs: 15_000,
      },
    };
  }

  const opRef = db.collection(GLM_OPERATIONS_COLLECTION).doc();
  const operationId = opRef.id;
  const operationInput = {
    uid,
    ...(currentGatewayId ? { fromGatewayId: currentGatewayId } : {}),
    toGatewayId: target.gatewayId,
    source: "builder-activation-lease",
    builderSlug,
    gatewayClass: target.gatewayClass,
    reason: leaseBase.reason,
  };
  const batch = db.batch();
  batch.update(targetRef, { desiredStatus: "running" });
  batch.set(opRef, {
    kind: "migrate-customer",
    status: "pending",
    createdBy: opts.createdBy,
    createdAt: now,
    startedAt: null,
    completedAt: null,
    input: operationInput,
    steps: [],
    gatewayId: target.gatewayId,
    inputUid: uid,
  });
  batch.update(userRef, {
    "provisioning.openclaw.activationLease": {
      ...leaseBase,
      status: "activating",
      operationId,
    },
  });
  await batch.commit();

  return {
    statusCode: 202,
    body: {
      uid,
      builderSlug,
      gatewayId: target.gatewayId,
      gatewayClass: target.gatewayClass,
      operationId,
      status: "activating",
    },
  };
}

export function activationLeaseMissCanMintTicket(result: BuilderActivationLeaseResult): boolean {
  const code = result.body.code;
  return (
    code === "no-current-gateway-assignment" ||
    code === "no-owned-dedicated-activation-gateway" ||
    code === "multiple-owned-activation-gateways" ||
    code === "no-resolvable-builder-slug"
  );
}
