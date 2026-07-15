export declare const K8S_SA_TOKEN_HEADER = "x-k8s-sa-token";
export declare const DEFAULT_PROJECTED_API_TOKEN_PATH = "/var/run/secrets/octogee-api/token";
export interface InternalFetchOptions {
    internalServiceKey?: string;
    tokenPath?: string;
    fetchImpl?: typeof fetch;
}
export declare function internalFetch(url: string | URL, init?: RequestInit, opts?: InternalFetchOptions): Promise<Response>;
