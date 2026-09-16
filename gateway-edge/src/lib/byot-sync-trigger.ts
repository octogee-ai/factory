import { internalFetch } from "./internal-fetch.js";
import { isIPv4 } from "node:net";
import { logger } from "../middleware/logging.js";
import { db } from "./db.js";
import { isSafeGatewayId } from "./byosub.js";
import { createModelCredentialSyncAuthHeaders } from "./byot-sync-internal-auth.js";
import {
  DEFAULT_FREE_TIER_MODEL_REF,
  PLATFORM_CONFIG_COLLECTION,
  PLATFORM_MODEL_CONFIG_DOC,
  builderAgentModelDefaultFromDoc,
  resolveFreeTierModel,
  type BuilderAgentModelDefault,
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
  // The operator's Builder Agent default dial, stamped alongside the free-tier
  // dial: the {primary, fallbacks} a catalog coach runs with no explicit pick.
  builderAgentDefault?: BuilderAgentModelDefault;
  // Plan inputs travel as-is (pickPlanInputs); the resolver tolerates non-string
  // shapes, so they mirror subscription/builderSubscription as `unknown`.
  selectedTier?: unknown;
  // resolveBillingProfile derives signup-offer + builder state from these on the
  // gateway side; serialize the receipt (Timestamps → JSON) as-is — asDate
  // parses the serialized {_seconds}/{seconds}/ISO shapes.
  subscription?: unknown;
  builderSubscription?: unknown;
  trialGrant?: unknown;
  signupOfferConvertedAt?: unknown;
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
  runtime?: { runtime?: unknown; vm?: { status?: unknown; internalIp?: unknown } },
): string {
  if (!isSafeGatewayId(gatewayId)) {
    throw new Error(`invalid gatewayId ${JSON.stringify(gatewayId)}`);
  }
  let vmOrigin: string | undefined;
  if (!env.GATEWAY_EDGE_INTERNAL_URL_TEMPLATE && runtime?.runtime === "gce-vm") {
    const ip = runtime.vm?.internalIp;
    if (runtime.vm?.status !== "RUNNING" || typeof ip !== "string" || !isIPv4(ip)) {
      throw new Error(`Builder VM is not reachable: ${gatewayId}`);
    }
    vmOrigin = `http://${ip}:3001`;
  }
  const base = env.GATEWAY_EDGE_INTERNAL_URL_TEMPLATE
    ? env.GATEWAY_EDGE_INTERNAL_URL_TEMPLATE.replace("{gatewayId}", gatewayId)
    : vmOrigin ?? `http://gateway-edge-${gatewayId}.${env.K8S_NAMESPACE ?? "octogee"}.svc.cluster.local:3001`;
  return `${trimTrailingSlash(base)}/api/g/${encodeURIComponent(gatewayId)}/internal/model-credential-sync`;
}

async function platformModelDialsForSync(logWarn: (msg: string) => void): Promise<{
  freeTierModelRef: string;
  builderAgentDefault: BuilderAgentModelDefault;
}> {
  try {
    const snap = await db
      .collection(PLATFORM_CONFIG_COLLECTION)
      .doc(PLATFORM_MODEL_CONFIG_DOC)
      .get();
    const data = snap.data() as { freeTierModelRef?: unknown } | undefined;
    const configured = data?.freeTierModelRef;
    return {
      freeTierModelRef: typeof configured === "string" && resolveFreeTierModel(configured)
        ? configured
        : DEFAULT_FREE_TIER_MODEL_REF,
      builderAgentDefault: builderAgentModelDefaultFromDoc(data),
    };
  } catch (err) {
    logWarn(
      `platform model dial read failed for model credential sync — sending the compiled defaults: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return {
      freeTierModelRef: DEFAULT_FREE_TIER_MODEL_REF,
      builderAgentDefault: builderAgentModelDefaultFromDoc(undefined),
    };
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
  if (!isSafeGatewayId(args.gatewayId)) throw new Error(`invalid gatewayId ${JSON.stringify(args.gatewayId)}`);
  const [dials, runtime] = await Promise.all([
    platformModelDialsForSync(logWarn),
    env.GATEWAY_EDGE_INTERNAL_URL_TEMPLATE
      ? undefined
      : db.collection("glmGateways").doc(args.gatewayId).get().then((snapshot) => snapshot.data()),
  ]);
  const userData: ModelCredentialSyncUserData = {
    ...dials,
    ...args.userData,
  };
  const body = JSON.stringify(userData);
  const authHeaders = signingSecret.trim()
    ? createModelCredentialSyncAuthHeaders({ body: userData, secret: signingSecret })
    : {};
  const res = await internalFetch(
    gatewayModelCredentialSyncUrl(args.gatewayId, env, runtime),
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
