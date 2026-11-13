// One-shot cleanup for the usage-ledger TTL retrofit:
//  - usage_sessions + usage_summary are RETIRED (their only reader, the admin
//    usage panel, now sources sessions/summary from the broker event stream) —
//    delete every doc.
//  - usage_models SURVIVES (user + admin telemetry) and now stamps expiresAt
//    on write, but legacy docs written before that have none, so the TTL policy
//    never drains them. Backfill expiresAt from each doc's last use.
//
// Idempotent: re-running deletes nothing new and skips already-stamped models.

export const RETIRED_USAGE_COLLECTIONS = ["usage_sessions", "usage_summary"] as const;
export const USAGE_MODEL_TTL_MS = 180 * 24 * 60 * 60 * 1000;

function timestampMs(value: unknown): number | null {
  if (value && typeof value === "object") {
    const toDate = (value as { toDate?: unknown }).toDate;
    if (typeof toDate === "function") {
      const d = toDate.call(value);
      if (d instanceof Date && Number.isFinite(d.getTime())) return d.getTime();
    }
    const seconds = (value as { _seconds?: unknown; seconds?: unknown })._seconds
      ?? (value as { seconds?: unknown }).seconds;
    if (typeof seconds === "number" && Number.isFinite(seconds)) return seconds * 1000;
  }
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  return null;
}

function dateStringMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(ms) ? ms : null;
}

// The expiresAt to stamp on a legacy usage_models doc — 180d after its last use
// (lastUsedAt, else the doc's `date`, else now). Returns null when the doc
// already carries an expiresAt (idempotent skip).
export function planUsageModelExpiry(
  data: Record<string, unknown>,
  nowMs: number,
  retentionMs: number = USAGE_MODEL_TTL_MS,
): Date | null {
  if (data.expiresAt !== undefined && data.expiresAt !== null) return null;
  const base = timestampMs(data.lastUsedAt) ?? dateStringMs(data.date) ?? nowMs;
  return new Date(base + retentionMs);
}
