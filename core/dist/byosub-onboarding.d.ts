export type FlowState = {
    phase: "awaiting_user";
    url: string;
    code: string;
    expiresAt: number;
} | {
    phase: "capturing";
} | {
    phase: "connected";
} | {
    phase: "expired";
} | {
    phase: "failed";
    reason: string;
};
export type FlowEvent = {
    type: "childExit";
    code: number;
    authPresent: boolean;
} | {
    type: "tick";
    now: number;
} | {
    type: "captureResult";
    ok: boolean;
    reason?: string;
};
export declare function coachAgentId(slug: string): string;
export declare function startFlow(p: {
    url: string;
    code: string;
    expiresAt: number;
}): FlowState;
export declare function nextFlowState(state: FlowState, event: FlowEvent): FlowState;
