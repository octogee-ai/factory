import type { Firestore } from "firebase-admin/firestore";
import {
  GATEWAY_RELEASES_SUBCOLLECTION,
  isGatewayDesiredDoc,
} from "@octogee/shared/types/gateway-releases";

export type BoundTenant =
  | { kind: "gateway"; gatewayId: string; ownerUid?: string }
  | { kind: "platform"; actor: "glm-controller" | "octogee-api" | "cron" };
type PlatformActor = Extract<BoundTenant, { kind: "platform" }>["actor"];

export type TenantBindingResult =
  | "ok"
  | "ok_legacy_operator"
  | "ok_platform"
  | "shared_gateway"
  | "ns_mismatch"
  | "unknown_tenant"
  | "malformed_sa"
  | "unknown_sa";

export type SaToTenantResult =
  | {
      attached: true;
      tenant: BoundTenant;
      result: "ok" | "ok_legacy_operator" | "ok_platform";
    }
  | {
      attached: false;
      result: Exclude<
        TenantBindingResult,
        "ok" | "ok_legacy_operator" | "ok_platform"
      >;
    };

export interface ServiceAccountIdentity {
  namespace: string;
  saName: string;
}

const GATEWAY_SA_PREFIX = "octogee-gw-";
const LEGACY_OPERATOR_GATEWAY_SA_PREFIX = "octogee-gateway-";
const SHARED_GATEWAY_SA_NAME = "octogee-gateway";

function isDnsLabel(value: string): boolean {
  if (value.length < 1 || value.length > 63) return false;
  if (value.startsWith("-") || value.endsWith("-")) return false;
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    const isDigit = code >= 48 && code <= 57;
    const isLower = code >= 97 && code <= 122;
    if (!isDigit && !isLower && ch !== "-") return false;
  }
  return true;
}

function gatewayIdFromSaSuffix(suffix: string): string | null {
  if (!isDnsLabel(suffix)) return null;
  return suffix;
}

function platformActorFromSa(saName: string): PlatformActor | null {
  if (saName === "octogee-glm-controller") return "glm-controller";
  if (saName === "octogee-api") return "octogee-api";
  if (saName === "octogee-cron") return "cron";
  return null;
}

function attachGateway(
  gatewayId: string,
  ownerUid: string | null,
  result: "ok" | "ok_legacy_operator",
): SaToTenantResult {
  return {
    attached: true,
    result,
    tenant: {
      kind: "gateway",
      gatewayId,
      ...(ownerUid ? { ownerUid } : {}),
    },
  };
}

// New model: ownerUid lives on the live release payload, not the gateway doc.
// Resolve from liveRelease (the currently serving release) and fall back to
// desiredRelease when the gateway has not converged onto a live release yet.
async function ownerUidFromLiveRelease(
  db: Pick<Firestore, "collection">,
  gatewayId: string,
  desired: { liveRelease?: number | null; desiredRelease: number },
): Promise<string | null> {
  const release =
    typeof desired.liveRelease === "number" ? desired.liveRelease : desired.desiredRelease;
  if (typeof release !== "number") return null;
  const relSnap = await db
    .collection("gateways")
    .doc(gatewayId)
    .collection(GATEWAY_RELEASES_SUBCOLLECTION)
    .doc(String(release))
    .get();
  const payload = relSnap.data()?.payload as Record<string, unknown> | undefined;
  const ownerUid = payload?.ownerUid;
  return typeof ownerUid === "string" && ownerUid ? ownerUid : null;
}

// Tenant identity split (GATEWAY-RELEASES-SPEC): the gateway-scoped KSA maps to
// the NEW gateways/{gatewayId} durable desired doc when present, else the legacy
// glmGateways/{gatewayId} desired doc. Dual-read keeps the switch
// behavior-preserving during expand — a gateway that only exists in glmGateways
// (pre-backfill) still resolves under the same bare id. The bare id is
// unchanged, so broker authorization (fleet-broker.ts) is untouched.
async function bindGatewaySa(
  db: Pick<Firestore, "collection">,
  suffix: string,
  result: "ok" | "ok_legacy_operator",
): Promise<SaToTenantResult> {
  const gatewayId = gatewayIdFromSaSuffix(suffix);
  if (!gatewayId) return { attached: false, result: "malformed_sa" };

  const desiredSnap = await db.collection("gateways").doc(gatewayId).get();
  const desired = desiredSnap.exists ? desiredSnap.data() : undefined;
  if (isGatewayDesiredDoc(desired)) {
    if (desired.desiredStatus === "retired") {
      return { attached: false, result: "unknown_tenant" };
    }
    const ownerUid = await ownerUidFromLiveRelease(db, gatewayId, desired);
    return attachGateway(gatewayId, ownerUid, result);
  }

  const snap = await db.collection("glmGateways").doc(gatewayId).get();
  if (!snap.exists) {
    return { attached: false, result: "unknown_tenant" };
  }
  const data = snap.data();
  if (data?.desiredStatus === "retired") {
    return { attached: false, result: "unknown_tenant" };
  }
  const ownerUid = typeof data?.ownerUid === "string" && data.ownerUid ? data.ownerUid : null;
  return attachGateway(gatewayId, ownerUid, result);
}

export async function mapSaToTenant(
  db: Pick<Firestore, "collection">,
  identity: ServiceAccountIdentity,
  expectedNamespace = process.env.K8S_NAMESPACE ?? "octogee",
): Promise<SaToTenantResult> {
  if (identity.namespace !== expectedNamespace) {
    return { attached: false, result: "ns_mismatch" };
  }

  if (identity.saName === SHARED_GATEWAY_SA_NAME) {
    return { attached: false, result: "shared_gateway" };
  }

  if (identity.saName.startsWith(GATEWAY_SA_PREFIX)) {
    return bindGatewaySa(db, identity.saName.slice(GATEWAY_SA_PREFIX.length), "ok");
  }

  if (identity.saName.startsWith(LEGACY_OPERATOR_GATEWAY_SA_PREFIX)) {
    return bindGatewaySa(
      db,
      identity.saName.slice(LEGACY_OPERATOR_GATEWAY_SA_PREFIX.length),
      "ok_legacy_operator",
    );
  }

  const actor = platformActorFromSa(identity.saName);
  if (actor) {
    return {
      attached: true,
      result: "ok_platform",
      tenant: { kind: "platform", actor },
    };
  }

  return { attached: false, result: "unknown_sa" };
}
