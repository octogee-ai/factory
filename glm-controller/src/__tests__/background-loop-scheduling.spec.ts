import { afterEach, describe, expect, it, vi } from "vitest";
import { startGatewayHeartbeatPoller } from "../gateway-heartbeat-poller.js";
import { startOrphanHeartbeatReaper } from "../orphan-heartbeat-reaper.js";
import { startStuckOpReaper } from "../stuck-op-reaper.js";
import { startNativeReturnHoldReaper } from "../native-return-hold-reaper.js";
import { startGiteaGatewayKeyGc } from "../gitea-gateway-key-gc.js";

type Start = (work: () => Promise<void>, log: (message: string) => void) => () => void;
const loops: Array<[string, Start]> = [
  ["gateway heartbeat", (work, log) => startGatewayHeartbeatPoller({
    listGatewayIds: async () => { await work(); return []; },
    fetchFleetState: vi.fn(), readAssignedSlugs: vi.fn(), writeHeartbeat: vi.fn(), log,
  }, 100)],
  ["orphan heartbeat reaper", (work, log) => startOrphanHeartbeatReaper({
    db: {} as Parameters<typeof startOrphanHeartbeatReaper>[0]["db"],
    now: Date.now, stalenessMs: 1000, intervalMs: 100, log,
    runTick: async () => { await work(); return { scanned: 0, deleted: 0 }; },
  })],
  ["stuck operation reaper", (work, log) => startStuckOpReaper({
    db: {} as Parameters<typeof startStuckOpReaper>[0]["db"],
    now: Date.now, stalenessMs: 1000, intervalMs: 100, log,
    runTick: async () => { await work(); return { scanned: 0, reaped: 0 }; },
  })],
  ["native return hold reaper", (work, log) => startNativeReturnHoldReaper({
    db: {} as Parameters<typeof startNativeReturnHoldReaper>[0]["db"],
    informer: { glmGateways: () => null },
    now: Date.now, intervalMs: 100, log,
    runTick: async () => { await work(); return { scanned: 0, released: 0 }; },
  })],
  ["gitea gateway key gc", (work, log) => startGiteaGatewayKeyGc({
    gitea: { listUsernames: vi.fn(), listUserKeys: vi.fn(), deleteUserKey: vi.fn() },
    readLiveKeyHolders: vi.fn(),
    mode: "enforce", legacyMode: "dry-run", maxCallsPerTick: 1, minCallIntervalMs: 0, graceMs: 0,
    now: Date.now, sleep: async () => {}, intervalMs: 100, log,
    runTick: async () => { await work(); return { users: [], passCompleted: true, calls: 0 }; },
  })],
];

afterEach(() => vi.useRealTimers());

describe.each(loops)("%s scheduling", (_name, start) => {
  it.each([false, true])("skips overlapping ticks and resumes after rejection=%s", async (reject) => {
    vi.useFakeTimers();
    let settle!: () => void;
    const held = new Promise<void>((resolve, fail) => {
      settle = reject ? () => fail(new Error("slow request failed")) : resolve;
    });
    const work = vi.fn(async () => {}).mockImplementationOnce(() => held);
    const log = vi.fn();
    const stop = start(work, log);
    try {
      await vi.advanceTimersByTimeAsync(500);
      expect(work).toHaveBeenCalledTimes(1);
      settle();
      await vi.advanceTimersByTimeAsync(100);
      expect(work).toHaveBeenCalledTimes(2);
      if (reject) expect(log).toHaveBeenCalledWith(expect.stringContaining("slow request failed"));
      stop();
      await vi.advanceTimersByTimeAsync(500);
      expect(work).toHaveBeenCalledTimes(2);
    } finally {
      settle();
      stop();
    }
  });
});
