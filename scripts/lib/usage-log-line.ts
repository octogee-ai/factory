/**
 * `✓ usage: ...` log line formatter — the per-turn attribution record
 * emitted by the gateway provisioner.
 *
 * Pure function so the format is unit-tested. Callers are responsible
 * for passing a fingerprint (not a raw key); see key-fingerprint.ts.
 */
export interface UsageLogFields {
  totalTokens: number;
  costUsd: number;
  role: string;
  model: string;
  uid: string;
  workspaceId: string | null;
  keyFingerprint: string;
}

export function formatUsageLogLine(f: UsageLogFields): string {
  const ws = f.workspaceId ? ` ws:${f.workspaceId}` : "";
  return (
    `\u2713 usage: ${f.totalTokens} tokens ($${f.costUsd.toFixed(4)}) ` +
    `[${f.role}/${f.model}] uid:${f.uid.slice(0, 8)}${ws} key=${f.keyFingerprint}`
  );
}
