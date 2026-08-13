import type { Firestore } from "firebase-admin/firestore";
import {
  isGatewayRuntimeDoc,
  projectGatewayDesiredRootForGateway,
  type GatewayDoc,
} from "@octogee/shared/types/gateway-releases";
import { parseAssignmentDoc } from "@octogee/core/assignment-doc";
import {
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

export type ResolvedGatewayAssignment = Omit<ResolvedGateway, "url">;

function isDurableGatewayRoot(
  data: unknown,
  gatewayId: string,
): data is GatewayDoc & GatewayMutableConfig {
  return (
    projectGatewayDesiredRootForGateway(data, gatewayId) !== null
  );
}

function readInternalUrl(data: Record<string, unknown> | undefined): string {
  const hb =
    data?.heartbeat && typeof data.heartbeat === "object" && !Array.isArray(data.heartbeat)
      ? (data.heartbeat as Record<string, unknown>)
      : undefined;
  return typeof hb?.internalUrl === "string" ? hb.internalUrl : "";
}

function unresolvedGatewayUrl(gatewayId: string, detail: string): never {
  throw new GatewayResolveError(
    "gateway-url-unresolved",
    `gateways/${gatewayId} ${detail}`,
  );
}

async function readProvisionedUser(
  db: Firestore,
  uid: string,
): Promise<{ gatewayId: string; userData: Record<string, unknown> }> {
  const userSnap = await db.doc(`users/${uid}`).get();
  const userData = userSnap.data() ?? {};
  const gatewayId = userData?.provisioning?.openclaw?.gatewayId;
  if (typeof gatewayId !== "string" || gatewayId.length === 0) {
    throw new GatewayResolveError(
      "user-not-provisioned",
      `users/${uid} has no provisioning.openclaw.gatewayId`,
    );
  }
  return { gatewayId, userData };
}

async function readRuntimeUrl(
  db: Firestore,
  gatewayId: string,
  requireRuntimeDoc: boolean,
): Promise<string> {
  const runtimeSnap = await db.doc(`glmGateways/${gatewayId}`).get();
  if (!runtimeSnap.exists) {
    throw new GatewayResolveError(
      "gateway-not-registered",
      `glmGateways/${gatewayId} does not exist`,
    );
  }
  const runtimeData = (runtimeSnap.data() ?? {}) as Record<string, unknown>;
  if (
    requireRuntimeDoc &&
    (!isGatewayRuntimeDoc(runtimeData) ||
      runtimeData.gatewayId !== gatewayId ||
      runtimeData.lifecycle !== "serving")
  ) {
    unresolvedGatewayUrl(gatewayId, "does not have a serving runtime realization");
  }
  const internalUrl = readInternalUrl(runtimeData);
  if (internalUrl.length === 0) {
    throw new GatewayResolveError(
      "gateway-url-unresolved",
      `glmGateways/${gatewayId}.heartbeat.internalUrl is empty — refusing to fall back to the round-robin alias`,
    );
  }
  return internalUrl;
}

// Simple-roll resolution (GATEWAY-SIMPLE-ROLL-SPEC): a customer's serving
// instance IS their gateway's single stable-name realization. The durable root
// must be running (and any assignment doc serving); the bare-id runtime doc
// must be serving with a heartbeat internalUrl.
async function assertResolvableGateway(
  db: Firestore,
  gatewayId: string,
  uid: string,
  requireServingAssignment = false,
): Promise<{ requireRuntimeDoc: boolean }> {
  const gwSnap = await db.doc(`gateways/${gatewayId}`).get();
  if (!gwSnap.exists) {
    return { requireRuntimeDoc: false };
  }
  const gwData = gwSnap.data() ?? {};
  if (!isDurableGatewayRoot(gwData, gatewayId)) {
    throw new GatewayResolveError(
      "gateway-root-invalid",
      `gateways/${gatewayId} exists but is not a valid durable root`,
    );
  }
  if (gwData.desiredStatus !== "running") {
    unresolvedGatewayUrl(gatewayId, "is not running");
  }
  const assignmentSnap = await db.doc(`gateways/${gatewayId}/assignments/${uid}`).get();
  if (!assignmentSnap.exists) {
    if (requireServingAssignment) {
      unresolvedGatewayUrl(gatewayId, `has no serving assignment for ${uid}`);
    }
    return { requireRuntimeDoc: true };
  }
  const assignment = parseAssignmentDoc(uid, assignmentSnap.data());
  if (
    !assignment ||
    assignment.state !== "serving" ||
    (assignmentSnap.data()?.state !== undefined && assignmentSnap.data()?.state !== "serving") ||
    assignment.gatewayId !== gatewayId
  ) {
    unresolvedGatewayUrl(gatewayId, `has a non-serving assignment for ${uid}`);
  }
  return { requireRuntimeDoc: true };
}

export async function resolveGatewayAssignment(
  opts: Pick<ResolveGatewayOptions, "db" | "uid">,
): Promise<ResolvedGatewayAssignment> {
  const { gatewayId, userData } = await readProvisionedUser(opts.db, opts.uid);
  await assertResolvableGateway(opts.db, gatewayId, opts.uid, true);
  return { gatewayId, userData };
}

export async function resolveGatewayUrl(
  opts: ResolveGatewayOptions,
): Promise<ResolvedGateway> {
  const { gatewayId, userData } = await readProvisionedUser(opts.db, opts.uid);
  const overrideUrl = opts.overrideUrl ?? process.env.OPENCLAW_GATEWAY_URL;
  if (typeof overrideUrl === "string" && overrideUrl.length > 0) {
    return { gatewayId, url: overrideUrl, userData };
  }

  const gate = await assertResolvableGateway(opts.db, gatewayId, opts.uid);
  const internalUrl = await readRuntimeUrl(opts.db, gatewayId, gate.requireRuntimeDoc);
  return { gatewayId, url: internalUrl, userData };
}
