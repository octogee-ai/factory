// The gateway's level-triggered reconcile: drive on-disk reality toward the assigned
// set. desired − observed → ensure (mount/restore); observed − desired → unmount (drain).
// Level-triggered is the correctness guarantee — a missed event, roll, or blip self-heals
// on the next tick. See docs/specs/FLEET-RECONCILE-SPEC.md.

export type UnmountOutcome = "drained" | "noop" | "deleted-user";
export type EnsureOutcome = "mounted" | "noop";

export interface ReconcileLoopDeps {
  gatewayId: string;
  /** Mount-observed: slugs whose mount is fully COMPLETE (coach wired AND the .mounted
   *  marker the last ensure-step writes). Drives toMount: a desired slug absent here is
   *  (re-)ensured — including a coach-wired-but-incomplete one, closing the post-config
   *  wedge. */
  getMountObserved: () => string[];
  /** Evict-observed: the pod's honest on-disk presence (coach-wired dirs). Drives toEvict:
   *  present-but-undesired → unmount. Broader than mount-observed so a half-mounted,
   *  unassigned leftover is still drained. */
  getEvictObserved: () => string[];
  /** Desired: slugs this gateway should host (eligible + assigned here). */
  readDesired: () => Promise<string[]>;
  /** Idempotent mount/restore — safe to call every tick until observed catches up. */
  ensureSlug: (slug: string) => Promise<EnsureOutcome>;
  unmountSlug: (slug: string) => Promise<UnmountOutcome>;
  log: (msg: string) => void;
  /** Cap concurrent mounts/evicts so a cold pod doesn't thundering-herd. */
  maxConcurrent?: number;
  /** Best-effort: an ensure threw. For surfacing a bounded gateways/{id}.lastError mirror.
   *  MUST NOT throw — the loop guards it, but it should not rely on that. */
  onEnsureError?: (slug: string, message: string) => void;
  /** Best-effort: an ensure succeeded — clear any prior lastError for this slug. */
  onEnsureSuccess?: (slug: string) => void;
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

function fireSafely(deps: ReconcileLoopDeps, fn: (() => void) | undefined): void {
  if (!fn) return;
  try {
    fn();
  } catch (err) {
    deps.log(`[reconcile] ${deps.gatewayId}: ⚠ outcome hook threw (ignored): ${errMessage(err)}`);
  }
}

export async function reconcileFleet(deps: ReconcileLoopDeps): Promise<void> {
  const mountObserved = new Set(deps.getMountObserved());
  const evictObserved = new Set(deps.getEvictObserved());
  const desired = new Set(await deps.readDesired());

  const toMount = [...desired].filter((s) => !mountObserved.has(s) && !inFlight.has(s));
  const toEvict = [...evictObserved].filter((s) => !desired.has(s) && !inFlight.has(s));

  if (toMount.length === 0 && toEvict.length === 0) return;

  const mountList = toMount.length ? ` (${toMount.join(",")})` : "";
  const evictList = toEvict.length ? ` (${toEvict.join(",")})` : "";
  deps.log(
    `[reconcile] ${deps.gatewayId}: +${toMount.length} mount${mountList} / -${toEvict.length} evict${evictList}`,
  );

  const actions: Array<() => Promise<void>> = [];

  for (const slug of toMount) {
    actions.push(async () => {
      inFlight.add(slug);
      try {
        const outcome = await deps.ensureSlug(slug);
        deps.log(`[reconcile] ${deps.gatewayId}: mounted ${slug} (${outcome})`);
        fireSafely(deps, () => deps.onEnsureSuccess?.(slug));
      } catch (err) {
        const message = errMessage(err);
        deps.log(`[reconcile] ${deps.gatewayId}: ⚠ ensure failed for ${slug}: ${message}`);
        fireSafely(deps, () => deps.onEnsureError?.(slug, message));
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
  let running = false;
  const tick = () => {
    // Non-reentrant: reconcileFleet can outlive intervalMs (a mount may wait on
    // the gateway's config.patch rate limit). Overlapping ticks create independent
    // runBounded schedulers, so maxConcurrent stops being a process-wide cap; for
    // callers that set maxConcurrent=1, that also breaks the serial-mount invariant.
    // Skip; level-triggered, so the next interval after this tick drains catches up.
    if (running) return;
    running = true;
    reconcileFleet(opts)
      .catch((err) => {
        opts.log(`[reconcile] ${opts.gatewayId}: tick failed: ${errMessage(err)}`);
      })
      .finally(() => {
        running = false;
      });
  };
  const timer = setInterval(tick, opts.intervalMs);
  return () => clearInterval(timer);
}
