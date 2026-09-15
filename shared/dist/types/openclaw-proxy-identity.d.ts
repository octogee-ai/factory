import { type GatewayControlIdentity } from "./glm.js";
export declare const OPENCLAW_CONTROL_IDENTITY_ENV = "OPENCLAW_CONTROL_IDENTITY";
export declare const OPENCLAW_OWNER_UID_ENV = "GATEWAY_OWNER_UID";
export declare const OPENCLAW_PROXY_USER_HEADER = "x-octogee-user";
export declare const OPENCLAW_PROXY_ATTESTATION_HEADER = "x-octogee-proxy";
export declare const OPENCLAW_PROXY_ATTESTATION_VALUE = "1";
export declare const OPENCLAW_CONTROL_UI_CLIENT_ID = "openclaw-control-ui";
export declare const OPENCLAW_CONTROL_UI_CLIENT_MODE = "ui";
export declare const OPENCLAW_SERVICE_IDENTITY_PREFIX = "svc:";
export declare const OPENCLAW_EDGE_SERVICE_IDENTITY = "svc:gateway-edge";
export declare const OPENCLAW_PROVISIONER_SERVICE_IDENTITY = "svc:octogee-provisioner";
export declare const OPENCLAW_TRUSTED_PROXIES: readonly ["127.0.0.1", "::1"];
export declare const OPENCLAW_FULL_OPERATOR_SCOPES: readonly ["operator.admin", "operator.read", "operator.write", "operator.approvals", "operator.questions", "operator.pairing"];
export declare const OPENCLAW_TRUSTED_PROXY_AUTH: Readonly<{
    mode: "trusted-proxy";
    trustedProxy: Readonly<{
        userHeader: "x-octogee-user";
        requiredHeaders: string[];
        allowLoopback: true;
        deviceAutoApprove: Readonly<{
            enabled: true;
            scopes: ("operator.admin" | "operator.approvals" | "operator.pairing" | "operator.questions" | "operator.read" | "operator.write")[];
        }>;
    }>;
}>;
export declare function openClawIdentityScopes(ownerUid?: string | null): Record<string, string[]>;
export declare const OPENCLAW_OPERATOR_ROLE_NAMES: readonly ["member", "admin", "service"];
export type OpenClawOperatorRole = (typeof OPENCLAW_OPERATOR_ROLE_NAMES)[number];
export declare const OPENCLAW_OPERATOR_ROLES: Readonly<{
    default: "member";
    definitions: Readonly<{
        member: {
            sessions: {
                others: string;
            };
            agents: string[];
            scopes: string[];
        };
        admin: {
            sessions: {
                others: string;
            };
            agents: string;
            scopes: ("operator.admin" | "operator.approvals" | "operator.pairing" | "operator.questions" | "operator.read" | "operator.write")[];
        };
        service: {
            sessions: {
                others: string;
            };
            agents: string;
            scopes: ("operator.admin" | "operator.approvals" | "operator.pairing" | "operator.questions" | "operator.read" | "operator.write")[];
        };
    }>;
}>;
export declare function openClawOperatorRoles(workspaceSlug?: string): typeof OPENCLAW_OPERATOR_ROLES;
export declare function openClawRoleScopes(role: OpenClawOperatorRole): string[];
export declare function resolveControlIdentityFromEnv(env?: NodeJS.ProcessEnv): GatewayControlIdentity;
export declare function isPerUserControlIdentity(env?: NodeJS.ProcessEnv): boolean;
export declare function resolveOwnerUidFromEnv(env?: NodeJS.ProcessEnv): string | undefined;
export declare function serviceProxyIdentity(name: string): string;
export declare function openClawDeviceSubject(gatewayId: string, uid: string): string;
export declare function openClawProxyOrigin(env?: NodeJS.ProcessEnv): string;
export interface OpenClawProxyIdentity {
    user: string;
    clientAddress?: string;
    forwardedProto?: string;
    forwardedHost?: string;
}
export declare function openClawProxyIdentityHeaders(identity: OpenClawProxyIdentity): Record<string, string>;
export declare function isOpenClawProxyIdentityHeader(name: string): boolean;
