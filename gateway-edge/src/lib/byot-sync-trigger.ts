import { internalFetch } from "./internal-fetch.js";
import { logger } from "../middleware/logging.js";
import { isSafeGatewayId } from "./byosub.js";
import { createByotSyncAuthHeaders } from "./byot-sync-internal-auth.js";

export interface ByotSyncUserData {
  byotActive?: boolean;
  username?: string;
  tier?: string;
  selectedTier?: string;
  trialExpired?: boolean;
  provisioning?: { openclaw?: { status?: string } };
  systemConfig?: { byot?: { provider?: string; baseUrl?: string; model?: string } };
}

export interface GatewayByotSyncEnv {
  K8S_NAMESPACE?: string;
  GATEWAY_EDGE_INTERNAL_URL_TEMPLATE?: string;
  INTERNAL_SERVICE_KEY?: string;
  BYOT_SYNC_INTERNAL_SIGNING_SECRET?: string;
}

function trimTrailingSlash(value: string): string {
  let out = value;
  while (out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

export function gatewayByotSyncUrl(
  gatewayId: string,
  env: GatewayByotSyncEnv = process.env,
): string {
  if (!isSafeGatewayId(gatewayId)) {
    throw new Error(`invalid gatewayId ${JSON.stringify(gatewayId)}`);
  }
  const base = env.GATEWAY_EDGE_INTERNAL_URL_TEMPLATE
    ? env.GATEWAY_EDGE_INTERNAL_URL_TEMPLATE.replace("{gatewayId}", gatewayId)
    : `http://gateway-edge-${gatewayId}.${env.K8S_NAMESPACE ?? "octogee"}.svc.cluster.local:3001`;
  return `${trimTrailingSlash(base)}/api/g/${encodeURIComponent(gatewayId)}/internal/byot-sync`;
}

export async function postGatewayByotSync(args: {
  gatewayId: string;
  userData: ByotSyncUserData;
  env?: GatewayByotSyncEnv;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const env = args.env ?? process.env;
  const body = JSON.stringify(args.userData);
  const internalServiceKey = env.INTERNAL_SERVICE_KEY ?? "";
  const signingSecret = env.BYOT_SYNC_INTERNAL_SIGNING_SECRET ?? "";
  if (!internalServiceKey && !signingSecret.trim()) {
    throw new Error("BYOT_SYNC_INTERNAL_SIGNING_SECRET is required for BYOT sync");
  }
  const authHeaders = signingSecret.trim()
    ? createByotSyncAuthHeaders({ body: args.userData, secret: signingSecret })
    : {};
  const res = await internalFetch(
    gatewayByotSyncUrl(args.gatewayId, env),
    {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body,
    },
    {
      internalServiceKey,
      fetchImpl: args.fetchImpl,
    },
  );
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`gateway BYOT sync ${res.status} ${body}`.trim());
  }
}

export function triggerGatewayByotSync(args: {
  gatewayId: string;
  userData: ByotSyncUserData;
  env?: GatewayByotSyncEnv;
  fetchImpl?: typeof fetch;
  logWarn?: (msg: string) => void;
}): void {
  postGatewayByotSync(args).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    (args.logWarn ?? ((m) => logger.warn(m)))(`BYOT sync trigger failed for ${args.gatewayId}: ${msg}`);
  });
}
