import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  reconcileFleet,
  startReconcileLoop,
  _resetReconcileInFlightForTests,
  type ReconcileLoopDeps,
} from "../lib/reconcile-loop.js";

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

interface Spy extends ReconcileLoopDeps {
  ensured: string[];
  evicted: string[];
  logs: string[];
}

function mkDeps(over: Partial<ReconcileLoopDeps> = {}): Spy {
  const ensured: string[] = [];
  const evicted: string[] = [];
  const logs: string[] = [];
  return {
    gatewayId: "default",
    getMountObserved: () => [],
    getEvictObserved: () => [],
    readDesired: async () => [],
    ensureSlug: async (slug) => {
      ensured.push(slug);
      return "mounted";
    },
    unmountSlug: async (slug) => {
      evicted.push(slug);
      return "drained";
    },
    log: (m) => logs.push(m),
    ensured,
    evicted,
    logs,
    ...over,
  };
}

/** Both observed views agree — the common case where coach-wired == fully-mounted. */
function observed(slugs: string[]): Partial<ReconcileLoopDeps> {
  return { getMountObserved: () => slugs, getEvictObserved: () => slugs };
}

beforeEach(() => _resetReconcileInFlightForTests());

describe("reconcileFleet — bidirectional desired−observed convergence", () => {
  it("mounts desired−observed and evicts observed−desired in one tick", async () => {
    const d = mkDeps({
      ...observed(["b", "c", "d"]),
      readDesired: async () => ["a", "b", "c"],
    });
    await reconcileFleet(d);
    expect(d.ensured).toEqual(["a"]);
    expect(d.evicted).toEqual(["d"]);
  });

  it("is a no-op when observed already equals desired (no mount, no evict)", async () => {
    const d = mkDeps({
      ...observed(["a", "b"]),
      readDesired: async () => ["a", "b"],
    });
    await reconcileFleet(d);
    expect(d.ensured).toEqual([]);
    expect(d.evicted).toEqual([]);
  });

  it("self-heals a desired-but-unmounted slug without any push or kick", async () => {
    // The livefixture repro: assigned (desired) but absent on disk (observed) → mounted.
    const d = mkDeps({
      readDesired: async () => ["livefixture"],
    });
    await reconcileFleet(d);
    expect(d.ensured).toEqual(["livefixture"]);
  });

  it("skips a slug already in flight from a prior overlapping tick (no double-mount)", async () => {
    const started = deferred();
    const release = deferred();
    const d = mkDeps({
      readDesired: async () => ["a"],
      ensureSlug: async (slug) => {
        d.ensured.push(slug);
        started.resolve();
        await release.promise;
        return "mounted";
      },
    });
    const first = reconcileFleet(d);
    await started.promise; // a is now in flight
    await reconcileFleet(d); // overlapping tick: a in flight → skipped
    expect(d.ensured).toEqual(["a"]); // mounted exactly once
    release.resolve();
    await first;
  });

  it("caps work at maxConcurrent", async () => {
    let active = 0;
    let peak = 0;
    const gates = new Map<string, ReturnType<typeof deferred>>();
    const slugs = ["a", "b", "c", "d", "e"];
    for (const s of slugs) gates.set(s, deferred());
    const d = mkDeps({
      maxConcurrent: 2,
      readDesired: async () => slugs,
      ensureSlug: async (slug) => {
        active++;
        peak = Math.max(peak, active);
        await gates.get(slug)!.promise;
        active--;
        return "mounted";
      },
    });
    const p = reconcileFleet(d);
    await new Promise((r) => setTimeout(r, 10));
    expect(peak).toBeLessThanOrEqual(2);
    for (const g of gates.values()) g.resolve();
    await p;
    expect(d.ensured.length).toBe(0); // ensureSlug overridden; just assert all completed
    expect(peak).toBe(2);
  });

  it("maxConcurrent: 1 runs ensures fully serially — no overlap that could bleed shared adapter state", async () => {
    let active = 0;
    let peak = 0;
    const slugs = ["a", "b", "c"];
    const gates = slugs.map(() => deferred());
    const order: string[] = [];
    const d = mkDeps({
      maxConcurrent: 1,
      readDesired: async () => slugs,
      ensureSlug: async (slug) => {
        active++;
        peak = Math.max(peak, active);
        order.push(slug);
        await gates[slugs.indexOf(slug)].promise;
        active--;
        return "mounted";
      },
    });
    const p = reconcileFleet(d);
    for (let i = 0; i < slugs.length; i++) {
      await new Promise((r) => setTimeout(r, 5));
      expect(peak).toBe(1); // never more than one ensure in flight
      gates[i].resolve();
    }
    await p;
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("a failing ensure is logged and does not block the rest (left for the next tick)", async () => {
    const d = mkDeps({
      readDesired: async () => ["bad", "good"],
      ensureSlug: async (slug) => {
        if (slug === "bad") throw new Error("boom");
        d.ensured.push(slug);
        return "mounted";
      },
    });
    await expect(reconcileFleet(d)).resolves.toBeUndefined(); // does not throw
    expect(d.ensured).toEqual(["good"]);
    expect(d.logs.some((l) => l.includes("bad") && l.includes("boom"))).toBe(true);
  });

  it("clears in-flight after a tick so the next tick re-drives a still-missing slug (retry)", async () => {
    let attempt = 0;
    const d = mkDeps({
      readDesired: async () => ["x"],
      ensureSlug: async (slug) => {
        attempt++;
        if (attempt === 1) throw new Error("transient");
        d.ensured.push(slug);
        return "mounted";
      },
    });
    await reconcileFleet(d); // attempt 1 fails
    await reconcileFleet(d); // attempt 2 succeeds (not wedged in-flight)
    expect(d.ensured).toEqual(["x"]);
    expect(attempt).toBe(2);
  });
});

describe("reconcileFleet — split observed (mount keys off completion, evict off presence)", () => {
  it("re-ensures a wired-but-unmarked desired slug instead of treating it as done", async () => {
    // The post-config wedge: coach is wired on disk (evict-observed) but the mount never
    // completed (no .mounted marker → absent from mount-observed). Still desired, so it
    // belongs in toMount, NOT silently skipped — and must NOT be evicted.
    const d = mkDeps({
      getEvictObserved: () => ["wedged"], // coach-wired on disk
      getMountObserved: () => [], // but not fully mounted (no marker)
      readDesired: async () => ["wedged"],
    });
    await reconcileFleet(d);
    expect(d.ensured).toEqual(["wedged"]);
    expect(d.evicted).toEqual([]);
  });

  it("still evicts an unassigned on-disk customer", async () => {
    const d = mkDeps({
      ...observed(["ghost"]),
      readDesired: async () => [],
    });
    await reconcileFleet(d);
    expect(d.evicted).toEqual(["ghost"]);
    expect(d.ensured).toEqual([]);
  });

  it("never evicts a converging customer (desired, not yet on disk at all)", async () => {
    const d = mkDeps({
      getEvictObserved: () => [],
      getMountObserved: () => [],
      readDesired: async () => ["arriving"],
    });
    await reconcileFleet(d);
    expect(d.evicted).toEqual([]);
    expect(d.ensured).toEqual(["arriving"]);
  });
});

describe("reconcileFleet — ensure outcome surfaced (best-effort lastError mirror)", () => {
  it("reports success to onEnsureSuccess and failure to onEnsureError", async () => {
    const succeeded: string[] = [];
    const failed: Array<{ slug: string; message: string }> = [];
    const d = mkDeps({
      readDesired: async () => ["ok", "bad"],
      ensureSlug: async (slug) => {
        if (slug === "bad") throw new Error("kaboom");
        return "mounted";
      },
      onEnsureSuccess: (slug) => succeeded.push(slug),
      onEnsureError: (slug, message) => failed.push({ slug, message }),
    });
    await reconcileFleet(d);
    expect(succeeded).toEqual(["ok"]);
    expect(failed).toEqual([{ slug: "bad", message: "kaboom" }]);
  });

  it("a throwing outcome hook never crashes the tick", async () => {
    const d = mkDeps({
      readDesired: async () => ["ok", "bad"],
      ensureSlug: async (slug) => {
        if (slug === "bad") throw new Error("kaboom");
        return "mounted";
      },
      onEnsureSuccess: () => {
        throw new Error("hook exploded");
      },
      onEnsureError: () => {
        throw new Error("hook exploded");
      },
    });
    await expect(reconcileFleet(d)).resolves.toBeUndefined();
  });
});

describe("startReconcileLoop", () => {
  it("reconciles on each interval tick and stops cleanly", async () => {
    vi.useFakeTimers();
    try {
      const d = mkDeps({ readDesired: async () => ["a"] });
      const stop = startReconcileLoop({ ...d, intervalMs: 1000 });
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(1000);
      stop();
      await vi.advanceTimersByTimeAsync(1000);
      // ensured "a" on the first tick; second tick it's still observed-empty so re-ensures.
      expect(d.ensured.length).toBeGreaterThanOrEqual(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is non-reentrant: an interval firing while the prior tick's ensure is pending does not start a concurrent ensure", async () => {
    vi.useFakeTimers();
    try {
      const ensured: string[] = [];
      let inEnsure = 0;
      let peak = 0;
      const aGate = deferred();
      const d = mkDeps({
        ...observed([]),
        readDesired: async () => ["a", "b"],
        maxConcurrent: 1,
        ensureSlug: async (slug) => {
          inEnsure += 1;
          peak = Math.max(peak, inEnsure);
          if (slug === "a") await aGate.promise; // hold "a" across the next interval
          inEnsure -= 1;
          ensured.push(slug);
          return "mounted";
        },
      });
      const stop = startReconcileLoop({ ...d, intervalMs: 1000 });

      await vi.advanceTimersByTimeAsync(1000); // tick 1 → ensure("a") starts and hangs
      expect(peak).toBe(1);

      await vi.advanceTimersByTimeAsync(1000); // tick 2 fires while "a" is still pending
      // Without the re-entrancy guard, tick 2 runs reconcileFleet again and starts
      // ensure("b") concurrently (a different slug → the per-slug inFlight guard
      // doesn't stop it), defeating maxConcurrent: 1. With the guard, tick 2 is skipped.
      expect(peak).toBe(1);

      aGate.resolve(); // let "a" finish; tick 1's worker proceeds to "b" serially
      await flushMicrotasks();
      expect(peak).toBe(1);
      expect(ensured).toContain("b");

      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
