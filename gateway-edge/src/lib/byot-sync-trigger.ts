import { internalFetch } from "./internal-fetch.js";
import { logger } from "../middleware/logging.js";
import { db } from "./db.js";
import { isSafeGatewayId } from "./byosub.js";
import { createModelCredentialSyncAuthHeaders } from "./byot-sync-internal-auth.js";
import {
  DEFAULT_FREE_TIER_MODEL_REF,
  PLATFORM_CONFIG_COLLECTION,
  PLATFORM_MODEL_CONFIG_DOC,
  parsePlatformModelConfig,
} from "@octogee/shared/types/platform-config";

export interface ModelCredentialSyncUserData {
  byotActive?: boolean;
  username?: string;
  tier?: string;
  // The operator's free-tier model dial. Stamped onto every push payload by
  // postGatewayModelCredentialSync — a payload without it makes the pod-side
  // derive fall back to its compiled constant, silently reverting a dialed
  // fleet; the snapshot fingerprint wouldn't change, so reconcile can't repair
  // the drift until the next mount/roll.
  freeTierModelRef?: string;
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

async function freeTierModelRefForSync(logWarn: (msg: string) => void): Promise<string> {
  try {
    const snap = await db
      .collection(PLATFORM_CONFIG_COLLECTION)
      .doc(PLATFORM_MODEL_CONFIG_DOC)
      .get();
    return parsePlatformModelConfig(snap.data())?.freeTierModelRef ?? DEFAULT_FREE_TIER_MODEL_REF;
  } catch (err) {
    logWarn(
      `free-tier dial read failed for model credential sync — sending the compiled default: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return DEFAULT_FREE_TIER_MODEL_REF;
  }
}

export async function postGatewayModelCredentialSync(args: {
  gatewayId: string;
  userData: ModelCredentialSyncUserData;
  env?: GatewayModelCredentialSyncEnv;
  fetchImpl?: typeof fetch;
  logWarn?: (msg: string) => void;
}): Promise<void> {
  const env = args.env ?? process.env;
  const internalServiceKey = env.INTERNAL_SERVICE_KEY ?? "";
  const signingSecret = env.BYOT_SYNC_INTERNAL_SIGNING_SECRET ?? "";
  if (!internalServiceKey && !signingSecret.trim()) {
    throw new Error("BYOT_SYNC_INTERNAL_SIGNING_SECRET is required for model credential sync");
  }
  const logWarn = args.logWarn ?? ((m: string) => logger.warn(m));
  const userData: ModelCredentialSyncUserData = {
    freeTierModelRef: await freeTierModelRefForSync(logWarn),
    ...args.userData,
  };
  const body = JSON.stringify(userData);
  const authHeaders = signingSecret.trim()
    ? createModelCredentialSyncAuthHeaders({ body: userData, secret: signingSecret })
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
