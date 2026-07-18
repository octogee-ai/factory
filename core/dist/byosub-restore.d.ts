export type ByosubProvider = "openai" | "anthropic";
export interface ByosubRestorePlanItem {
    agentId: string;
    provider: ByosubProvider;
    secretName: string;
    targetPath?: string;
    openclawDir: string;
}
export declare function agentIdsFromConfig(config: unknown): string[];
export declare function isSafeAgentId(agentId: string): boolean;
export declare function codexHomeDir(openclawDir: string, agentId: string): string;
export declare function codexAuthJsonPath(openclawDir: string, agentId: string): string;
export declare function claudeCliNativeCredentialsPath(homeDir: string): string;
export declare function codexStagingHomeDir(openclawDir: string, agentId: string): string;
export declare function codexStagingAuthJsonPath(openclawDir: string, agentId: string): string;
export declare function codexAgentDir(openclawDir: string, agentId: string): string;
export declare function codexAuthStatePath(openclawDir: string, agentId: string): string;
/**
 * Reads the codex auth-state payload as text — preferring the SQLite
 * auth_profile_state row (openclaw v2026.6.5+) and falling back to the
 * legacy auth-state.json file when the SQLite row is absent. Returns null
 * when neither source has data.
 *
 * Single source for both the restore decision (byosub-restore) and the
 * gateway-side health sweep (codex-auth-health-io). Keeps the text-in /
 * health-out contract of `deriveCodexAuthHealth` unchanged.
 */
export declare function readCodexAuthStateText(openclawDir: string, agentId: string): string | null;
export declare function shouldRestoreCodexCredential(opts: {
    usableCodexProfilePresent: boolean;
    authStateText: string | null;
    profileId: string;
    now: number;
    targetPathPresent?: boolean;
}): "write" | "skip" | "materialize";
export declare function restoreByosubCredentials(opts: {
    plan: ByosubRestorePlanItem[];
    fetchSecret: (secretName: string) => Promise<string>;
    logFn?: (m: string) => void;
    claudeCliNativeHomeDir?: string;
}): Promise<{
    restored: number;
    failed: number;
    skipped: number;
}>;
