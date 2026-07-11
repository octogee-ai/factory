import type { Firestore } from "firebase-admin/firestore";
import {
  isGatewayDesiredDoc,
  isRevisionRealizationDoc,
  revisionIdForRelease,
  type GatewayDoc,
} from "@octogee/shared/types/gateway-releases";
import { parseAssignmentDoc } from "@octogee/core/assignment-doc";
import {
  isGatewayMutableConfigForGateway,
  type GatewayMutableConfig,
} from "@octogee/core/gateway-live-release";

export type GatewayResolveErrorCode =
  | "user-not-provisioned"
  | "gateway-not-registered"
  | "gateway-root-invalid"
  | "gateway-url-unresolved";

export class GatewayResolveError extends Error {
  override readonly name = "GatewayResolveError";
  constructor(
    readonly code: GatewayResolveErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface ResolveGatewayOptions {
  db: Firestore;
  uid: string;
  overrideUrl?: string;
}

export interface ResolvedGateway {
  gatewayId: string;
  url: string;
  userData: Record<string, unknown>;
}

interface RevisionPointer {
  revisionId: string;
  release: number;
}

interface ResolvedRevision {
  revisionId: string;
  release: number | null;
}

function isDurableGatewayRoot(
  data: unknown,
  gatewayId: string,
): data is GatewayDoc & GatewayMutableConfig {
  return (
    isGatewayDesiredDoc(data) &&
    data.gatewayId === gatewayId &&
    isGatewayMutableConfigForGateway(data, gatewayId)
  );
}

function readInternalUrl(data: Record<string, unknown> | undefined): string {
  const hb =
    data?.heartbeat && typeof data.heartbeat === "object" && !Array.isArray(data.heartbeat)
      ? (data.heartbeat as Record<string, unknown>)
      : undefined;
  return typeof hb?.internalUrl === "string" ? hb.internalUrl : "";
}

function isPositiveRelease(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function canonicalRevisionPointer(
  gatewayId: string,
  revisionId: unknown,
  release: unknown,
): RevisionPointer | null {
  if (
    typeof revisionId !== "string" ||
    !isPositiveRelease(release) ||
    revisionId !== revisionIdForRelease(gatewayId, release)
  ) {
    return null;
  }
  return { revisionId, release };
}

function rootLiveRevisionPointer(
  root: GatewayDoc & GatewayMutableConfig,
): RevisionPointer | null {
  return canonicalRevisionPointer(root.gatewayId, root.liveRevisionId, root.liveRelease);
}

function rootTargetRevisionPointer(
  root: GatewayDoc & GatewayMutableConfig,
): RevisionPointer | null {
  const roll = root.roll;
  if (!roll || typeof roll !== "object") return null;
  return canonicalRevisionPointer(root.gatewayId, roll.targetRevisionId, roll.toRelease);
}

function rootRevisionPointer(
  root: GatewayDoc & GatewayMutableConfig,
  revisionId: string,
): RevisionPointer | null {
  const live = rootLiveRevisionPointer(root);
  if (live?.revisionId === revisionId) return live;
  const target = rootTargetRevisionPointer(root);
  return target?.revisionId === revisionId ? target : null;
}

function isExactServingRevision(
  data: unknown,
  gatewayId: string,
  pointer: RevisionPointer,
): boolean {
  return (
    isRevisionRealizationDoc(data) &&
    data.gateway === gatewayId &&
    data.revisionId === pointer.revisionId &&
    data.release === pointer.release &&
    data.revisionId === revisionIdForRelease(gatewayId, data.release) &&
    data.lifecycle === "serving"
  );
}

function unresolvedGatewayUrl(gatewayId: string, detail: string): never {
  throw new GatewayResolveError(
    "gateway-url-unresolved",
    `gateways/${gatewayId} ${detail}`,
  );
}

function durableLiveRevisionPointer(
  root: GatewayDoc & GatewayMutableConfig,
): RevisionPointer {
  if (root.desiredStatus !== "running") {
    unresolvedGatewayUrl(root.gatewayId, "is not running");
  }
  const live = rootLiveRevisionPointer(root);
  if (!live || root.trafficRevisionId !== live.revisionId) {
    unresolvedGatewayUrl(root.gatewayId, "has no canonical live revision pointer");
  }
  return live;
}

function resolveAssignmentRevisionPointer(
  root: GatewayDoc & GatewayMutableConfig,
  uid: string,
  assignmentData: Record<string, unknown> | undefined,
): RevisionPointer {
  const assignment = parseAssignmentDoc(uid, assignmentData);
  if (
    !assignment ||
    assignment.state !== "serving" ||
    (assignmentData?.state !== undefined && assignmentData.state !== "serving") ||
    assignment.gatewayId !== root.gatewayId
  ) {
    unresolvedGatewayUrl(root.gatewayId, `has an invalid assignment for ${uid}`);
  }
  const pointer = rootRevisionPointer(root, assignment.revisionId);
  if (
    !pointer ||
    assignment.release !== pointer.release ||
    assignment.revisionId !== revisionIdForRelease(root.gatewayId, assignment.release)
  ) {
    unresolvedGatewayUrl(root.gatewayId, `has a stale assignment for ${uid}`);
  }
  return pointer;
}

async function resolveDurableServingRevision(
  db: Firestore,
  root: GatewayDoc & GatewayMutableConfig,
  uid: string,
): Promise<RevisionPointer> {
  const live = durableLiveRevisionPointer(root);
  const assignmentSnap = await db.doc(`gateways/${root.gatewayId}/assignments/${uid}`).get();
  if (!assignmentSnap.exists) return live;
  return resolveAssignmentRevisionPointer(root, uid, assignmentSnap.data());
}

async function resolveServingRevision(
  db: Firestore,
  gatewayId: string,
  uid: string,
): Promise<ResolvedRevision> {
  const gwSnap = await db.doc(`gateways/${gatewayId}`).get();
  if (!gwSnap.exists) {
    return { revisionId: gatewayId, release: null };
  }
  const gwData = gwSnap.data() ?? {};
  if (!isDurableGatewayRoot(gwData, gatewayId)) {
    throw new GatewayResolveError(
      "gateway-root-invalid",
      `gateways/${gatewayId} exists but is not a valid durable root`,
    );
  }
  return resolveDurableServingRevision(db, gwData, uid);
}

export async function resolveGatewayUrl(
  opts: ResolveGatewayOptions,
): Promise<ResolvedGateway> {
  const userSnap = await opts.db.doc(`users/${opts.uid}`).get();
  const userData = userSnap.data() ?? {};
  const gatewayId = userData?.provisioning?.openclaw?.gatewayId;
  if (typeof gatewayId !== "string" || gatewayId.length === 0) {
    throw new GatewayResolveError(
      "user-not-provisioned",
      `users/${opts.uid} has no provisioning.openclaw.gatewayId`,
    );
  }

  const overrideUrl = opts.overrideUrl ?? process.env.OPENCLAW_GATEWAY_URL;
  if (typeof overrideUrl === "string" && overrideUrl.length > 0) {
    return { gatewayId, url: overrideUrl, userData };
  }

  const revision = await resolveServingRevision(opts.db, gatewayId, opts.uid);

  const revSnap = await opts.db.doc(`glmGateways/${revision.revisionId}`).get();
  if (!revSnap.exists) {
    throw new GatewayResolveError(
      "gateway-not-registered",
      `glmGateways/${revision.revisionId} does not exist`,
    );
  }
  const revisionData = revSnap.data() ?? {};
  if (revision.release !== null) {
    const pointer: RevisionPointer = {
      revisionId: revision.revisionId,
      release: revision.release,
    };
    if (!isExactServingRevision(revisionData, gatewayId, pointer)) {
      unresolvedGatewayUrl(
        gatewayId,
        `does not have a canonical serving revision at ${revision.revisionId}`,
      );
    }
  }
  const internalUrl = readInternalUrl(revisionData);
  if (internalUrl.length === 0) {
    throw new GatewayResolveError(
      "gateway-url-unresolved",
      `glmGateways/${revision.revisionId}.heartbeat.internalUrl is empty — refusing to fall back to the round-robin alias`,
    );
  }
  return { gatewayId, url: internalUrl, userData };
}
