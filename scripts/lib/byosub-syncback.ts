import * as fs from "fs";
import { createHash } from "crypto";

export interface AuthFingerprint {
  sha256: string;
  size: number;
}

/**
 * Content fingerprint of a credential file, or null if absent/unreadable.
 * Pure-ish (read-only I/O, never throws) — codex rewrites auth.json in
 * place on token rotation; sha256 is the authoritative change signal
 * (mtime is only a cheap poll trigger in the watcher loop).
 */
export function fingerprintFile(filePath: string): AuthFingerprint | null {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- per-agent codex-home path from SAFE_AGENT_ID-guarded plan
    const buf = fs.readFileSync(filePath);
    return {
      sha256: createHash("sha256").update(buf).digest("hex"),
      size: buf.length,
    };
  } catch {
    return null;
  }
}

/**
 * Pure decision: did the credential change in a way we should sync back?
 * - absent current   → never (don't push a deletion as a rotation)
 * - no prior         → changed (first observation; capture the baseline)
 * - sha differs      → changed (codex rotated the token in place)
 * - otherwise        → unchanged (no churn on every poll)
 * Debounce/timing is the watcher loop's concern, not this decision.
 */
export function decideSyncBack(
  prev: AuthFingerprint | null,
  cur: AuthFingerprint | null,
): { changed: boolean; reason: string } {
  if (!cur) return { changed: false, reason: "credential file absent" };
  if (!prev) return { changed: true, reason: "first observation" };
  if (prev.sha256 !== cur.sha256) {
    return { changed: true, reason: "content changed (token rotated)" };
  }
  return { changed: false, reason: "unchanged" };
}

export interface SyncBackTarget {
  agentId: string;
  authPath: string;
}

export interface SyncBackResult {
  pushed: number;
  observed: number;
  failed: number;
  prev: Map<string, AuthFingerprint | null>;
}

/**
 * One sweep over the watched per-agent credential files. `observe` logs a
 * change fingerprint and never reads/pushes the secret (the rotation-data
 * collector + zero-risk first ship). `active` reads the rotated payload and
 * hands it to the injected `pushCredential` (gateway-edge-mediated per R2 —
 * the gateway SA stays read-only). Per-item isolation: a push failure counts
 * + does NOT advance `prev` (retried next sweep) and never throws. Returns
 * the advanced `prev` map (caller threads it forward); the input map is not
 * mutated.
 */
export async function syncBackSweep(opts: {
  targets: SyncBackTarget[];
  prev: Map<string, AuthFingerprint | null>;
  mode: "observe" | "active";
  pushCredential?: (agentId: string, payload: string) => Promise<void>;
  logFn?: (m: string) => void;
}): Promise<SyncBackResult> {
  const log = opts.logFn ?? (() => {});
  const prev = new Map(opts.prev);
  let pushed = 0;
  let observed = 0;
  let failed = 0;
  for (const t of opts.targets) {
    const cur = fingerprintFile(t.authPath);
    const d = decideSyncBack(prev.get(t.agentId) ?? null, cur);
    if (!d.changed || !cur) continue;
    if (opts.mode === "observe") {
      observed++;
      prev.set(t.agentId, cur);
      log(
        `byosub-syncback[observe]: ${t.agentId} ${d.reason} sha=${cur.sha256.slice(0, 12)} size=${cur.size}`,
      );
      continue;
    }
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- per-agent codex-home path from the SAFE_AGENT_ID-guarded plan
      const payload = fs.readFileSync(t.authPath, "utf-8");
      if (opts.pushCredential) await opts.pushCredential(t.agentId, payload);
      pushed++;
      prev.set(t.agentId, cur); // advance only on success → failures retry
      log(`byosub-syncback[active]: pushed ${t.agentId} (${d.reason})`);
    } catch (e) {
      failed++;
      log(
        `byosub-syncback[active]: WARN push failed for ${t.agentId} — ${(e as Error).message}`,
      );
    }
  }
  return { pushed, observed, failed, prev };
}
