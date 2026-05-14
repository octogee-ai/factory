import type { Firestore } from "firebase-admin/firestore";
import { GLM_OPERATIONS_COLLECTION, type Operation } from "../../shared/types/glm.js";

/**
 * Periodic sweep that flips orphaned `running` glmOperations docs to
 * `failed` once they've outlived a reasonable execution window.
 *
 * The motivating case (incident 2026-05-13): the controller pod restarted
 * mid-migration and never wrote a terminal status. The op stayed `running`
 * forever — visible in the admin UI, unactionable, unsuited for retry
 * because the underlying state machine had no anchor. Today we have ~1
 * such doc in TEST from the gw-test → gw-canary migration that never
 * completed.
 *
 * The reaper is intentionally simple: any `running` op older than
 * `stalenessMs` (default 15 min, well past `ADD_CUSTOMER_DEADLINE_MS` +
 * generous slack) gets marked `failed` with a reaper-tagged error. No
 * attempt to roll back state — that's the next live operator's call.
 * The point is to clear the dashboard so the operator can SEE the situation.
 *
 * Multi-replica caveat: today glm-controller runs `replicas: 1`. If we
 * ever scale out, two reapers can both flip the same stuck op (idempotent
 * → harmless) AND can also race a still-live pod's terminal write — the
 * stale-vs-fresh contest is "last writer wins" without a precondition.
 * Adding a `where("startedBy", "!=", thisPodId)` filter (or a Firestore
 * txn that re-checks the staleness anchor inside the update) closes the
 * race when we scale. Same caveat as the per-target migration cap in
 * `migrate-customer.ts`.
 */

export interface StuckOpReaperDeps {
  db: Firestore;
  log: (msg: string) => void;
  now: () => number;
  /** Min age of a `running` op before it's reaped. */
  stalenessMs: number;
}

export interface StuckOpReaperResult {
  scanned: number;
  reaped: number;
}

function readMillis(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (v instanceof Date) return v.getTime();
  if (v != null && typeof (v as { toMillis?: () => number }).toMillis === "function") {
    return (v as { toMillis: () => number }).toMillis();
  }
  return null;
}

export async function runStuckOpReaperTick(
  deps: StuckOpReaperDeps,
): Promise<StuckOpReaperResult> {
  const snap = await deps.db
    .collection(GLM_OPERATIONS_COLLECTION)
    .where("status", "==", "running")
    .get();
  const now = deps.now();

  type StuckRow = { doc: (typeof snap.docs)[number]; data: Operation; ageMin: number };
  const stuck: StuckRow[] = [];
  for (const doc of snap.docs) {
    const data = doc.data() as Operation | undefined;
    if (!data) continue;
    // startedAt is set in the claim transaction; fall back to createdAt
    // for the (rare) doc written before the transaction landed but never
    // claimed properly.
    const anchorMs = readMillis(data.startedAt) ?? readMillis(data.createdAt);
    if (anchorMs == null) continue;
    if (now - anchorMs < deps.stalenessMs) continue;
    stuck.push({ doc, data, ageMin: Math.round((now - anchorMs) / 60_000) });
  }

  // Parallel reaps with allSettled so one Firestore failure doesn't abort
  // the rest of the sweep. If a tick ever finds many stuck ops at once
  // (e.g. after a long controller outage), we want all of them flipped,
  // not just the ones before the first error.
  const budgetMin = Math.round(deps.stalenessMs / 60_000);
  const results = await Promise.allSettled(
    stuck.map(async ({ doc, data, ageMin }) => {
      deps.log(
        `[stuck-op-reaper] ⚠ ${doc.id} (kind=${data.kind ?? "?"}) running for ${ageMin}m — marking failed`,
      );
      try {
        await doc.ref.update({
          status: "failed",
          completedAt: now,
          error: `reaped: op exceeded ${budgetMin}m running budget — controller likely restarted mid-op or the work hung past the inner deadlines`,
        });
      } catch (err) {
        deps.log(`[stuck-op-reaper] ⚠ ${doc.id} update failed: ${String(err)}`);
        throw err;
      }
    }),
  );
  const reaped = results.filter((r) => r.status === "fulfilled").length;
  return { scanned: snap.docs.length, reaped };
}

export interface StartStuckOpReaperDeps extends StuckOpReaperDeps {
  /** How often to fire a tick. Recommend 60s in prod. */
  intervalMs: number;
  /** Test seam — defaults to runStuckOpReaperTick. */
  runTick?: (deps: StuckOpReaperDeps) => Promise<StuckOpReaperResult>;
}

export function startStuckOpReaper(deps: StartStuckOpReaperDeps): () => void {
  const tick = deps.runTick ?? runStuckOpReaperTick;
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    (async () => {
      try {
        await tick(deps);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        deps.log(`[stuck-op-reaper] ⚠ tick failed — ${message}`);
      }
    })();
  }, deps.intervalMs);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
