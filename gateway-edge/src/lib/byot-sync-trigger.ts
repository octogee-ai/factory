import { internalFetch } from "./internal-fetch.js";
import { logger } from "../middleware/logging.js";
import { isSafeGatewayId } from "./byosub.js";
import { createModelCredentialSyncAuthHeaders } from "./byot-sync-internal-auth.js";

export interface ModelCredentialSyncUserData {
  byotActive?: boolean;
  username?: string;
  tier?: string;
  // Plan inputs travel as-is (pickPlanInputs); the resolver tolerates non-string
  // shapes, so they mirror subscription/builderSubscription as `unknown`.
  selectedTier?: unknown;
  // resolveBillingProfile derives trial + builder state from these on the
  // gateway side; serialize them through (Timestamps → JSON) as-is — asDate
  // parses the serialized {_seconds}/{seconds}/ISO shapes.
  subscription?: unknown;
  builderSubscription?: unknown;
  trialStartedAt?: unknown;
  provisioning?: { openclaw?: { status?: string } };
  systemConfig?: {
    byot?: { provider?: string; baseUrl?: string; model?: string };
    modelCredential?: {
      active?: boolean;
      provider?: string;
      mode?: string;
      baseUrl?: string;
      model?: string;
    };
    agentModels?: Record<string, { primary: string; fallbacks: string[] }>;
  };
}

export interface GatewayModelCredentialSyncEnv {
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

export function gatewayModelCredentialSyncUrl(
  gatewayId: string,
  env: GatewayModelCredentialSyncEnv = process.env,
): string {
  if (!isSafeGatewayId(gatewayId)) {
    throw new Error(`invalid gatewayId ${JSON.stringify(gatewayId)}`);
  }
  const base = env.GATEWAY_EDGE_INTERNAL_URL_TEMPLATE
    ? env.GATEWAY_EDGE_INTERNAL_URL_TEMPLATE.replace("{gatewayId}", gatewayId)
    : `http://gateway-edge-${gatewayId}.${env.K8S_NAMESPACE ?? "octogee"}.svc.cluster.local:3001`;
  return `${trimTrailingSlash(base)}/api/g/${encodeURIComponent(gatewayId)}/internal/model-credential-sync`;
}

export async function postGatewayModelCredentialSync(args: {
  gatewayId: string;
  userData: ModelCredentialSyncUserData;
  env?: GatewayModelCredentialSyncEnv;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const env = args.env ?? process.env;
  const body = JSON.stringify(args.userData);
  const internalServiceKey = env.INTERNAL_SERVICE_KEY ?? "";
  const signingSecret = env.BYOT_SYNC_INTERNAL_SIGNING_SECRET ?? "";
  if (!internalServiceKey && !signingSecret.trim()) {
    throw new Error("BYOT_SYNC_INTERNAL_SIGNING_SECRET is required for model credential sync");
  }
  const authHeaders = signingSecret.trim()
    ? createModelCredentialSyncAuthHeaders({ body: args.userData, secret: signingSecret })
    : {};
  const res = await internalFetch(
    gatewayModelCredentialSyncUrl(args.gatewayId, env),
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
    throw new Error(`gateway model credential sync ${res.status} ${body}`.trim());
  }
}

export function triggerGatewayModelCredentialSync(args: {
  gatewayId: string;
  userData: ModelCredentialSyncUserData;
  env?: GatewayModelCredentialSyncEnv;
  fetchImpl?: typeof fetch;
  logWarn?: (msg: string) => void;
}): void {
  postGatewayModelCredentialSync(args).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    (args.logWarn ?? ((m) => logger.warn(m)))(
      `model credential sync trigger failed for ${args.gatewayId}: ${msg}`,
    );
  });
}
