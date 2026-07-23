import { type OpenclawWireErrorCode } from "@octogee/shared/types/openclaw-wire-core";
import { type DeviceIdentity } from "./gateway-device-identity.js";
export { OpenclawWireError, type OpenclawWireErrorCode, } from "@octogee/shared/types/openclaw-wire-core";
export interface ConnectTrace {
    url: string;
    stage: "ws-open" | "challenge" | "connect" | "done";
    success: boolean;
    wsOpenMs?: number;
    challengeMs?: number;
    connectMs?: number;
    totalMs: number;
    errorCode?: OpenclawWireErrorCode;
    errorMessage?: string;
}
export interface GatewayRpcClientOptions {
    url?: string;
    token?: string;
    deviceToken?: string;
    openclawConfigPath?: string;
    allowLegacyGatewayTokenFallback?: boolean;
    onConnectTrace?: (trace: ConnectTrace) => void;
    connectTimeoutMs?: number;
    callTimeoutMs?: number;
    identity?: DeviceIdentity;
    scopes?: string[];
}
export interface ConfigGetResult {
    config: unknown;
    hash: string;
}
export interface ConfigPatchResult {
    ok: true;
    noop?: boolean;
    path?: string;
    config?: unknown;
    hash?: string;
}
export interface SecretsReloadResult {
    warningCount?: number;
    ok?: boolean;
}
export interface GatewayRestartRequestResult {
    [extra: string]: unknown;
}
export interface GatewaySessionSummary {
    key: string;
    agentId?: string;
    hasActiveRun?: boolean;
}
export interface GatewaySessionsListResult {
    sessions: GatewaySessionSummary[];
    [extra: string]: unknown;
}
export interface GatewaySessionsResetResult {
    ok: true;
    [extra: string]: unknown;
}
export interface CronAddSpec {
    name: string;
    description?: string;
    enabled: boolean;
    deleteAfterRun?: boolean;
    agentId?: string;
    sessionKey?: string;
    schedule: {
        kind: "at";
        at: string;
    } | {
        kind: "every";
        everyMs: number;
    } | {
        kind: "cron";
        expr: string;
        tz?: string;
    };
    sessionTarget: "main" | "isolated" | "current" | `session:${string}`;
    wakeMode: "now" | "next-heartbeat";
    payload: {
        kind: "systemEvent";
        text: string;
    } | {
        kind: "agentTurn";
        message: string;
        model?: string;
        thinking?: string;
        timeoutSeconds?: number;
        lightContext?: boolean;
        toolsAllow?: string[];
    };
    delivery?: {
        mode: "none" | "announce" | "webhook";
        channel?: string;
        accountId?: string;
        to?: string;
        threadId?: string | number;
        bestEffort?: boolean;
    };
}
export interface CronAddResult {
    id: string;
    [extra: string]: unknown;
}
export interface GatewayRpcClient {
    configGet(): Promise<ConfigGetResult>;
    configApply(config: object, baseHash: string): Promise<ConfigPatchResult>;
    configPatch(patch: object, baseHash: string, opts?: {
        replacePaths?: readonly string[];
    }): Promise<ConfigPatchResult>;
    channelsStatus(): Promise<unknown>;
    secretsReload(): Promise<SecretsReloadResult>;
    gatewayRestartRequest(params: {
        reason: string;
        skipDeferral?: boolean;
    }): Promise<GatewayRestartRequestResult>;
    sessionsList(params: {
        agentId: string;
    }): Promise<GatewaySessionsListResult>;
    sessionsReset(params: {
        key: string;
        agentId: string;
        reason: "new" | "reset";
    }): Promise<GatewaySessionsResetResult>;
    cronAdd(spec: CronAddSpec): Promise<CronAddResult>;
    isGatewayUp(timeoutMs?: number): Promise<boolean>;
    close(): Promise<void>;
}
export declare function createGatewayRpc(opts?: GatewayRpcClientOptions): GatewayRpcClient;
