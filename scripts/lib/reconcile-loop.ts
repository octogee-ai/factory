// The gateway's level-triggered reconcile: drive on-disk reality toward the assigned
// set. desired − observed → ensure (mount/restore); observed − desired → unmount (drain).
// Level-triggered is the correctness guarantee — a missed event, roll, or blip self-heals
// on the next tick. See docs/specs/FLEET-RECONCILE-SPEC.md.

export type UnmountOutcome = "drained" | "noop" | "deleted-user";
export type EnsureOutcome = "mounted" | "noop";

export interface ReconcileLoopDeps {
  gatewayId: string;
  /** Observed: the pod's honest on-disk mounted set. */
  getObserved: () => string[];
  /** Desired: slugs this gateway should host (eligible + assigned here). */
  readDesired: () => Promise<string[]>;
  /** Idempotent mount/restore — safe to call every tick until observed catches up. */
  ensureSlug: (slug: string) => Promise<EnsureOutcome>;
  unmountSlug: (slug: string) => Promise<UnmountOutcome>;
  log: (msg: string) => void;
  /** Cap concurrent mounts/evicts so a cold pod doesn't thundering-herd. */
  maxConcurrent?: number;
}

const DEFAULT_MAX_CONCURRENT = 4;

// Module-level so overlapping ticks never double-act on a slug. Cleared each action's
// finally, so a slug that failed this tick is retried next tick (never wedged).
const inFlight = new Set<string>();

export function _resetReconcileInFlightForTests(): void {
  inFlight.clear();
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function reconcileFleet(deps: ReconcileLoopDeps): Promise<void> {
  const observed = new Set(deps.getObserved());
  const desired = new Set(await deps.readDesired());

  const toMount = [...desired].filter((s) => !observed.has(s) && !inFlight.has(s));
  const toEvict = [...observed].filter((s) => !desired.has(s) && !inFlight.has(s));

  if (toMount.length === 0 && toEvict.length === 0) return;

  deps.log(
    `[reconcile] ${deps.gatewayId}: +${toMount.length} mount${
      toMount.length ? ` (${toMount.join(",")})` : ""
    } / -${toEvict.length} evict${toEvict.length ? ` (${toEvict.join(",")})` : ""}`,
  );

  const actions: Array<() => Promise<void>> = [];

  for (const slug of toMount) {
    actions.push(async () => {
      inFlight.add(slug);
      try {
        const outcome = await deps.ensureSlug(slug);
        deps.log(`[reconcile] ${deps.gatewayId}: mounted ${slug} (${outcome})`);
      } catch (err) {
        deps.log(`[reconcile] ${deps.gatewayId}: ⚠ ensure failed for ${slug}: ${errMessage(err)}`);
      } finally {
        inFlight.delete(slug);
      }
    });
  }

  for (const slug of toEvict) {
    actions.push(async () => {
      inFlight.add(slug);
      try {
        const outcome = await deps.unmountSlug(slug);
        deps.log(`[reconcile] ${deps.gatewayId}: evicted ${slug} (${outcome})`);
      } catch (err) {
        deps.log(`[reconcile] ${deps.gatewayId}: ⚠ evict failed for ${slug}: ${errMessage(err)}`);
      } finally {
        inFlight.delete(slug);
      }
    });
  }

  await runBounded(actions, deps.maxConcurrent ?? DEFAULT_MAX_CONCURRENT);
}

async function runBounded(actions: Array<() => Promise<void>>, max: number): Promise<void> {
  const limit = Math.max(1, max);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < actions.length) {
      const index = cursor;
      cursor += 1;
      await actions[index]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, actions.length) }, worker));
}

export interface StartReconcileLoopOptions extends ReconcileLoopDeps {
  intervalMs: number;
}

export function startReconcileLoop(opts: StartReconcileLoopOptions): () => void {
  const tick = () => {
    reconcileFleet(opts).catch((err) => {
      opts.log(`[reconcile] ${opts.gatewayId}: tick failed: ${errMessage(err)}`);
    });
  };
  const timer = setInterval(tick, opts.intervalMs);
  return () => clearInterval(timer);
}
