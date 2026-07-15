export type OpenclawWireErrorCode = "connect-failed" | "auth-failed" | "hash-mismatch" | "invalid-patch" | "timeout" | "invalid-response" | "rpc-error";
export declare class OpenclawWireError extends Error {
    readonly code: OpenclawWireErrorCode;
    readonly details?: unknown;
    readonly name = "OpenclawWireError";
    constructor(code: OpenclawWireErrorCode, message: string, details?: unknown);
}
export interface WireSocket {
    on(event: string, listener: (...args: unknown[]) => void): void;
    once(event: string, listener: (...args: unknown[]) => void): void;
    removeListener(event: string, listener: (...args: unknown[]) => void): void;
    send(data: string): void;
    terminate(): void;
}
export interface ResponseFrame {
    type: "res";
    id: string;
    ok: boolean;
    payload?: unknown;
    error?: {
        code: string;
        message: string;
        details?: unknown;
    };
}
export declare function isResponseFrame(v: unknown): v is ResponseFrame;
export declare function waitForWsOpen(ws: WireSocket, timeoutMs: number): Promise<void>;
export declare function startConnectChallengeTracker(ws: WireSocket): {
    wait: (timeoutMs: number) => Promise<string>;
};
export interface SendWsRequestParams {
    ws: WireSocket;
    id: string;
    method: string;
    params: unknown;
    timeoutMs: number;
    mapConnectErrors?: boolean;
}
export declare function sendWsRequest({ ws, id, method, params, timeoutMs, mapConnectErrors, }: SendWsRequestParams): Promise<unknown>;
