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
  canReconcile?: () => Promise<boolean>;
  /** Content-stale: mount-observed slugs whose APPLIED config no longer matches their
   *  desired snapshot (e.g. a project-agent toggle changed the snapshot after the mount
   *  completed). Membership is unchanged, so the desired−observed set-difference would
   *  skip them; folding them back into toMount is what makes the reconcile converge
   *  CONTENT, not just the mounted set. Optional — a caller without a fingerprint source
   *  reverts to pure membership convergence. */
  getContentStale?: () => string[];
  /** Idempotent mount/restore — safe to call every tick until observed catches up. */
  ensureSlug: (
    slug: string,
    evictionBatch: readonly string[],
    currentEvictionBatch: () => readonly string[],
  ) => Promise<EnsureOutcome>;
  shouldEnsureSlug?: (slug: string) => boolean;
  shouldDeferRemainingMounts?: (error: unknown) => boolean;
  unmountSlug: (slug: string, evictionBatch: readonly string[]) => Promise<UnmountOutcome>;
  onPendingEvictionCancelled?: (slug: string) => void;
  log: (msg: string) => void;
  /** Cap concurrent mounts/evicts so a cold pod doesn't thundering-herd. */
  maxConcurrent?: number;
  /** Best-effort: an ensure threw. For surfacing a bounded gateways/{id}.lastError mirror.
   *  MUST NOT throw — the loop guards it, but it should not rely on that. */
  onEnsureError?: (slug: string, message: string, error: unknown) => void;
  /** Best-effort: an ensure succeeded — clear any prior lastError for this slug. */
  onEnsureSuccess?: (slug: string) => void;
}

const DEFAULT_MAX_CONCURRENT = 4;

// Module-level so overlapping ticks never double-act on a slug. Cleared each action's
// finally, so a slug that failed this tick is retried next tick (never wedged).
const inFlight = new Set<string>();
const pendingEvictions = new Set<string>();
const queuedEvictions = new Set<string>();
const evictionQueue: Array<{ slug: string; deps: ReconcileLoopDeps }> = [];
let evictionWorker: Promise<void> | null = null;

export function _resetReconcileInFlightForTests(): void {
  inFlight.clear();
  pendingEvictions.clear();
  queuedEvictions.clear();
  evictionQueue.length = 0;
  evictionWorker = null;
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

interface ReconcileSnapshot {
  mountObserved: Set<string>;
  evictObserved: Set<string>;
  desired: Set<string>;
  contentStale: Set<string>;
}

interface ReconcilePlan {
  toMount: string[];
  toEvict: string[];
  currentPendingEvictions: () => string[];
}

async function readReconcileSnapshot(deps: ReconcileLoopDeps): Promise<ReconcileSnapshot | null> {
  if (!(await reconciliationAllowed(deps))) return null;
  const snapshot = {
    mountObserved: new Set(deps.getMountObserved()),
    evictObserved: new Set(deps.getEvictObserved()),
    desired: new Set(await deps.readDesired()),
    contentStale: new Set(deps.getContentStale?.() ?? []),
  };
  return (await reconciliationAllowed(deps)) ? snapshot : null;
}

function planReconciliation(deps: ReconcileLoopDeps, snapshot: ReconcileSnapshot): ReconcilePlan | null {
  const { mountObserved, evictObserved, desired, contentStale } = snapshot;
  for (const slug of [...pendingEvictions]) {
    if (desired.has(slug)) {
      pendingEvictions.delete(slug);
      deps.onPendingEvictionCancelled?.(slug);
    }
  }
  const evictionCandidates = [...evictObserved].filter((slug) => !desired.has(slug));
  for (const slug of evictionCandidates) pendingEvictions.add(slug);
  const toMount = [...desired].filter(
    (slug) =>
      (!mountObserved.has(slug) || contentStale.has(slug)) &&
      !inFlight.has(slug) &&
      (deps.shouldEnsureSlug?.(slug) ?? true),
  );
  const toEvict = evictionCandidates.filter((slug) => !queuedEvictions.has(slug));
  if (toMount.length === 0 && toEvict.length === 0) return null;
  return { toMount, toEvict, currentPendingEvictions: () => [...pendingEvictions] };
}

function logReconcilePlan(deps: ReconcileLoopDeps, plan: ReconcilePlan): void {
  const mountList = plan.toMount.length ? ` (${plan.toMount.join(",")})` : "";
  const evictList = plan.toEvict.length ? ` (${plan.toEvict.join(",")})` : "";
  deps.log(
    `[reconcile] ${deps.gatewayId}: +${plan.toMount.length} mount${mountList} / -${plan.toEvict.length} evict${evictList}`,
  );
}

async function runReconcileMounts(deps: ReconcileLoopDeps, plan: ReconcilePlan): Promise<void> {
  const mounts: Array<() => Promise<void>> = [];
  let deferRemainingMounts = false;
  for (const slug of plan.toMount) {
    mounts.push(async () => {
      if (deferRemainingMounts || !(await reconciliationAllowed(deps))) return;
      inFlight.add(slug);
      try {
        const outcome = await deps.ensureSlug(
          slug,
          plan.currentPendingEvictions(),
          plan.currentPendingEvictions,
        );
        deps.log(`[reconcile] ${deps.gatewayId}: mounted ${slug} (${outcome})`);
        fireSafely(deps, () => deps.onEnsureSuccess?.(slug));
      } catch (err) {
        const message = errMessage(err);
        deps.log(`[reconcile] ${deps.gatewayId}: ⚠ ensure failed for ${slug}: ${message}`);
        if (deps.shouldDeferRemainingMounts?.(err)) {
          deferRemainingMounts = true;
          deps.log(`[reconcile] ${deps.gatewayId}: deferring remaining mounts after permanent ensure failure`);
        }
        fireSafely(deps, () => deps.onEnsureError?.(slug, message, err));
      } finally {
        inFlight.delete(slug);
      }
    });
  }
  await runBounded(
    mounts,
    deps.shouldDeferRemainingMounts ? 1 : (deps.maxConcurrent ?? DEFAULT_MAX_CONCURRENT),
  );
}

async function enqueueReconcileEvictions(deps: ReconcileLoopDeps, toEvict: readonly string[]): Promise<void> {
  if (!(await reconciliationAllowed(deps))) return;
  for (const slug of toEvict) {
    queuedEvictions.add(slug);
    evictionQueue.push({ slug, deps });
  }
  startEvictionWorker();
}

export async function reconcileFleet(deps: ReconcileLoopDeps): Promise<void> {
  const snapshot = await readReconcileSnapshot(deps);
  if (!snapshot) return;
  const plan = planReconciliation(deps, snapshot);
  if (!plan) return;
  logReconcilePlan(deps, plan);
  await runReconcileMounts(deps, plan);
  await enqueueReconcileEvictions(deps, plan.toEvict);
}

function startEvictionWorker(): void {
  if (evictionWorker || evictionQueue.length === 0) return;
  evictionWorker = runEvictionQueue().finally(() => {
    evictionWorker = null;
    startEvictionWorker();
  });
}

async function runEvictionQueue(): Promise<void> {
  while (evictionQueue.length > 0) {
    const job = evictionQueue.shift()!;
    const { slug, deps } = job;
    if (!pendingEvictions.has(slug)) {
      queuedEvictions.delete(slug);
      continue;
    }
    if (!(await reconciliationAllowed(deps))) {
      queuedEvictions.delete(slug);
      continue;
    }
    inFlight.add(slug);
    try {
      const outcome = await deps.unmountSlug(slug, [...pendingEvictions]);
      pendingEvictions.delete(slug);
      deps.log(`[reconcile] ${deps.gatewayId}: evicted ${slug} (${outcome})`);
    } catch (err) {
      deps.log(`[reconcile] ${deps.gatewayId}: ⚠ evict failed for ${slug}: ${errMessage(err)}`);
    } finally {
      inFlight.delete(slug);
      queuedEvictions.delete(slug);
    }
  }
}

async function reconciliationAllowed(deps: ReconcileLoopDeps): Promise<boolean> {
  return deps.canReconcile ? await deps.canReconcile() : true;
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
  subscribe?: (wake: () => void) => () => void;
}

export function startReconcileLoop(opts: StartReconcileLoopOptions): () => void {
  let running = false;
  let stopped = false;
  let pending = false;
  const tick = () => {
    // Non-reentrant: reconcileFleet can outlive intervalMs (a mount may wait on
    // the gateway's config.patch rate limit). Overlapping ticks create independent
    // runBounded schedulers, so maxConcurrent stops being a process-wide cap; for
    // callers that set maxConcurrent=1, that also breaks the serial-mount invariant.
    // Skip; level-triggered, so the next interval after this tick drains catches up.
    if (stopped || running) return;
    pending = false;
    running = true;
    reconcileFleet(opts)
      .catch((err) => {
        opts.log(`[reconcile] ${opts.gatewayId}: tick failed: ${errMessage(err)}`);
      })
      .finally(() => {
        running = false;
        if (pending) tick();
      });
  };
  const timer = setInterval(tick, opts.intervalMs);
  const unsubscribe = opts.subscribe?.(() => { pending = true; tick(); });
  return () => {
    stopped = true;
    clearInterval(timer);
    unsubscribe?.();
  };
}
