import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  CLONE_RETRY_DELAYS_MS,
  buildFleetHeartbeatSnapshot,
  cloneRetryDelayMs,
  cloneRetryReady,
  gatewayRevisionServiceName,
  settleConvergence,
  getEvictObservedSlugs,
  getMountObservedSlugs,
  pathGatewayIdMatchesPod,
  readMountedCustomersFromAssignedState,
  resolveFleetCapabilities,
} from "../lib/fleet-provisioner.js";
import type { CustomerLifecycleAdapter } from "../lib/customer-lifecycle.js";
import {
  _resetMigratingInProcessPinsForTests,
  isMigratingInPinned,
  listLocalCustomerDirs,
  writeMigratingInPin,
} from "../lib/local-coach-wired.js";

const tmpDirs: string[] = [];

afterEach(() => _resetMigratingInProcessPinsForTests());
afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

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

describe("settleConvergence — the applied-fingerprint gate", () => {
  const hooks = () => ({
    recordApplied: vi.fn(),
    rememberRetry: vi.fn(),
    forgetRetry: vi.fn(),
  });

  const pending = (slugs: string[]) => ({
    now: 1_000,
    slug: "alice",
    desiredFingerprint: "fp1",
    prior: undefined,
    result: { pendingProjectClones: slugs },
  });

  it("records the fingerprint and drops any backoff once every checkout has landed", () => {
    const h = hooks();
    settleConvergence(
      {
        now: 1_000,
        slug: "alice",
        desiredFingerprint: "fp1",
        prior: { attempts: 3, nextAt: 0, fingerprint: "fp1" },
        result: { pendingProjectClones: [] },
      },
      h,
    );
    expect(h.recordApplied).toHaveBeenCalledWith("alice");
    expect(h.forgetRetry).toHaveBeenCalledWith("alice");
    expect(h.rememberRetry).not.toHaveBeenCalled();
  });

  it("THROWS while a checkout is absent — returning normally would fire the loop's onEnsureSuccess, which clears the very lastError an operator needs to see", () => {
    const h = hooks();
    expect(() => settleConvergence(pending(["camp"]), h)).toThrow(/camp/);
  });

  it("withholds the fingerprint and schedules a backed-off retry while a checkout is absent", () => {
    const h = hooks();
    expect(() => settleConvergence(pending(["camp"]), h)).toThrow();
    expect(h.recordApplied).not.toHaveBeenCalled();
    expect(h.rememberRetry).toHaveBeenCalledWith("alice", {
      attempts: 1,
      nextAt: 1_000 + cloneRetryDelayMs(1),
      fingerprint: "fp1",
    });
  });

  it("lengthens the backoff on repeat and caps it — never abandons, never hot-loops", () => {
    expect(cloneRetryDelayMs(1)).toBeLessThan(cloneRetryDelayMs(2));
    expect(cloneRetryDelayMs(2)).toBeLessThan(cloneRetryDelayMs(3));
    expect(cloneRetryDelayMs(99)).toBe(cloneRetryDelayMs(CLONE_RETRY_DELAYS_MS.length));
  });
});

describe("cloneRetryReady — holds a stranded slug off the hot path between attempts", () => {
  it("is ready when nothing is pending", () => {
    expect(cloneRetryReady(undefined, "fp1", 1_000)).toBe(true);
  });

  it("waits out the backoff, so a wedged checkout cannot re-ensure the customer every 15s", () => {
    const prior = { attempts: 2, nextAt: 5_000, fingerprint: "fp1" };
    expect(cloneRetryReady(prior, "fp1", 4_999)).toBe(false);
    expect(cloneRetryReady(prior, "fp1", 5_000)).toBe(true);
  });

  it("converges IMMEDIATELY on genuine drift — a new project must never wait out a backoff earned by an unrelated stranded one", () => {
    const prior = { attempts: 5, nextAt: 9_000_000, fingerprint: "fp1" };
    expect(cloneRetryReady(prior, "fp2", 1_000)).toBe(true);
  });
});

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

function mkObservedAdapter(over: Partial<CustomerLifecycleAdapter>): CustomerLifecycleAdapter {
  return over as CustomerLifecycleAdapter;
}

describe("observed split — evict keys off raw presence, mount off completion", () => {
  it("evict-observed = RAW on-disk dirs (not coach-wired), so a partial/junk dir is drainable", () => {
    const a = mkObservedAdapter({
      listLocalCustomerDirs: () => ["alice", "bob", "partial"], // partial: dir present, no coach
      listLocalCustomerSlugs: () => ["alice", "bob"], // coach-wired subset
    });
    expect(getEvictObservedSlugs(a)).toEqual(["alice", "bob", "partial"]);
  });

  it("evict-observed skips a migrating-in slug (no draining a fresh import pre-cutover)", () => {
    const a = mkObservedAdapter({
      listLocalCustomerDirs: () => ["alice", "incoming"],
      customerMigratingIn: (s) => s === "incoming",
    });
    expect(getEvictObservedSlugs(a)).toEqual(["alice"]); // incoming guarded from eviction
  });

  it("evict-observed keeps a restored import guarded after the customer dir is replaced", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-mig-pin-"));
    tmpDirs.push(root);
    fs.mkdirSync(path.join(root, "incoming"));
    writeMigratingInPin(root, "incoming");
    fs.rmSync(path.join(root, "incoming"), { recursive: true, force: true });
    fs.mkdirSync(path.join(root, "incoming"));
    const a = mkObservedAdapter({
      listLocalCustomerDirs: () => listLocalCustomerDirs(root),
      customerMigratingIn: (s) => isMigratingInPinned(root, s, 5 * 60_000),
    });

    expect(getEvictObservedSlugs(a)).toEqual([]);
  });

  it("mount-observed excludes a coach-wired-but-unmarked slug (the post-config wedge)", () => {
    const a = mkObservedAdapter({
      listLocalCustomerSlugs: () => ["alice", "bob"], // both coach-wired
      customerMountMarked: (s) => s === "alice", // only alice fully mounted
    });
    expect(getMountObservedSlugs(a)).toEqual(["alice"]); // bob still in toMount
  });

  it("mount-observed counts every coach-wired slug when no marker probe exists", () => {
    const a = mkObservedAdapter({
      listLocalCustomerSlugs: () => ["alice"],
      // no customerMountMarked
    });
    expect(getMountObservedSlugs(a)).toEqual(["alice"]);
  });

  it("mount-observed is PIN-BLIND: a migrated coach-wired+marked slug is observed despite its pin", () => {
    // Regression guard: the migrating-in pin must NOT suppress mount-observed (or the
    // post-cutover target would re-ensure every tick for the pin's TTL). The pin only
    // gates eviction.
    const a = mkObservedAdapter({
      listLocalCustomerSlugs: () => ["migrated"],
      customerMountMarked: () => true,
      customerMigratingIn: () => true,
    });
    expect(getMountObservedSlugs(a)).toEqual(["migrated"]);
  });
});

describe("in-pod revision-keyed heartbeat (PR3 dependency)", () => {
  it("carries revisionId onto the heartbeat snapshot so glmGateways/{revisionId}.heartbeat gets written", () => {
    const snap = buildFleetHeartbeatSnapshot({
      gatewayId: "default",
      revisionId: "default-r2",
      status: "ready",
      version: "sha-1",
      openclawVersion: "2026.7.1",
      mountedCustomers: ["alice"],
      internalUrl: "http://octogee-gateway-default-r2.ns.svc.cluster.local:18789",
      startedAt: 42,
    });
    expect(snap).toMatchObject({ gatewayId: "default", revisionId: "default-r2", status: "ready" });
  });

  it("refuses an empty revision id so a legacy pod cannot write bare telemetry", () => {
    expect(() =>
      buildFleetHeartbeatSnapshot({
        gatewayId: "default",
        revisionId: "",
        status: "booting",
        version: "v",
        openclawVersion: "v",
        mountedCustomers: [],
        internalUrl: "http://gw",
        startedAt: 1,
      }),
    ).toThrow("revisionId is required");
  });

  it("points the heartbeat internalUrl at the revision Service when a revision id is set", () => {
    expect(gatewayRevisionServiceName({ gatewayId: "default", revisionId: "default-r2" })).toBe(
      "octogee-gateway-default-r2",
    );
  });

  it("refuses bare service addressing", () => {
    expect(() => gatewayRevisionServiceName({ gatewayId: "default", revisionId: "" })).toThrow(
      "revisionId is required",
    );
  });
});

describe("in-pod migration path guard (transport/tenant split)", () => {
  it("accepts the bare gateway id that matches the pod's GATEWAY_ID", () => {
    expect(pathGatewayIdMatchesPod("default", "default")).toBe(true);
  });

  it("REJECTS a revision id in the path — transport is addressed by Service, not the tenant path", () => {
    expect(pathGatewayIdMatchesPod("default-r2", "default")).toBe(false);
  });

  it("rejects a mismatched gateway id and an absent path param", () => {
    expect(pathGatewayIdMatchesPod("other", "default")).toBe(false);
    expect(pathGatewayIdMatchesPod(undefined, "default")).toBe(false);
  });
});

describe("resolveFleetCapabilities — observability vs provisioning seam", () => {
  it("cattle (platformState + reportState + db): reports AND provisions", () => {
    expect(
      resolveFleetCapabilities({ platformState: true, reportState: true, hasDb: true }),
    ).toEqual({ reportMounted: true, provision: true, needsStateDeps: true });
  });

  it("operator (db-less: platformState=false, reportState=false, no db): no capabilities — Cowboy owns reporting + eviction", () => {
    expect(
      resolveFleetCapabilities({ platformState: false, reportState: false, hasDb: false }),
    ).toEqual({ reportMounted: false, provision: false, needsStateDeps: false });
  });

  it("report-only with db (platformState=false, reportState=true, db): reports, does NOT provision", () => {
    expect(
      resolveFleetCapabilities({ platformState: false, reportState: true, hasDb: true }),
    ).toEqual({ reportMounted: true, provision: false, needsStateDeps: true });
  });

  it("no db: neither reports nor provisions, regardless of flags", () => {
    expect(
      resolveFleetCapabilities({ platformState: true, reportState: true, hasDb: false }),
    ).toEqual({ reportMounted: false, provision: false, needsStateDeps: false });
  });

  it("the two axes are independent: provision without reporting", () => {
    expect(
      resolveFleetCapabilities({ platformState: true, reportState: false, hasDb: true }),
    ).toEqual({ reportMounted: false, provision: true, needsStateDeps: false });
  });

  it("brokered db-less gateway: provisions local mounts without Firestore state deps", () => {
    expect(
      resolveFleetCapabilities({
        platformState: true,
        reportState: false,
        localReconcile: true,
        hasDb: false,
        hasBrokeredRoster: true,
      }),
    ).toEqual({ reportMounted: false, provision: true, needsStateDeps: false });
  });

  it("brokered operator gateway: provisions local mounts while platformState stays false", () => {
    expect(
      resolveFleetCapabilities({
        platformState: false,
        reportState: false,
        localReconcile: true,
        hasDb: false,
        hasBrokeredRoster: true,
      }),
    ).toEqual({ reportMounted: false, provision: true, needsStateDeps: false });
  });
});
