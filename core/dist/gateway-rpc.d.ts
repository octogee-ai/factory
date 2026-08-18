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
    configRevisionHash: string;
    appliedConfigHash: string | null;
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
export interface SecretsApplyRpcResult {
    mode?: string;
    changed?: boolean;
    changedFiles?: string[];
    warningCount?: number;
}
export interface GatewayRestartRequestResult {
    ok: true;
    status: "scheduled" | "deferred" | "coalesced";
    restart: {
        ok: true;
        pid: number;
        signal: "SIGUSR1";
        coalesced: boolean;
        [extra: string]: unknown;
    };
    [extra: string]: unknown;
}
export interface GatewayChannelOperationParams {
    channel: string;
    accountId: string;
}
export interface GatewayChannelStopResult {
    channel: string;
    accountId: string;
    stopped: true;
    [extra: string]: unknown;
}
export interface GatewayChannelStartResult {
    channel: string;
    accountId: string;
    started: boolean;
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
export interface GatewayToolsCatalogResult {
    agentId: string;
    groups: unknown[];
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
export interface GatewayAgentsDeleteParams {
    agentId: string;
    deleteFiles?: boolean;
}
export interface GatewayAgentsDeleteResult {
    ok: true;
    agentId: string;
    removedBindings?: number;
    removed?: Array<{
        path: string;
        method: "trash" | "missing";
    }>;
    failed?: unknown[];
    [extra: string]: unknown;
}
export interface GatewayAgentsCreateParams {
    name: string;
    workspace: string;
    model?: string;
    emoji?: string;
    avatar?: string;
}
export interface GatewayAgentsCreateResult {
    ok: true;
    agentId: string;
    name?: string;
    workspace?: string;
    [extra: string]: unknown;
}
/**
 * openclaw refuses `agents.create` for an id already in the roster with
 * `errorShape(INVALID_REQUEST, 'agent "<id>" already exists')`. An ensure that
 * raced another writer has to treat that as already-done; every other refusal —
 * an unwritable workspace, a wedged deletion journal, a transport failure —
 * must still fail the mount.
 */
export declare function isAgentAlreadyExistsRpcError(err: unknown): boolean;
/**
 * openclaw refuses `agents.delete` for an id that is neither rostered nor
 * mid-deletion with `errorShape(INVALID_REQUEST, 'agent "<id>" not found')`
 * (server-methods/agents.ts respondAgentNotFound). An eviction has to treat
 * that as already-done; every other refusal — the default agent, a wedged
 * deletion journal, a transport failure — must still fail the eviction.
 */
export declare function isAgentNotFoundRpcError(err: unknown): boolean;
export interface GatewayRpcClient {
    configGet(): Promise<ConfigGetResult>;
    configApply(config: object, baseHash: string): Promise<ConfigPatchResult>;
    configPatch(patch: object, baseHash: string, opts?: {
        replacePaths?: readonly string[];
    }): Promise<ConfigPatchResult>;
    configPatchAndWaitForChange(patch: object, baseHash: string, opts?: {
        replacePaths?: readonly string[];
    }): Promise<ConfigPatchResult>;
    channelsStatus(): Promise<unknown>;
    channelsStatusConnectionGeneration(): number;
    channelsStop(params: GatewayChannelOperationParams): Promise<GatewayChannelStopResult>;
    channelsStart(params: GatewayChannelOperationParams): Promise<GatewayChannelStartResult>;
    secretsReload(): Promise<SecretsReloadResult>;
    secretsApply(params: {
        plan: object;
        dryRun?: boolean;
    }): Promise<SecretsApplyRpcResult>;
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
    toolsCatalog(params: {
        agentId: string;
        includePlugins: true;
    }, timeoutMs?: number): Promise<GatewayToolsCatalogResult>;
    cronAdd(spec: CronAddSpec): Promise<CronAddResult>;
    agentsCreate(params: GatewayAgentsCreateParams): Promise<GatewayAgentsCreateResult>;
    agentsDelete(params: GatewayAgentsDeleteParams): Promise<GatewayAgentsDeleteResult>;
    isGatewayUp(timeoutMs?: number): Promise<boolean>;
    close(): Promise<void>;
}
export declare function createGatewayRpc(opts?: GatewayRpcClientOptions): GatewayRpcClient;
