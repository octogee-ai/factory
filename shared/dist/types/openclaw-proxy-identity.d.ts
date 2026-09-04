import { type GatewayControlIdentity } from "./glm.js";
export declare const OPENCLAW_CONTROL_IDENTITY_ENV = "OPENCLAW_CONTROL_IDENTITY";
export declare const OPENCLAW_PROXY_USER_HEADER = "x-octogee-user";
export declare const OPENCLAW_PROXY_ATTESTATION_HEADER = "x-octogee-proxy";
export declare const OPENCLAW_PROXY_ATTESTATION_VALUE = "1";
export declare const OPENCLAW_CONTROL_UI_CLIENT_ID = "openclaw-control-ui";
export declare const OPENCLAW_CONTROL_UI_CLIENT_MODE = "ui";
export declare const OPENCLAW_SERVICE_IDENTITY_PREFIX = "svc:";
export declare const OPENCLAW_EDGE_SERVICE_IDENTITY = "svc:gateway-edge";
export declare const OPENCLAW_TRUSTED_PROXIES: readonly ["127.0.0.1", "::1"];
export declare const OPENCLAW_TRUSTED_PROXY_AUTH: Readonly<{
    mode: "trusted-proxy";
    trustedProxy: Readonly<{
        userHeader: "x-octogee-user";
        requiredHeaders: string[];
        allowLoopback: true;
    }>;
}>;
export declare const OPENCLAW_OPERATOR_ROLE_NAMES: readonly ["service", "owner", "co-owner", "trusted-helper", "viewer", "guest"];
export type OpenClawOperatorRole = (typeof OPENCLAW_OPERATOR_ROLE_NAMES)[number];
export declare const OPENCLAW_OPERATOR_ROLES: Readonly<{
    default: "guest";
    definitions: Readonly<{
        service: {
            sessions: {
                others: string;
            };
            agents: string;
            scopes: ("operator.admin" | "operator.approvals" | "operator.pairing" | "operator.questions" | "operator.read" | "operator.write")[];
        };
        owner: {
            sessions: {
                others: string;
            };
            agents: string;
            scopes: ("operator.admin" | "operator.approvals" | "operator.pairing" | "operator.questions" | "operator.read" | "operator.write")[];
        };
        "co-owner": {
            sessions: {
                others: string;
            };
            agents: string;
            scopes: string[];
        };
        "trusted-helper": {
            sessions: {
                others: string;
            };
            agents: string;
            scopes: string[];
        };
        viewer: {
            sessions: {
                others: string;
            };
            agents: string;
            scopes: string[];
        };
        guest: {
            sessions: {
                others: string;
            };
            agents: never[];
            scopes: string[];
            sandbox: string;
        };
    }>;
}>;
export type OpenClawBrokerProfileLike = "native-owner" | "native-co-owner" | "delegated-config" | "delegated-read";
export declare function openClawRoleForBrokerProfile(profile: OpenClawBrokerProfileLike): OpenClawOperatorRole;
export declare function resolveControlIdentityFromEnv(env?: NodeJS.ProcessEnv): GatewayControlIdentity;
export declare function isPerUserControlIdentity(env?: NodeJS.ProcessEnv): boolean;
export declare function serviceProxyIdentity(name: string): string;
export interface OpenClawProxyIdentity {
    user: string;
    clientAddress?: string;
    forwardedProto?: string;
    forwardedHost?: string;
}
export declare function openClawProxyIdentityHeaders(identity: OpenClawProxyIdentity): Record<string, string>;
export declare function isOpenClawProxyIdentityHeader(name: string): boolean;
