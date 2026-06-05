import type { Firestore } from "firebase-admin/firestore";

export type BoundTenant =
  | { kind: "gateway"; gatewayId: string; ownerUid: string }
  | { kind: "platform"; actor: "glm-controller" | "octogee-api" };
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
  return null;
}

async function bindGatewaySa(
  db: Pick<Firestore, "collection">,
  suffix: string,
  result: "ok" | "ok_legacy_operator",
): Promise<SaToTenantResult> {
  const gatewayId = gatewayIdFromSaSuffix(suffix);
  if (!gatewayId) return { attached: false, result: "malformed_sa" };

  const snap = await db.collection("glmGateways").doc(gatewayId).get();
  const data = snap.exists ? snap.data() : undefined;
  const ownerUid = typeof data?.ownerUid === "string" ? data.ownerUid : null;
  if (!ownerUid) {
    return { attached: false, result: "unknown_tenant" };
  }
  return {
    attached: true,
    result,
    tenant: { kind: "gateway", gatewayId, ownerUid },
  };
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
