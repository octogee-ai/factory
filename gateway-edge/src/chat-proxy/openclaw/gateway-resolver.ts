import type { Firestore } from "firebase-admin/firestore";
import { isGatewayDesiredDoc } from "@octogee/shared/types/gateway-releases";
import { parseAssignmentDoc } from "@octogee/core/assignment-doc";

export type GatewayResolveErrorCode =
  | "user-not-provisioned"
  | "gateway-not-registered"
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

function readInternalUrl(data: Record<string, unknown> | undefined): string {
  const hb =
    data?.heartbeat && typeof data.heartbeat === "object" && !Array.isArray(data.heartbeat)
      ? (data.heartbeat as Record<string, unknown>)
      : undefined;
  return typeof hb?.internalUrl === "string" ? hb.internalUrl : "";
}

// Resolve the serving revision id for the customer. A BACKFILLED gateway
// (GATEWAY-RELEASES-SPEC) carries its durable identity in gateways/{id} with NO
// heartbeat/internalUrl — the serving URL lives on the revision realization doc.
// A legacy pre-backfill gateway has no GatewayDoc; its relocated heartbeat lives
// at glmGateways/{gatewayId}.heartbeat, so the revision id IS the bare gateway id.
async function resolveServingRevisionId(
  db: Firestore,
  gatewayId: string,
  uid: string,
): Promise<string | null> {
  const gwSnap = await db.doc(`gateways/${gatewayId}`).get();
  const gwData = gwSnap.exists ? (gwSnap.data() ?? {}) : {};
  if (!isGatewayDesiredDoc(gwData)) {
    // Legacy gateway: heartbeat telemetry lives on the bare-id glm doc.
    return gatewayId;
  }
  // Backfilled desired doc: the customer's assignment pins the revision; a gap
  // user (no assignment yet) falls back to the gateway's live revision. Never
  // honor a flat internalUrl still contaminating the GatewayDoc — that would
  // pin whichever revision heartbeat'd last, bypassing per-customer resolution.
  const assignmentSnap = await db.doc(`gateways/${gatewayId}/assignments/${uid}`).get();
  const assignment = parseAssignmentDoc(uid, assignmentSnap.data());
  if (assignment && assignment.revisionId.length > 0) return assignment.revisionId;
  const live = gwData.liveRevisionId;
  return typeof live === "string" && live.length > 0 ? live : null;
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

  const revisionId = await resolveServingRevisionId(opts.db, gatewayId, opts.uid);
  if (!revisionId) {
    throw new GatewayResolveError(
      "gateway-url-unresolved",
      `gateways/${gatewayId} is a desired doc with no assignment and no liveRevisionId — refusing to dial a wrong revision`,
    );
  }

  const revSnap = await opts.db.doc(`glmGateways/${revisionId}`).get();
  if (!revSnap.exists) {
    throw new GatewayResolveError(
      "gateway-not-registered",
      `glmGateways/${revisionId} does not exist`,
    );
  }
  const internalUrl = readInternalUrl(revSnap.data() ?? {});
  if (internalUrl.length === 0) {
    throw new GatewayResolveError(
      "gateway-url-unresolved",
      `glmGateways/${revisionId}.heartbeat.internalUrl is empty — refusing to fall back to the round-robin alias`,
    );
  }
  return { gatewayId, url: internalUrl, userData };
}
