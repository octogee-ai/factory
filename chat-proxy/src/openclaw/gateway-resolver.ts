/**
 * Resolve a user's assigned OpenClaw gateway URL.
 *
 * Reads `users/{uid}.provisioning.openclaw.gatewayId` → then
 * `gateways/{gatewayId}.internalUrl` (written by the fleet provisioner's
 * heartbeat). Falls back to the canonical cluster-internal DNS name if
 * the `internalUrl` field hasn't been populated yet — the transition
 * period immediately after a fleet deploy when older gateway pods
 * haven't cycled through a fresh heartbeat.
 */
import type { Firestore } from "firebase-admin/firestore";

export type GatewayResolveErrorCode =
  /** users/{uid} doc missing or has no provisioning.openclaw.gatewayId. */
  | "user-not-provisioned"
  /** gateways/{id} doc missing, gateway isn't registered. */
  | "gateway-not-registered";

export class GatewayResolveError extends Error {
  override readonly name = "GatewayResolveError";
  constructor(
    readonly code: GatewayResolveErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Canonical DNS shape for a cluster-internal OpenClaw gateway endpoint.
 * Matches the URL the fleet provisioner writes to `gateways/{id}.internalUrl`.
 * Exported for fallback when the heartbeat hasn't landed yet on a fresh
 * fleet pod.
 */
export function canonicalGatewayUrl(
  gatewayId: string,
  namespace: string,
  port: string,
): string {
  return `http://octogee-gateway-${gatewayId}.${namespace}.svc.cluster.local:${port}`;
}

export interface ResolveGatewayOptions {
  db: Firestore;
  uid: string;
  /** K8s namespace for fallback URL construction. Default: `K8S_NAMESPACE` env or `octogee`. */
  namespace?: string;
  /** Gateway RPC port for fallback. Default: `OPENCLAW_GATEWAY_PORT` env or `18789`. */
  port?: string;
}

export interface ResolvedGateway {
  gatewayId: string;
  url: string;
  /** True when we fell back to the canonical DNS shape because
   *  `gateways/{id}.internalUrl` was absent or empty. Logged but non-fatal. */
  usedFallback: boolean;
}

export async function resolveGatewayUrl(
  opts: ResolveGatewayOptions,
): Promise<ResolvedGateway> {
  const namespace = opts.namespace ?? process.env.K8S_NAMESPACE ?? "octogee";
  const port = opts.port ?? process.env.OPENCLAW_GATEWAY_PORT ?? "18789";

  const userSnap = await opts.db.doc(`users/${opts.uid}`).get();
  const userData = userSnap.data() ?? {};
  const gatewayId = userData?.provisioning?.openclaw?.gatewayId;
  if (typeof gatewayId !== "string" || gatewayId.length === 0) {
    throw new GatewayResolveError(
      "user-not-provisioned",
      `users/${opts.uid} has no provisioning.openclaw.gatewayId`,
    );
  }

  const gwSnap = await opts.db.doc(`gateways/${gatewayId}`).get();
  if (!gwSnap.exists) {
    throw new GatewayResolveError(
      "gateway-not-registered",
      `gateways/${gatewayId} does not exist`,
    );
  }
  const gwData = gwSnap.data() ?? {};
  const internalUrl = typeof gwData.internalUrl === "string" ? gwData.internalUrl : "";

  if (internalUrl.length > 0) {
    return { gatewayId, url: internalUrl, usedFallback: false };
  }
  return {
    gatewayId,
    url: canonicalGatewayUrl(gatewayId, namespace, port),
    usedFallback: true,
  };
}
