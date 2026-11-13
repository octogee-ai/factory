export declare const AUTOMATION_AUTHORIZATION_TIMEOUT_MS = 5000;
export declare const AUTOMATION_OPENCLAW_CONNECT_TIMEOUT_MS = 10000;
export declare const AUTOMATION_OPENCLAW_RPC_TIMEOUT_MS = 10000;
export declare const AUTOMATION_READ_CLIENT_TIMEOUT_MS = 15000;
export declare function hasAutomationReadClientDeadline(method: string): boolean;
export interface HostedAutomationJobCapabilities {
    history: boolean;
}
export interface HostedAutomationsContext {
    agentId: string;
    canManage: false;
    readOnlyReason: string;
    capabilities: {
        runTranscripts: false;
        scratch: false;
    };
}
