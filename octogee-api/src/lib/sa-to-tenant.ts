import type { Firestore } from "firebase-admin/firestore";
import { GATEWAYS_COLLECTION } from "@octogee/shared/types/fleet-controller";
import {
  effectiveGatewayServiceAccountNameForGateway,
  readGatewayAuthorization,
} from "@octogee/core/gateway-live-release";

export type BoundTenant =
  | {
      kind: "gateway";
      gatewayId: string;
      ownerUid?: string;
      podName?: string;
      podUid?: string;
    }
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
type GatewayRootFirestore = Pick<Firestore, "doc" | "collection">;

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

async function bindGatewaySa(
  db: GatewayRootFirestore,
  saName: string,
  suffix: string,
  result: "ok" | "ok_legacy_operator",
): Promise<SaToTenantResult> {
  const gatewayId = gatewayIdFromSaSuffix(suffix);
  if (!gatewayId) return { attached: false, result: "malformed_sa" };

  const authorization = await readGatewayAuthorization(db, gatewayId);
  if (!authorization || authorization.gateway.desiredStatus === "retired") {
    return { attached: false, result: "unknown_tenant" };
  }
  if (
    effectiveGatewayServiceAccountNameForGateway(authorization.config, gatewayId) !== saName
  ) {
    return { attached: false, result: "unknown_tenant" };
  }
  return attachGateway(gatewayId, authorization.config.ownerUid, result);
}

async function bindCustomGatewaySa(
  db: GatewayRootFirestore,
  saName: string,
): Promise<SaToTenantResult> {
  const roots = await db
    .collection(GATEWAYS_COLLECTION)
    .where("serviceAccountName", "==", saName)
    .get();
  if (roots.docs.length !== 1) return { attached: false, result: "unknown_tenant" };
  const root = roots.docs[0];
  const authorization = await readGatewayAuthorization(db, root.id);
  if (!authorization || authorization.gateway.desiredStatus === "retired") {
    return { attached: false, result: "unknown_tenant" };
  }
  if (
    effectiveGatewayServiceAccountNameForGateway(
      authorization.config,
      authorization.gateway.gatewayId,
    ) !== saName
  ) {
    return { attached: false, result: "unknown_tenant" };
  }
  return attachGateway(
    authorization.gateway.gatewayId,
    authorization.config.ownerUid,
    "ok",
  );
}

export async function mapSaToTenant(
  db: GatewayRootFirestore,
  identity: ServiceAccountIdentity,
  expectedNamespace = process.env.K8S_NAMESPACE ?? "octogee",
): Promise<SaToTenantResult> {
  if (identity.namespace !== expectedNamespace) {
    return { attached: false, result: "ns_mismatch" };
  }

  if (identity.saName === SHARED_GATEWAY_SA_NAME) {
    return { attached: false, result: "shared_gateway" };
  }

  const actor = platformActorFromSa(identity.saName);
  if (actor) {
    return {
      attached: true,
      result: "ok_platform",
      tenant: { kind: "platform", actor },
    };
  }

  if (identity.saName.startsWith(GATEWAY_SA_PREFIX)) {
    return bindGatewaySa(
      db,
      identity.saName,
      identity.saName.slice(GATEWAY_SA_PREFIX.length),
      "ok",
    );
  }

  if (identity.saName.startsWith(LEGACY_OPERATOR_GATEWAY_SA_PREFIX)) {
    return bindGatewaySa(
      db,
      identity.saName,
      identity.saName.slice(LEGACY_OPERATOR_GATEWAY_SA_PREFIX.length),
      "ok_legacy_operator",
    );
  }

  if (!isDnsLabel(identity.saName)) return { attached: false, result: "unknown_sa" };
  return bindCustomGatewaySa(db, identity.saName);
}
