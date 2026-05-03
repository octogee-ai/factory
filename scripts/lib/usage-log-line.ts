export interface UsageLogFields {
  totalTokens: number;
  costUsd: number;
  role: string;
  model: string;
  uid: string;
  workspaceId: string | null;
}

export function formatUsageLogLine(f: UsageLogFields): string {
  const slug = f.workspaceId ? ` slug:${f.workspaceId}` : "";
  return (
    `✓ usage: ${f.totalTokens} tokens ($${f.costUsd.toFixed(4)}) ` +
    `[${f.role}/${f.model}] uid:${f.uid.slice(0, 8)}${slug}`
  );
}
