export interface UsageLogFields {
    totalTokens: number;
    costUsd: number;
    role: string;
    model: string;
    uid: string;
    workspaceId: string | null;
}
export declare function formatUsageLogLine(f: UsageLogFields): string;
