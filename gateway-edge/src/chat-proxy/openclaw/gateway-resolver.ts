import type { Firestore } from "firebase-admin/firestore";

export type GatewayResolveErrorCode =
  | "user-not-provisioned"
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

export function canonicalGatewayUrl(
  _gatewayId: string,
  namespace: string,
  port: string,
): string {
  return `http://octogee-gateway.${namespace}.svc.cluster.local:${port}`;
}

export interface ResolveGatewayOptions {
  db: Firestore;
  uid: string;
  namespace?: string;
  port?: string;
  overrideUrl?: string;
}

export interface ResolvedGateway {
  gatewayId: string;
  url: string;
  usedFallback: boolean;
  userData: Record<string, unknown>;
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

  const overrideUrl = opts.overrideUrl ?? process.env.OPENCLAW_GATEWAY_URL;
  if (typeof overrideUrl === "string" && overrideUrl.length > 0) {
    return { gatewayId, url: overrideUrl, usedFallback: false, userData };
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
    return { gatewayId, url: internalUrl, usedFallback: false, userData };
  }
  return {
    gatewayId,
    url: canonicalGatewayUrl(gatewayId, namespace, port),
    usedFallback: true,
    userData,
  };
}
