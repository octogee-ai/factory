import { resolveGatewayControlIdentity, } from "./glm.js";
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
export const OPENCLAW_TRUSTED_PROXIES = ["127.0.0.1", "::1"];
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
];
export const OPENCLAW_DEVICE_AUTO_APPROVE_SCOPES = [
    OPERATOR_READ,
    OPERATOR_WRITE,
    OPERATOR_APPROVALS,
    OPERATOR_QUESTIONS,
];
export const OPENCLAW_TRUSTED_PROXY_AUTH = Object.freeze({
    mode: "trusted-proxy",
    trustedProxy: Object.freeze({
        userHeader: OPENCLAW_PROXY_USER_HEADER,
        requiredHeaders: [OPENCLAW_PROXY_ATTESTATION_HEADER],
        allowLoopback: true,
        deviceAutoApprove: Object.freeze({
            enabled: true,
            scopes: [...OPENCLAW_DEVICE_AUTO_APPROVE_SCOPES],
        }),
    }),
});
export function openClawIdentityScopes(ownerUid) {
    const owner = ownerUid?.trim();
    return {
        [OPENCLAW_EDGE_SERVICE_IDENTITY]: [...OPENCLAW_FULL_OPERATOR_SCOPES],
        [OPENCLAW_PROVISIONER_SERVICE_IDENTITY]: [...OPENCLAW_FULL_OPERATOR_SCOPES],
        ...(owner ? { [owner]: [...OPENCLAW_FULL_OPERATOR_SCOPES] } : {}),
    };
}
export const OPENCLAW_OPERATOR_ROLE_NAMES = [
    "member",
    "service",
    "owner",
    "co-owner",
    "trusted-helper",
    "viewer",
];
export const OPENCLAW_OPERATOR_ROLES = Object.freeze({
    default: "member",
    definitions: Object.freeze({
        member: { sessions: { others: "none" }, agents: "*", scopes: [...OPENCLAW_FULL_OPERATOR_SCOPES] },
        service: { sessions: { others: "write" }, agents: "*", scopes: [...OPENCLAW_FULL_OPERATOR_SCOPES] },
        owner: { sessions: { others: "write" }, agents: "*", scopes: [...OPENCLAW_FULL_OPERATOR_SCOPES] },
        "co-owner": {
            sessions: { others: "write" },
            agents: "*",
            scopes: [OPERATOR_READ, OPERATOR_WRITE, OPERATOR_APPROVALS, OPERATOR_QUESTIONS],
        },
        "trusted-helper": {
            sessions: { others: "view" },
            agents: "*",
            scopes: [OPERATOR_READ, OPERATOR_WRITE, OPERATOR_APPROVALS],
        },
        viewer: { sessions: { others: "view" }, agents: "*", scopes: [OPERATOR_READ] },
    }),
});
export function openClawRoleScopes(role) {
    return [...OPENCLAW_OPERATOR_ROLES.definitions[role].scopes];
}
export function openClawDeviceRequestScopes(role) {
    const approvable = new Set(OPENCLAW_DEVICE_AUTO_APPROVE_SCOPES);
    return openClawRoleScopes(role).filter((scope) => approvable.has(scope));
}
const ROLE_BY_BROKER_PROFILE = {
    "native-owner": "owner",
    "native-co-owner": "co-owner",
    "delegated-config": "trusted-helper",
    "delegated-read": "viewer",
};
export function openClawRoleForBrokerProfile(profile) {
    return ROLE_BY_BROKER_PROFILE[profile];
}
export function resolveControlIdentityFromEnv(env = process.env) {
    return resolveGatewayControlIdentity(env[OPENCLAW_CONTROL_IDENTITY_ENV]?.trim());
}
export function isPerUserControlIdentity(env = process.env) {
    return resolveControlIdentityFromEnv(env) === "per-user";
}
export function resolveOwnerUidFromEnv(env = process.env) {
    const value = env[OPENCLAW_OWNER_UID_ENV]?.trim();
    return value ? value : undefined;
}
export function serviceProxyIdentity(name) {
    const trimmed = name.trim();
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(trimmed)) {
        throw new Error(`invalid service identity name: ${JSON.stringify(name)}`);
    }
    return `${OPENCLAW_SERVICE_IDENTITY_PREFIX}${trimmed}`;
}
export function openClawDeviceSubject(gatewayId, uid) {
    return `octogee-openclaw-device:v1:${gatewayId}:${uid}`;
}
export function openClawProxyIdentityHeaders(identity) {
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
export function isOpenClawProxyIdentityHeader(name) {
    const lower = name.toLowerCase();
    return lower === OPENCLAW_PROXY_USER_HEADER || lower === OPENCLAW_PROXY_ATTESTATION_HEADER;
}
