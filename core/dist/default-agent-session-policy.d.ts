export declare function fingerprintDefaultAgentRuntimePolicy(config: unknown, agentId: string): string;
export declare function reconcileDefaultAgentRuntimeSessionPolicy(input: {
    agentDir: string;
    fingerprint: string;
    resetSessions: () => Promise<number>;
}): Promise<{
    refreshed: boolean;
    resetCount: number;
}>;
