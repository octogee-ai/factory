export interface SweepStuckReleasesDeps {
  // gatewayIds whose helm release is currently in a pending-* state.
  listPending: () => Promise<string[]>;
  // Recover one stuck release (rollback-to-last-good / uninstall-stuck-first-install).
  recover: (gatewayId: string) => Promise<string>;
  now: () => number;
  // A release must be CONTINUOUSLY pending for this long before we recover it.
  // Set comfortably > the helm `--wait` upgrade timeout so a legitimately
  // in-progress install/upgrade is never mistaken for a wedge.
  staleMs: number;
  log: (msg: string) => void;
}

export interface SweepStuckReleasesResult {
  pending: number;
  recovered: number;
}

// Heal orphaned helm wedges: a release left `pending-*` by an interrupted
// install/upgrade (e.g. the controller redeployed mid-`helm upgrade`) that no
// operation ever re-upserts — so the upsert pre-flight recovery never fires and it
// silently blocks rolls. `firstSeenPending` survives across ticks (held by
// startHelmRecoverySweeper) so a release must be pending for `staleMs` *continuously*
// before we touch it. The map is in-memory, so a controller restart resets the clock
// — intentionally: it makes the sweeper wait for stability rather than fight a
// deploy storm mid-burst.
export async function sweepStuckReleasesOnce(
  deps: SweepStuckReleasesDeps,
  firstSeenPending: Map<string, number>,
): Promise<SweepStuckReleasesResult> {
  let pending: string[];
  try {
    pending = await deps.listPending();
  } catch (err) {
    deps.log(
      `[helm-recovery-sweeper] ⚠ listPending failed — ${err instanceof Error ? err.message : String(err)}`,
    );
    return { pending: 0, recovered: 0 };
  }

  const pendingSet = new Set(pending);
  // Releases that recovered/settled on their own: drop them so their clock resets.
  for (const gw of [...firstSeenPending.keys()]) {
    if (!pendingSet.has(gw)) firstSeenPending.delete(gw);
  }

  const now = deps.now();
  let recovered = 0;
  for (const gw of pending) {
    const firstSeen = firstSeenPending.get(gw);
    if (firstSeen === undefined) {
      firstSeenPending.set(gw, now); // first sighting — start the staleness clock
      continue;
    }
    if (now - firstSeen < deps.staleMs) continue; // pending, but not long enough yet

    deps.log(
      `[helm-recovery-sweeper] ${gw} stuck pending for ${Math.round((now - firstSeen) / 60_000)}m (no op re-upserting it) — recovering`,
    );
    try {
      const action = await deps.recover(gw);
      deps.log(`[helm-recovery-sweeper] ✅ recovered ${gw}: ${action}`);
      recovered += 1;
      firstSeenPending.delete(gw);
    } catch (err) {
      deps.log(
        `[helm-recovery-sweeper] ⚠ recover ${gw} failed — ${err instanceof Error ? err.message : String(err)} (retrying after staleMs)`,
      );
      firstSeenPending.set(gw, now); // back off a full staleMs before the next attempt
    }
  }
  return { pending: pending.length, recovered };
}

export interface StartHelmRecoverySweeperDeps extends SweepStuckReleasesDeps {
  intervalMs: number;
  runTick?: (
    deps: SweepStuckReleasesDeps,
    state: Map<string, number>,
  ) => Promise<SweepStuckReleasesResult>;
}

export function startHelmRecoverySweeper(deps: StartHelmRecoverySweeperDeps): () => void {
  const tick = deps.runTick ?? sweepStuckReleasesOnce;
  const firstSeenPending = new Map<string, number>();
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    (async () => {
      try {
        await tick(deps, firstSeenPending);
      } catch (err) {
        deps.log(
          `[helm-recovery-sweeper] ⚠ tick failed — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    })();
  }, deps.intervalMs);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
