import { describe, expect, it, vi } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import {
  getEvictObservedSlugs,
  getMountObservedSlugs,
  readMountedCustomersFromAssignedState,
  resolveFleetCapabilities,
} from "../lib/fleet-provisioner.js";
import type { CustomerLifecycleAdapter } from "../lib/customer-lifecycle.js";

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
    ).toEqual({ reportMounted: false, provision: true, needsStateDeps: true });
  });
});
