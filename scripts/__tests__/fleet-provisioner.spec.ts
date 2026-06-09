import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import {
  maybeEvictDepartedLocalCustomers,
  maybeRefreshReportedMounts,
  readMountedCustomersFromAssignedState,
  resolveFleetCapabilities,
} from "../lib/fleet-provisioner.js";
import { _resetInFlightForTests } from "../lib/drain-loop.js";

function mkDb(rows: Array<Record<string, unknown>>): Firestore {
  const docs = rows.map((row) => ({ data: () => row }));
  const query = {
    where: vi.fn(() => query),
    get: vi.fn(async () => ({ docs })),
  };
  return {
    collection: vi.fn(() => query),
  } as unknown as Firestore;
}

describe("readMountedCustomersFromAssignedState", () => {
  it("seeds assigned complete customers only when local state is present and wired", async () => {
    const db = mkDb([
      { provisioning: { openclaw: { slug: "ceckert" } } },
      { provisioning: { openclaw: { slug: "missing-dir" } } },
      { provisioning: { openclaw: { slug: "unwired" } } },
      { provisioning: { openclaw: { slug: "ceckert" } } },
      { username: "fallback" },
    ]);
    const hasCustomerDir = vi.fn((slug: string) => slug !== "missing-dir");
    const customerCoachWiredInOpenclawConfig = vi.fn(
      (slug: string) => slug !== "unwired",
    );

    await expect(
      readMountedCustomersFromAssignedState(db, "gw-bender", {
        hasCustomerDir,
        customerCoachWiredInOpenclawConfig,
      }),
    ).resolves.toEqual(["ceckert", "fallback"]);
  });

  it("falls back to customer-dir presence when the adapter has no config wiring probe", async () => {
    const db = mkDb([
      { provisioning: { openclaw: { slug: "alice" } } },
      { provisioning: { openclaw: { slug: "bob" } } },
    ]);

    await expect(
      readMountedCustomersFromAssignedState(db, "gw-a", {
        hasCustomerDir: (slug) => slug === "bob",
      }),
    ).resolves.toEqual(["bob"]);
  });
});

describe("resolveFleetCapabilities — observability vs provisioning seam", () => {
  it("cattle (platformState + reportState + db): reports AND provisions; drain loop owns honesty, no report-refresh, no local evict", () => {
    expect(
      resolveFleetCapabilities({ platformState: true, reportState: true, hasDb: true }),
    ).toEqual({
      reportMounted: true,
      provision: true,
      refreshReportedMounts: false,
      evictDepartedMounts: false,
      needsStateDeps: true,
    });
  });

  it("operator (platformState=false, reportState=true, db): reports + refreshes + evicts departed footprint (no drain loop), does NOT provision", () => {
    expect(
      resolveFleetCapabilities({ platformState: false, reportState: true, hasDb: true }),
    ).toEqual({
      reportMounted: true,
      provision: false,
      refreshReportedMounts: true,
      evictDepartedMounts: true,
      needsStateDeps: true,
    });
  });

  it("no db (local dev): neither reports nor provisions nor refreshes nor evicts, regardless of flags", () => {
    expect(
      resolveFleetCapabilities({ platformState: true, reportState: true, hasDb: false }),
    ).toEqual({
      reportMounted: false,
      provision: false,
      refreshReportedMounts: false,
      evictDepartedMounts: false,
      needsStateDeps: false,
    });
  });

  it("reportState explicitly off + db: no reporting, no eviction (lets a gateway opt out)", () => {
    expect(
      resolveFleetCapabilities({ platformState: false, reportState: false, hasDb: true }),
    ).toEqual({
      reportMounted: false,
      provision: false,
      refreshReportedMounts: false,
      evictDepartedMounts: false,
      needsStateDeps: false,
    });
  });

  it("the two axes are independent: provision without reporting (no report-refresh, no local evict)", () => {
    expect(
      resolveFleetCapabilities({ platformState: true, reportState: false, hasDb: true }),
    ).toEqual({
      reportMounted: false,
      provision: true,
      refreshReportedMounts: false,
      evictDepartedMounts: false,
      needsStateDeps: true,
    });
  });
});

describe("maybeRefreshReportedMounts — operator gateways keep their reported set honest", () => {
  it("re-derives from assigned state, dropping a customer who moved off this gateway", async () => {
    const db = mkDb([]); // no users assigned to this gateway any more
    const runtime = { mountedCustomers: ["eggman"] };
    await maybeRefreshReportedMounts({
      refresh: true,
      db,
      gatewayId: "mama",
      adapter: { hasCustomerDir: () => true },
      runtime,
      log: () => {},
    });
    expect(runtime.mountedCustomers).toEqual([]);
  });

  it("retains customers still assigned + present on the pod", async () => {
    const db = mkDb([{ provisioning: { openclaw: { slug: "ceckert" } } }]);
    const runtime: { mountedCustomers: string[] } = { mountedCustomers: [] };
    await maybeRefreshReportedMounts({
      refresh: true,
      db,
      gatewayId: "bender",
      adapter: { hasCustomerDir: (slug) => slug === "ceckert" },
      runtime,
      log: () => {},
    });
    expect(runtime.mountedCustomers).toEqual(["ceckert"]);
  });

  it("drops a slug that is assigned + has a dir but whose coach is not wired", async () => {
    const db = mkDb([
      { provisioning: { openclaw: { slug: "ceckert" } } },
      { provisioning: { openclaw: { slug: "halfmounted" } } },
    ]);
    const runtime = { mountedCustomers: ["ceckert", "halfmounted"] };
    await maybeRefreshReportedMounts({
      refresh: true,
      db,
      gatewayId: "bender",
      adapter: {
        hasCustomerDir: () => true,
        customerCoachWiredInOpenclawConfig: (slug) => slug !== "halfmounted",
      },
      runtime,
      log: () => {},
    });
    expect(runtime.mountedCustomers).toEqual(["ceckert"]);
  });

  it("does nothing when refresh is disabled (provisioning gateways keep drain-loop truth)", async () => {
    const db = mkDb([]);
    const runtime = { mountedCustomers: ["alice"] };
    await maybeRefreshReportedMounts({
      refresh: false,
      db,
      gatewayId: "default",
      adapter: { hasCustomerDir: () => true },
      runtime,
      log: () => {},
    });
    expect(runtime.mountedCustomers).toEqual(["alice"]);
  });

  it("does nothing without a db handle", async () => {
    const runtime = { mountedCustomers: ["alice"] };
    await maybeRefreshReportedMounts({
      refresh: true,
      db: undefined,
      gatewayId: "x",
      adapter: { hasCustomerDir: () => true },
      runtime,
      log: () => {},
    });
    expect(runtime.mountedCustomers).toEqual(["alice"]);
  });

  it("keeps the prior set and logs when the assigned-state query throws", async () => {
    const failing: { where: () => unknown; get: () => Promise<unknown> } = {
      where: () => failing,
      get: async () => {
        throw new Error("FAILED_PRECONDITION: missing composite index");
      },
    };
    const db = { collection: () => failing } as unknown as Firestore;
    const runtime = { mountedCustomers: ["ceckert"] };
    const log = vi.fn();
    await maybeRefreshReportedMounts({
      refresh: true,
      db,
      gatewayId: "bender",
      adapter: { hasCustomerDir: () => true },
      runtime,
      log,
    });
    expect(runtime.mountedCustomers).toEqual(["ceckert"]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("refresh failed"));
  });
});

describe("maybeEvictDepartedLocalCustomers — operator gateways tear down departed local footprint", () => {
  beforeEach(() => _resetInFlightForTests());

  type EvictAdapter = {
    removeImportedCustomerBySlug: ReturnType<typeof vi.fn>;
    onUnmounted: ReturnType<typeof vi.fn>;
  };

  function mkAdapter(overrides: Partial<EvictAdapter> = {}): EvictAdapter {
    return {
      removeImportedCustomerBySlug: vi.fn(async () => ({
        wasMounted: true,
        steps: ["config-patch-remove", "delete-dir"],
      })),
      onUnmounted: vi.fn(),
      ...overrides,
    };
  }

  function runEvict(opts: {
    db: Firestore | undefined;
    adapter: EvictAdapter;
    footprint: string[];
    streaks: Map<string, number>;
    evict?: boolean;
    evictAfterStreak?: number;
    log?: (m: string) => void;
  }): Promise<void> {
    return maybeEvictDepartedLocalCustomers({
      evict: opts.evict ?? true,
      db: opts.db,
      gatewayId: "bender",
      adapter: opts.adapter,
      listFootprint: () => opts.footprint,
      orphanStreaks: opts.streaks,
      evictAfterStreak: opts.evictAfterStreak,
      log: opts.log ?? (() => {}),
    });
  }

  it("does NOT evict on the first orphan observation — debounced against a transient blip", async () => {
    const db = mkDb([{ provisioning: { openclaw: { slug: "ceckert" } } }]);
    const adapter = mkAdapter();
    await runEvict({ db, adapter, footprint: ["ceckert", "eggman"], streaks: new Map() });
    expect(adapter.removeImportedCustomerBySlug).not.toHaveBeenCalled();
  });

  it("evicts only after the customer is seen orphaned on consecutive passes (default threshold 2)", async () => {
    const db = mkDb([{ provisioning: { openclaw: { slug: "ceckert" } } }]);
    const adapter = mkAdapter();
    const streaks = new Map<string, number>();
    await runEvict({ db, adapter, footprint: ["ceckert", "eggman"], streaks });
    expect(adapter.removeImportedCustomerBySlug).not.toHaveBeenCalled();
    await runEvict({ db, adapter, footprint: ["ceckert", "eggman"], streaks });
    expect(adapter.removeImportedCustomerBySlug.mock.calls).toEqual([["eggman"]]);
    expect(adapter.onUnmounted).toHaveBeenCalledWith("eggman");
    expect(adapter.onUnmounted).not.toHaveBeenCalledWith("ceckert");
  });

  it("resets the streak when the customer is re-assigned before the threshold (transient absence never evicts)", async () => {
    const adapter = mkAdapter();
    const streaks = new Map<string, number>();
    // Pass 1: eggman absent from assigned (a blip) → streak 1, no evict.
    await runEvict({ db: mkDb([]), adapter, footprint: ["eggman"], streaks });
    expect(streaks.get("eggman")).toBe(1);
    // Pass 2: eggman back in the assigned set → streak cleared, no evict.
    await runEvict({
      db: mkDb([{ provisioning: { openclaw: { slug: "eggman" } } }]),
      adapter,
      footprint: ["eggman"],
      streaks,
    });
    expect(adapter.removeImportedCustomerBySlug).not.toHaveBeenCalled();
    expect(streaks.has("eggman")).toBe(false);
  });

  it("never evicts the pinned owner that stays assigned across many passes", async () => {
    const db = mkDb([{ provisioning: { openclaw: { slug: "ceckert" } } }]);
    const adapter = mkAdapter();
    const streaks = new Map<string, number>();
    await runEvict({ db, adapter, footprint: ["ceckert"], streaks });
    await runEvict({ db, adapter, footprint: ["ceckert"], streaks });
    await runEvict({ db, adapter, footprint: ["ceckert"], streaks });
    expect(adapter.removeImportedCustomerBySlug).not.toHaveBeenCalled();
    expect(adapter.onUnmounted).not.toHaveBeenCalled();
  });

  it("with evictAfterStreak=1, evicts a departed footprint immediately and signals onUnmounted", async () => {
    const db = mkDb([{ provisioning: { openclaw: { slug: "ceckert" } } }]);
    const adapter = mkAdapter();
    await runEvict({
      db,
      adapter,
      footprint: ["ceckert", "eggman"],
      streaks: new Map(),
      evictAfterStreak: 1,
    });
    expect(adapter.removeImportedCustomerBySlug.mock.calls).toEqual([["eggman"]]);
    expect(adapter.onUnmounted).toHaveBeenCalledWith("eggman");
    expect(adapter.onUnmounted).not.toHaveBeenCalledWith("ceckert");
  });

  it("does not signal onUnmounted when the footprint was already gone (wasMounted=false)", async () => {
    const db = mkDb([]);
    const adapter = mkAdapter({
      removeImportedCustomerBySlug: vi.fn(async () => ({ wasMounted: false, steps: [] })),
    });
    await runEvict({ db, adapter, footprint: ["eggman"], streaks: new Map(), evictAfterStreak: 1 });
    expect(adapter.removeImportedCustomerBySlug).toHaveBeenCalledWith("eggman");
    expect(adapter.onUnmounted).not.toHaveBeenCalled();
  });

  it("does nothing when eviction is disabled (provisioning gateways drain via their own loop)", async () => {
    const adapter = mkAdapter();
    await runEvict({
      db: mkDb([]),
      adapter,
      footprint: ["alice"],
      streaks: new Map(),
      evict: false,
      evictAfterStreak: 1,
    });
    expect(adapter.removeImportedCustomerBySlug).not.toHaveBeenCalled();
  });

  it("does nothing without a db handle", async () => {
    const adapter = mkAdapter();
    await runEvict({
      db: undefined,
      adapter,
      footprint: ["alice"],
      streaks: new Map(),
      evictAfterStreak: 1,
    });
    expect(adapter.removeImportedCustomerBySlug).not.toHaveBeenCalled();
  });

  it("evicts NOTHING and does not throw when the assigned-state query fails (no blind eviction on PERMISSION_DENIED)", async () => {
    const failing: { where: () => unknown; get: () => Promise<unknown> } = {
      where: () => failing,
      get: async () => {
        throw new Error("PERMISSION_DENIED: caller lacks users read");
      },
    };
    const db = { collection: () => failing } as unknown as Firestore;
    const adapter = mkAdapter();
    const log = vi.fn();
    await runEvict({ db, adapter, footprint: ["eggman"], streaks: new Map(), evictAfterStreak: 1, log });
    expect(adapter.removeImportedCustomerBySlug).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("evict"));
  });

  it("isolates a per-customer eviction failure — one failing slug does not block the rest", async () => {
    const adapter = mkAdapter({
      removeImportedCustomerBySlug: vi.fn(async (slug: string) => {
        if (slug === "boom") throw new Error("config.patch timed out");
        return { wasMounted: true, steps: ["config-patch-remove", "delete-dir"] };
      }),
    });
    await runEvict({
      db: mkDb([]),
      adapter,
      footprint: ["boom", "eggman"],
      streaks: new Map(),
      evictAfterStreak: 1,
    });
    expect(adapter.removeImportedCustomerBySlug).toHaveBeenCalledWith("eggman");
    expect(adapter.onUnmounted).toHaveBeenCalledWith("eggman");
    expect(adapter.onUnmounted).not.toHaveBeenCalledWith("boom");
  });

  it("does not double-issue a teardown for a slug whose eviction spans two passes (cross-tick in-flight dedup)", async () => {
    let resolveFirst!: () => void;
    const removeImportedCustomerBySlug = vi.fn(
      () =>
        new Promise<{ wasMounted: boolean; steps: string[] }>((resolve) => {
          resolveFirst = () => resolve({ wasMounted: true, steps: ["config-patch-remove", "delete-dir"] });
        }),
    );
    const adapter = mkAdapter({ removeImportedCustomerBySlug });
    const streaks = new Map<string, number>();

    // Pass 1's teardown hangs (still in flight); pass 2 overlaps it on the same slug.
    const first = runEvict({ db: mkDb([]), adapter, footprint: ["eggman"], streaks, evictAfterStreak: 1 });
    const second = runEvict({ db: mkDb([]), adapter, footprint: ["eggman"], streaks, evictAfterStreak: 1 });
    await second;
    expect(removeImportedCustomerBySlug).toHaveBeenCalledTimes(1);

    resolveFirst();
    await first;
    expect(removeImportedCustomerBySlug).toHaveBeenCalledTimes(1);
  });
});
