import type { Firestore } from "firebase-admin/firestore";
import { GLM_OPERATIONS_COLLECTION, type Operation } from "@octogee/shared/types/glm";
import { operationNeedsDurableCustomerMigrationV2Resume } from "./operation-retry.js";

export interface StuckOpReaperDeps {
  db: Firestore;
  log: (msg: string) => void;
  now: () => number;
  
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
    if (operationNeedsDurableCustomerMigrationV2Resume(data)) continue;

    // Liveness = the most recent of (last step progress, claim, creation). A long or
    // resumed roll that is still stepping keeps lastProgressAt fresh and is NOT reaped;
    // only an op with no progress and no recent (re)claim past the budget is stuck.
    const anchorMs = Math.max(
      readMillis(data.lastProgressAt) ?? 0,
      readMillis(data.startedAt) ?? 0,
      readMillis(data.createdAt) ?? 0,
    );
    if (anchorMs <= 0) continue;
    if (now - anchorMs < deps.stalenessMs) continue;
    stuck.push({ doc, data, ageMin: Math.round((now - anchorMs) / 60_000) });
  }

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
  
  intervalMs: number;
  
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
