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

// One process-wide mount pool: a tick enqueues its mounts and waits for them, and a
// later tick's mounts join the same bounded workers instead of waiting for the earlier
// tick to drain. maxConcurrent therefore caps the process, not one tick.
interface MountBatch {
  deferred: boolean;
  plan: ReconcilePlan;
}
interface MountJob {
  slug: string;
  deps: ReconcileLoopDeps;
  batch: MountBatch;
  settle: () => void;
}
const mountQueue: MountJob[] = [];
const queuedMounts = new Set<string>();
let activeMountWorkers = 0;
// Completion clock: a plan whose snapshot predates a slug's last completed mount is
// stale for that slug and must not re-ensure it.
let mountClock = 0;
const lastMountCompletedAt = new Map<string, number>();

export function _resetReconcileInFlightForTests(): void {
  inFlight.clear();
  pendingEvictions.clear();
  queuedEvictions.clear();
  evictionQueue.length = 0;
  evictionWorker = null;
  mountQueue.length = 0;
  queuedMounts.clear();
  activeMountWorkers = 0;
  mountClock = 0;
  lastMountCompletedAt.clear();
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
  clock: number;
}

interface ReconcilePlan {
  toMount: string[];
  toEvict: string[];
  currentPendingEvictions: () => string[];
  snapshotClock: number;
}

async function readReconcileSnapshot(deps: ReconcileLoopDeps): Promise<ReconcileSnapshot | null> {
  if (!(await reconciliationAllowed(deps))) return null;
  const snapshot = {
    clock: mountClock,
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
  return {
    toMount,
    toEvict,
    currentPendingEvictions: () => [...pendingEvictions],
    snapshotClock: snapshot.clock,
  };
}

function logReconcilePlan(deps: ReconcileLoopDeps, plan: ReconcilePlan): void {
  const mountList = plan.toMount.length ? ` (${plan.toMount.join(",")})` : "";
  const evictList = plan.toEvict.length ? ` (${plan.toEvict.join(",")})` : "";
  deps.log(
    `[reconcile] ${deps.gatewayId}: +${plan.toMount.length} mount${mountList} / -${plan.toEvict.length} evict${evictList}`,
  );
}

async function runMountJob({ slug, deps, batch }: MountJob): Promise<void> {
  if (batch.deferred || !(await reconciliationAllowed(deps))) return;
  try {
    const outcome = await deps.ensureSlug(
      slug,
      batch.plan.currentPendingEvictions(),
      batch.plan.currentPendingEvictions,
    );
    mountClock += 1;
    lastMountCompletedAt.set(slug, mountClock);
    deps.log(`[reconcile] ${deps.gatewayId}: mounted ${slug} (${outcome})`);
    fireSafely(deps, () => deps.onEnsureSuccess?.(slug));
  } catch (err) {
    const message = errMessage(err);
    deps.log(`[reconcile] ${deps.gatewayId}: ⚠ ensure failed for ${slug}: ${message}`);
    if (deps.shouldDeferRemainingMounts?.(err)) {
      batch.deferred = true;
      deps.log(`[reconcile] ${deps.gatewayId}: deferring remaining mounts after permanent ensure failure`);
    }
    fireSafely(deps, () => deps.onEnsureError?.(slug, message, err));
  }
}

async function runMountWorker(): Promise<void> {
  activeMountWorkers += 1;
  try {
    while (mountQueue.length > 0) {
      const job = mountQueue.shift()!;
      // Claimed synchronously: a plan computed in the same turn must see the slug
      // as in flight, never as free to mount again.
      queuedMounts.delete(job.slug);
      inFlight.add(job.slug);
      try {
        await runMountJob(job);
      } finally {
        inFlight.delete(job.slug);
        job.settle();
      }
    }
  } finally {
    activeMountWorkers -= 1;
  }
}

function spawnMountWorkers(limit: number): void {
  const wanted = Math.min(Math.max(1, limit) - activeMountWorkers, mountQueue.length);
  for (let i = 0; i < wanted; i++) void runMountWorker();
}

async function runReconcileMounts(deps: ReconcileLoopDeps, plan: ReconcilePlan): Promise<void> {
  const batch: MountBatch = { deferred: false, plan };
  const settled: Promise<void>[] = [];
  // The snapshot was read across awaits; a sibling tick may have queued, claimed,
  // or finished a slug since. The pool decides who mounts what.
  for (const slug of plan.toMount) {
    if (queuedMounts.has(slug) || inFlight.has(slug)) continue;
    if ((lastMountCompletedAt.get(slug) ?? 0) > plan.snapshotClock) continue;
    queuedMounts.add(slug);
    settled.push(new Promise<void>((settle) => {
      mountQueue.push({ slug, deps, batch, settle });
    }));
  }
  spawnMountWorkers(deps.maxConcurrent ?? DEFAULT_MAX_CONCURRENT);
  await Promise.all(settled);
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

export interface StartReconcileLoopOptions extends ReconcileLoopDeps {
  intervalMs: number;
  subscribe?: (wake: () => void) => () => void;
}

// A tick can outlive intervalMs (a mount may wait on the gateway's config.patch),
// so interval ticks never overlap. A push wake is different: the assignment it
// carries would otherwise wait for every in-flight mount to drain, so one wake tick
// may run beside the interval tick. Both feed the process-wide mount pool, which is
// what keeps maxConcurrent (and the maxConcurrent=1 serial invariant) intact.
const MAX_OVERLAPPING_TICKS = 2;

export function startReconcileLoop(opts: StartReconcileLoopOptions): () => void {
  let running = 0;
  let stopped = false;
  let pending = false;
  const tick = (fromWake = false) => {
    if (stopped || running >= (fromWake ? MAX_OVERLAPPING_TICKS : 1)) return;
    pending = false;
    running += 1;
    reconcileFleet(opts)
      .catch((err) => {
        opts.log(`[reconcile] ${opts.gatewayId}: tick failed: ${errMessage(err)}`);
      })
      .finally(() => {
        running -= 1;
        if (pending) tick(true);
      });
  };
  const timer = setInterval(() => tick(), opts.intervalMs);
  const unsubscribe = opts.subscribe?.(() => { pending = true; tick(true); });
  return () => {
    stopped = true;
    clearInterval(timer);
    unsubscribe?.();
  };
}
