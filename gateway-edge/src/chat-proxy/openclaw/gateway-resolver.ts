import type { Firestore } from "firebase-admin/firestore";
import {
  isGatewayDesiredDoc,
  isGatewayRuntimeDoc,
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

function unresolvedGatewayUrl(gatewayId: string, detail: string): never {
  throw new GatewayResolveError(
    "gateway-url-unresolved",
    `gateways/${gatewayId} ${detail}`,
  );
}

// Simple-roll resolution (GATEWAY-SIMPLE-ROLL-SPEC): a customer's serving
// instance IS their gateway's single stable-name realization. The durable root
// must be running (and any assignment doc serving); the bare-id runtime doc
// must be serving with a heartbeat internalUrl.
async function assertResolvableGateway(
  db: Firestore,
  gatewayId: string,
  uid: string,
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
  if (assignmentSnap.exists) {
    const assignment = parseAssignmentDoc(uid, assignmentSnap.data());
    if (
      !assignment ||
      assignment.state !== "serving" ||
      (assignmentSnap.data()?.state !== undefined && assignmentSnap.data()?.state !== "serving") ||
      assignment.gatewayId !== gatewayId
    ) {
      unresolvedGatewayUrl(gatewayId, `has a non-serving assignment for ${uid}`);
    }
  }
  return { requireRuntimeDoc: true };
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

  const gate = await assertResolvableGateway(opts.db, gatewayId, opts.uid);

  const runtimeSnap = await opts.db.doc(`glmGateways/${gatewayId}`).get();
  if (!runtimeSnap.exists) {
    throw new GatewayResolveError(
      "gateway-not-registered",
      `glmGateways/${gatewayId} does not exist`,
    );
  }
  const runtimeData = (runtimeSnap.data() ?? {}) as Record<string, unknown>;
  if (gate.requireRuntimeDoc) {
    const serving =
      isGatewayRuntimeDoc(runtimeData) &&
      runtimeData.gatewayId === gatewayId &&
      runtimeData.lifecycle === "serving";
    if (!serving) {
      unresolvedGatewayUrl(gatewayId, "does not have a serving runtime realization");
    }
  }
  const internalUrl = readInternalUrl(runtimeData);
  if (internalUrl.length === 0) {
    throw new GatewayResolveError(
      "gateway-url-unresolved",
      `glmGateways/${gatewayId}.heartbeat.internalUrl is empty — refusing to fall back to the round-robin alias`,
    );
  }
  return { gatewayId, url: internalUrl, userData };
}
