/**
 * `✓ usage: ...` log line formatter — the per-turn attribution record
 * emitted by the gateway provisioner.
 *
 * Pure function so the format is unit-tested. Traceability is by
 * (uid, workspace slug) — the API key identity is intentionally NOT
 * surfaced here. With BYOT in play the provisioner has no reliable
 * signal for which Anthropic key billed a given turn (OpenClaw doesn't
 * expose it on the JSONL session feed), and the customer's own
 * Anthropic dashboard is the source of truth for that. uid + slug are
 * the right-shape ops handle.
 */
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
