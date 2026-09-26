import {
  resolveGatewayControlIdentity,
  type GatewayControlIdentity,
} from "./glm.js";

export const OPENCLAW_CONTROL_IDENTITY_ENV = "OPENCLAW_CONTROL_IDENTITY";
export const OPENCLAW_OWNER_UID_ENV = "GATEWAY_OWNER_UID";

export const OPENCLAW_PROXY_USER_HEADER = "x-octogee-user";
export const OPENCLAW_PROXY_ATTESTATION_HEADER = "x-octogee-proxy";
export const OPENCLAW_PROXY_ATTESTATION_VALUE = "1";

export const OPENCLAW_CONTROL_UI_CLIENT_ID = "openclaw-control-ui";
export const OPENCLAW_CONTROL_UI_CLIENT_MODE = "ui";

export const OPENCLAW_SERVICE_IDENTITY_PREFIX = "svc:";
export const OPENCLAW_EDGE_SERVICE_IDENTITY = `${OPENCLAW_SERVICE_IDENTITY_PREFIX}gateway-edge`;
export const OPENCLAW_PROVISIONER_SERVICE_IDENTITY = `${OPENCLAW_SERVICE_IDENTITY_PREFIX}octogee-provisioner`;

export const OPENCLAW_TRUSTED_PROXIES = ["127.0.0.1", "::1"] as const;

const OPERATOR_ADMIN = "operator.admin";
const OPERATOR_READ = "operator.read";
const OPERATOR_WRITE = "operator.write";
const OPERATOR_APPROVALS = "operator.approvals";
const OPERATOR_QUESTIONS = "operator.questions";
const OPERATOR_PAIRING = "operator.pairing";

export const OPENCLAW_FULL_OPERATOR_SCOPES = [
  OPERATOR_ADMIN,
  OPERATOR_READ,
  OPERATOR_WRITE,
  OPERATOR_APPROVALS,
  OPERATOR_QUESTIONS,
  OPERATOR_PAIRING,
] as const;

export const OPENCLAW_TRUSTED_PROXY_AUTH = Object.freeze({
  mode: "trusted-proxy",
  trustedProxy: Object.freeze({
    userHeader: OPENCLAW_PROXY_USER_HEADER,
    requiredHeaders: [OPENCLAW_PROXY_ATTESTATION_HEADER],
    allowLoopback: true,
    deviceAutoApprove: Object.freeze({
      enabled: true,
      scopes: [...OPENCLAW_FULL_OPERATOR_SCOPES],
    }),
  }),
});

export function openClawIdentityScopes(ownerUid?: string | null): Record<string, string[]> {
  const owner = ownerUid?.trim();
  return {
    [OPENCLAW_EDGE_SERVICE_IDENTITY]: [...OPENCLAW_FULL_OPERATOR_SCOPES],
    [OPENCLAW_PROVISIONER_SERVICE_IDENTITY]: [...OPENCLAW_FULL_OPERATOR_SCOPES],
    ...(owner ? { [owner]: [...OPENCLAW_FULL_OPERATOR_SCOPES] } : {}),
  };
}

export const OPENCLAW_OPERATOR_ROLE_NAMES = ["member", "admin", "service"] as const;
export type OpenClawOperatorRole = (typeof OPENCLAW_OPERATOR_ROLE_NAMES)[number];

export const OPENCLAW_OPERATOR_ROLES = Object.freeze({
  default: "member",
  definitions: Object.freeze({
    member: { sessions: { others: "none" }, agents: [] as string[], scopes: [OPERATOR_READ, OPERATOR_WRITE, OPERATOR_QUESTIONS] },
    admin: { sessions: { others: "write" }, agents: "*", scopes: [...OPENCLAW_FULL_OPERATOR_SCOPES] },
    service: { sessions: { others: "write" }, agents: "*", scopes: [...OPENCLAW_FULL_OPERATOR_SCOPES] },
  }),
});

export function openClawOperatorRoles(workspaceSlug?: string): typeof OPENCLAW_OPERATOR_ROLES {
  const roles = structuredClone(OPENCLAW_OPERATOR_ROLES);
  if (workspaceSlug) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(workspaceSlug)) throw new Error("invalid gateway workspace slug");
    roles.definitions.member.agents = [`octogee-${workspaceSlug}-coach`];
  }
  return roles;
}

export function withOpenClawOperatorRoles(roles: unknown, workspaceSlug?: string): Record<string, unknown> {
  const canonical = openClawOperatorRoles(workspaceSlug);
  if (!isPlainRecord(roles)) return canonical;
  const definitions = isPlainRecord(roles.definitions) ? roles.definitions : {};
  return { ...roles, definitions: { ...definitions, ...canonical.definitions } };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function openClawRoleScopes(role: OpenClawOperatorRole): string[] {
  return [...OPENCLAW_OPERATOR_ROLES.definitions[role].scopes];
}

export function resolveControlIdentityFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): GatewayControlIdentity {
  return resolveGatewayControlIdentity(env[OPENCLAW_CONTROL_IDENTITY_ENV]?.trim());
}

export function isPerUserControlIdentity(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveControlIdentityFromEnv(env) === "per-user";
}

export function resolveOwnerUidFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env[OPENCLAW_OWNER_UID_ENV]?.trim();
  return value ? value : undefined;
}

export function serviceProxyIdentity(name: string): string {
  const trimmed = name.trim();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(trimmed)) {
    throw new Error(`invalid service identity name: ${JSON.stringify(name)}`);
  }
  return `${OPENCLAW_SERVICE_IDENTITY_PREFIX}${trimmed}`;
}

export function openClawDeviceSubject(gatewayId: string, uid: string): string {
  return `octogee-openclaw-device:v3:${gatewayId}:${uid}`;
}

export function openClawProxyOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const error = "per-user proxy authentication requires API_PUBLIC_URL to be an HTTP(S) origin";
  let url: URL;
  try {
    url = new URL(env.API_PUBLIC_URL ?? "");
  } catch {
    throw new Error(error);
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password
    || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(error);
  }
  return url.origin;
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
