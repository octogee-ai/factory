export type CodexAuthHealth = "ok" | "needs_reauth";
export declare function deriveCodexAuthHealth(authStateText: string | null | undefined, profileId: string, now: number): CodexAuthHealth;
export declare function checkCodexAuthHealthForAgents(opts: {
    agentIds: string[];
    profileId: string;
    now: number;
    readAuthState: (agentId: string) => string | null;
    signalNeedsReauth: (agentId: string) => Promise<void>;
    logFn?: (m: string) => void;
}): Promise<{
    checked: number;
    needsReauth: number;
    signalled: number;
}>;
