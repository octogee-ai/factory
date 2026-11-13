export declare const K8S_SA_TOKEN_HEADER = "x-k8s-sa-token";
export declare const DEFAULT_PROJECTED_API_TOKEN_PATH = "/var/run/secrets/octogee-api/token";
export declare const GATEWAY_CREDENTIAL_TOKEN_HEADER = "x-octogee-gateway-credential-token";
export declare const GATEWAY_CREDENTIAL_TOKEN_AUDIENCE = "octogee-api-gateway-credentials";
export declare const DEFAULT_GATEWAY_CREDENTIAL_TOKEN_PATH = "/var/run/secrets/octogee-gateway-credentials/token";
export declare const SIDECAR_BROKER_TOKEN_HEADER = "x-octogee-sidecar-broker-token";
export declare const SIDECAR_BROKER_TOKEN_AUDIENCE = "octogee-api-sidecar-broker";
export declare const DEFAULT_SIDECAR_BROKER_TOKEN_PATH = "/var/run/secrets/octogee-sidecar-broker/token";
export declare const DEFAULT_INTERNAL_FETCH_TIMEOUT_MS = 60000;
export interface InternalFetchOptions {
    internalServiceKey?: string;
    tokenPath?: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    timeoutSignal?: (timeoutMs: number) => AbortSignal;
    requireProjectedToken?: boolean;
}
export declare function gatewayCredentialHeaders(tokenPath?: string): Promise<Record<string, string>>;
export declare function sidecarBrokerHeaders(tokenPath?: string): Promise<Record<string, string>>;
export declare function internalFetch(url: string | URL, init?: RequestInit, opts?: InternalFetchOptions): Promise<Response>;
