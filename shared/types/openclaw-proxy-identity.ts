import {
  resolveGatewayControlIdentity,
  type GatewayControlIdentity,
} from "./glm.js";

export const OPENCLAW_CONTROL_IDENTITY_ENV = "OPENCLAW_CONTROL_IDENTITY";

export const OPENCLAW_PROXY_USER_HEADER = "x-octogee-user";
export const OPENCLAW_PROXY_ATTESTATION_HEADER = "x-octogee-proxy";
export const OPENCLAW_PROXY_ATTESTATION_VALUE = "1";

export const OPENCLAW_CONTROL_UI_CLIENT_ID = "openclaw-control-ui";
export const OPENCLAW_CONTROL_UI_CLIENT_MODE = "ui";

export const OPENCLAW_SERVICE_IDENTITY_PREFIX = "svc:";
export const OPENCLAW_EDGE_SERVICE_IDENTITY = `${OPENCLAW_SERVICE_IDENTITY_PREFIX}gateway-edge`;

export const OPENCLAW_TRUSTED_PROXIES = ["127.0.0.1", "::1"] as const;

export const OPENCLAW_TRUSTED_PROXY_AUTH = Object.freeze({
  mode: "trusted-proxy",
  trustedProxy: Object.freeze({
    userHeader: OPENCLAW_PROXY_USER_HEADER,
    requiredHeaders: [OPENCLAW_PROXY_ATTESTATION_HEADER],
    allowLoopback: true,
  }),
});

export const OPENCLAW_OPERATOR_ROLE_NAMES = [
  "service",
  "owner",
  "co-owner",
  "trusted-helper",
  "viewer",
  "guest",
] as const;
export type OpenClawOperatorRole = (typeof OPENCLAW_OPERATOR_ROLE_NAMES)[number];

const FULL_OPERATOR_SCOPES = [
  "operator.admin",
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.questions",
  "operator.pairing",
] as const;

export const OPENCLAW_OPERATOR_ROLES = Object.freeze({
  default: "guest",
  definitions: Object.freeze({
    service: { sessions: { others: "write" }, agents: "*", scopes: [...FULL_OPERATOR_SCOPES] },
    owner: { sessions: { others: "write" }, agents: "*", scopes: [...FULL_OPERATOR_SCOPES] },
    "co-owner": {
      sessions: { others: "write" },
      agents: "*",
      scopes: ["operator.read", "operator.write", "operator.approvals", "operator.questions"],
    },
    "trusted-helper": {
      sessions: { others: "view" },
      agents: "*",
      scopes: ["operator.read", "operator.write", "operator.approvals"],
    },
    viewer: { sessions: { others: "view" }, agents: "*", scopes: ["operator.read"] },
    guest: { sessions: { others: "none" }, agents: [], scopes: ["operator.read"], sandbox: "required" },
  }),
});

export type OpenClawBrokerProfileLike =
  | "native-owner"
  | "native-co-owner"
  | "delegated-config"
  | "delegated-read";

const ROLE_BY_BROKER_PROFILE: Record<OpenClawBrokerProfileLike, OpenClawOperatorRole> = {
  "native-owner": "owner",
  "native-co-owner": "co-owner",
  "delegated-config": "trusted-helper",
  "delegated-read": "viewer",
};

export function openClawRoleForBrokerProfile(profile: OpenClawBrokerProfileLike): OpenClawOperatorRole {
  return ROLE_BY_BROKER_PROFILE[profile];
}

export function resolveControlIdentityFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): GatewayControlIdentity {
  return resolveGatewayControlIdentity(env[OPENCLAW_CONTROL_IDENTITY_ENV]?.trim());
}

export function isPerUserControlIdentity(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveControlIdentityFromEnv(env) === "per-user";
}

export function serviceProxyIdentity(name: string): string {
  const trimmed = name.trim();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(trimmed)) {
    throw new Error(`invalid service identity name: ${JSON.stringify(name)}`);
  }
  return `${OPENCLAW_SERVICE_IDENTITY_PREFIX}${trimmed}`;
}

export interface OpenClawProxyIdentity {
  user: string;
  clientAddress?: string;
  forwardedProto?: string;
  forwardedHost?: string;
}

export function openClawProxyIdentityHeaders(
  identity: OpenClawProxyIdentity,
): Record<string, string> {
  const user = identity.user.trim();
  if (!user || user.length > 256 || /[\r\n]/u.test(user)) {
    throw new Error("proxy identity user must be a single non-empty header line");
  }
  return {
    [OPENCLAW_PROXY_USER_HEADER]: user,
    [OPENCLAW_PROXY_ATTESTATION_HEADER]: OPENCLAW_PROXY_ATTESTATION_VALUE,
    ...(identity.clientAddress ? { "x-forwarded-for": identity.clientAddress } : {}),
    "x-forwarded-proto": identity.forwardedProto ?? "https",
    ...(identity.forwardedHost ? { "x-forwarded-host": identity.forwardedHost } : {}),
  };
}

export function isOpenClawProxyIdentityHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === OPENCLAW_PROXY_USER_HEADER || lower === OPENCLAW_PROXY_ATTESTATION_HEADER;
}
