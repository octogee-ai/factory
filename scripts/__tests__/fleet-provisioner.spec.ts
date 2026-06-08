import { describe, expect, it, vi } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import {
  maybeRefreshReportedMounts,
  readMountedCustomersFromAssignedState,
  resolveFleetCapabilities,
} from "../lib/fleet-provisioner.js";

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
  it("cattle (platformState + reportState + db): reports AND provisions; drain loop owns honesty, no report-refresh", () => {
    expect(
      resolveFleetCapabilities({ platformState: true, reportState: true, hasDb: true }),
    ).toEqual({
      reportMounted: true,
      provision: true,
      refreshReportedMounts: false,
      needsStateDeps: true,
    });
  });

  it("operator (platformState=false, reportState=true, db): reports + refreshes the reported set (no drain loop), does NOT provision", () => {
    expect(
      resolveFleetCapabilities({ platformState: false, reportState: true, hasDb: true }),
    ).toEqual({
      reportMounted: true,
      provision: false,
      refreshReportedMounts: true,
      needsStateDeps: true,
    });
  });

  it("no db (local dev): neither reports nor provisions nor refreshes, regardless of flags", () => {
    expect(
      resolveFleetCapabilities({ platformState: true, reportState: true, hasDb: false }),
    ).toEqual({
      reportMounted: false,
      provision: false,
      refreshReportedMounts: false,
      needsStateDeps: false,
    });
  });

  it("reportState explicitly off + db: no reporting (lets a gateway opt out)", () => {
    expect(
      resolveFleetCapabilities({ platformState: false, reportState: false, hasDb: true }),
    ).toEqual({
      reportMounted: false,
      provision: false,
      refreshReportedMounts: false,
      needsStateDeps: false,
    });
  });

  it("the two axes are independent: provision without reporting", () => {
    expect(
      resolveFleetCapabilities({ platformState: true, reportState: false, hasDb: true }),
    ).toEqual({
      reportMounted: false,
      provision: true,
      refreshReportedMounts: false,
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
