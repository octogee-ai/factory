import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayVmState } from "@octogee/shared/types/glm";
import { AlreadyExistsError, DuplicateRecordError, FenceMismatchError, MalformedRecordError, MissingRecordError } from "../../errors.js";
import type { FleetRegistryRecord } from "../../fleet-registry.js";
import { createHarness, dsn, recordingListener, type PlatformStateHarness, type RecordingListener } from "./fixtures/harness.js";

const NOW = 1_762_500_000_000;
const WAIT = { timeout: 20_000, interval: 20 };

function vm(instanceId: string | null): GatewayVmState {
  return {
    instanceName: "octogee-gw-walter",
    zone: "us-central1-a",
    instanceId,
    internalIp: "10.0.0.7",
    status: "RUNNING",
    startedAt: NOW,
    provisioningModel: "STANDARD",
    stopReason: null,
    updatedAt: NOW,
  };
}

function runtimeRecord(gatewayId: string, overrides: Partial<FleetRegistryRecord> = {}): FleetRegistryRecord {
  return {
    gatewayId,
    release: 1,
    lifecycle: "provisioning",
    createdAt: NOW,
    createdByOperationId: null,
    helm: {
      releaseName: `octogee-gw-${gatewayId}`,
      deploymentName: `octogee-gateway-${gatewayId}`,
      gatewayServiceName: `octogee-gateway-${gatewayId}`,
      gatewayEdgeServiceName: `gateway-edge-${gatewayId}`,
      serviceAccountName: `octogee-gw-${gatewayId}`,
      imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway",
      imageTag: "753c212",
      replicas: 1,
      availableReplicas: null,
      lastAppliedAt: NOW,
    },
    heartbeat: {
      status: "unknown",
      lastHeartbeatAt: null,
      version: null,
      openclawVersion: null,
      internalUrl: null,
      startedAt: null,
      mountedCustomers: [],
      migratingIn: [],
    },
    lastError: { message: null, at: null },
    ...overrides,
  };
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

function changeKeys(listener: RecordingListener<"fleetRegistry">): string[] {
  return listener.events
    .flatMap((event) => (event.kind === "changes" ? [...event.changes] : []))
    .map((change) => `${change.type}:${change.key}`);
}

describe.skipIf(!dsn)("PostgreSQL fleet registry", { timeout: 30_000 }, () => {
  let harness: PlatformStateHarness;
  const registry = () => harness.store.fleetRegistry;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it("creates a runtime record once and reads it back exactly, with a revision", async () => {
    await registry().create(runtimeRecord("walter"));

    expect(await registry().get("walter")).toEqual({ ...runtimeRecord("walter"), revision: expect.stringMatching(/^\d+$/) });
    expect(await registry().get("ghost")).toBeNull();
    expect(await failure(registry().create(runtimeRecord("walter")))).toMatchObject({
      constructor: AlreadyExistsError,
      record: { aggregate: "fleet-registry", key: "walter" },
    });
  });

  it("refuses runtime rows without a heartbeat map", async () => {
    await registry().create(runtimeRecord("walter"));
    await harness.query("UPDATE $schema.fleet_registry SET heartbeat = 'null'::jsonb WHERE gateway_id = 'walter'");
    await expect(registry().get("walter")).rejects.toMatchObject({ name: "MalformedRecordError" });
  });

  it("round-trips every VM field and keeps a null vm apart from an absent one", async () => {
    const full = runtimeRecord("walter", {
      runtime: "gce-vm",
      retiredAt: NOW + 1,
      createdByOperationId: "op-add",
      kubernetes: { status: "ready", totalPods: 1, readyPods: 1, observedAt: NOW },
      podReplacements: { count: 1 } as never,
      vmSpec: { machineType: "e2-medium" } as never,
      vm: vm("i-1"),
      vmInstance: { name: "octogee-gw-walter" },
      vmHome: { diskName: "home-walter" },
      vmStopOnPark: { requestedAt: NOW },
      vmBootRecovery: { attempts: 1 },
      vmPreemption: { at: NOW },
      vmDisk: { sizeBytes: 10 },
      vmImages: { gateway: "gateway:1" },
      vmEgress: { mode: "open" } as never,
      surgeCrashLoopEvictions: { count: 0 },
      openclawHealthyBuild: "abc",
    });
    await registry().create(full);
    await registry().create(runtimeRecord("flexo", { runtime: "gce-vm", vm: null }));

    const { revision: _revision, ...stored } = (await registry().get("walter"))!;
    expect(stored).toEqual(full);
    expect((await registry().get("flexo"))?.vm).toBeNull();
    expect(await registry().get("flexo")).toHaveProperty("vm", null);
    expect(await registry().get("flexo")).not.toHaveProperty("retiredAt");
  });

  it("deep-merges a partial heartbeat into the heartbeat map under server time", async () => {
    const heartbeat = { ...runtimeRecord("walter").heartbeat, migratingIn: ["ceckert"], configStatus: { runtimeReady: false, openclawVersion: "7.1" } };
    await registry().create(runtimeRecord("walter", { heartbeat }));
    const before = await registry().get("walter");

    await registry().recordHeartbeat("walter", {
      status: "ready",
      mountedCustomers: ["ceckert"],
      version: "1.2.3",
      configStatus: { runtimeReady: true },
    });

    const stored = await registry().get("walter");
    expect(stored?.heartbeat).toEqual({
      ...heartbeat,
      status: "ready",
      mountedCustomers: ["ceckert"],
      version: "1.2.3",
      migratingIn: ["ceckert"],
      configStatus: { runtimeReady: true, openclawVersion: "7.1" },
      lastHeartbeatAt: expect.any(Number),
    });
    expect(Math.abs((stored?.heartbeat.lastHeartbeatAt ?? 0) - Date.now())).toBeLessThan(60_000);
    expect(stored?.revision).not.toBe(before?.revision);
    const [row] = await harness.query("SELECT heartbeat_status, heartbeat_at FROM $schema.fleet_registry WHERE gateway_id = 'walter'");
    expect(row).toEqual({ heartbeat_status: "ready", heartbeat_at: stored?.heartbeat.lastHeartbeatAt });
  });

  it("refuses a heartbeat for a gateway without a runtime record", async () => {
    expect(await failure(registry().recordHeartbeat("ghost", { status: "ready", mountedCustomers: [] }))).toMatchObject({
      constructor: MissingRecordError,
      record: { aggregate: "fleet-registry", key: "ghost" },
    });
  });

  it("upserts the patched initial record when absent and only the patch when present", async () => {
    await registry().upsert("walter", runtimeRecord("walter", { retiredAt: NOW }), { lifecycle: "serving", retiredAt: { clear: true } });
    const { revision: _revision, ...created } = (await registry().get("walter"))!;
    expect(created).toEqual(runtimeRecord("walter", { lifecycle: "serving" }));

    await registry().upsert("walter", runtimeRecord("walter", { release: 9 }), { release: 2 });
    expect(await registry().get("walter")).toMatchObject({ lifecycle: "serving", release: 2 });

    const unchanged = await registry().get("walter");
    await registry().upsert("walter", runtimeRecord("walter", { release: 9 }), {});
    expect(await registry().get("walter")).toEqual(unchanged);

    expect(await failure(registry().upsert("walter", runtimeRecord("flexo"), {}))).toBeInstanceOf(MalformedRecordError);
    expect(await failure(registry().upsert("walter", runtimeRecord("walter"), { createdAt: 1 } as never))).toBeInstanceOf(TypeError);
  });

  it("patches under lifecycle and VM instance fences and refuses a missing record", async () => {
    await registry().create(runtimeRecord("walter", { vm: vm("i-1"), runtime: "gce-vm" }));
    const current = await registry().get("walter");

    await registry().patch("walter", { lifecycle: "serving", retiredAt: NOW }, { revision: current?.revision, lifecycle: ["provisioning"], vmInstanceId: "i-1" });
    await registry().patch("walter", { retiredAt: { clear: true } });
    expect(await registry().get("walter")).toMatchObject({ lifecycle: "serving" });
    expect(await registry().get("walter")).not.toHaveProperty("retiredAt");

    const mismatches = await Promise.all([
      failure(registry().patch("walter", { release: 3 }, { revision: current?.revision })),
      failure(registry().patch("walter", { release: 3 }, { lifecycle: ["provisioning"] })),
      failure(registry().patch("walter", { release: 3 }, { vmInstanceId: null })),
      failure(registry().patch("walter", { release: 3 }, { vmInstanceId: "i-2" })),
    ]);
    expect(mismatches.map((error) => (error as FenceMismatchError).fence)).toEqual(["revision", "status", "present", "present"]);
    expect(mismatches[2]).toMatchObject({ expected: null, actual: "i-1" });
    expect((await registry().get("walter"))?.release).toBe(1);

    await registry().patch("walter", { vm: null }, { vmInstanceId: "i-1" });
    await registry().patch("walter", { release: 3 }, { vmInstanceId: null });
    expect(await registry().get("walter")).toMatchObject({ vm: null, release: 3 });
    expect(await failure(registry().patch("ghost", { release: 3 }))).toBeInstanceOf(MissingRecordError);
    expect(await failure(registry().patch("ghost", { release: 3 }, { lifecycle: ["serving"] }))).toBeInstanceOf(MissingRecordError);
  });

  it("finds a record by VM instance id and refuses a second record with that instance", async () => {
    await registry().create(runtimeRecord("walter", { vm: vm("i-1") }));
    expect((await registry().findByVmInstanceId("i-1"))?.gatewayId).toBe("walter");
    expect(await registry().findByVmInstanceId("i-2")).toBeNull();

    expect(await failure(registry().create(runtimeRecord("flexo", { vm: vm("i-1") })))).toMatchObject({
      constructor: DuplicateRecordError,
      aggregate: "fleet-registry",
      lookup: "vm_instance_id",
      value: "i-1",
    });
    await registry().create(runtimeRecord("flexo", { vm: vm(null) }));
    await registry().create(runtimeRecord("hermes", { vm: vm(null) }));
  });

  it("inventories every runtime record, or only the named gateways, with nothing foreign", async () => {
    await registry().create(runtimeRecord("walter"));
    await registry().create(runtimeRecord("shared-a"));

    const everything = await registry().inventory();
    const named = await registry().inventory(["shared-a", "ghost"]);

    expect(everything.records.map((record) => record.gatewayId)).toEqual(["shared-a", "walter"]);
    expect(everything.foreign).toEqual([]);
    expect(named.records.map((record) => record.gatewayId)).toEqual(["shared-a"]);
    expect(named.foreign).toEqual([]);
  });

  it("lists by runtime, reads many and deletes", async () => {
    await registry().create(runtimeRecord("walter", { runtime: "gce-vm", vm: null }));
    await registry().create(runtimeRecord("shared-a", { runtime: "cluster" }));

    expect((await registry().list({ runtime: "gce-vm" })).map((record) => record.gatewayId)).toEqual(["walter"]);
    expect((await registry().list()).map((record) => record.gatewayId)).toEqual(["shared-a", "walter"]);
    expect([...(await registry().getMany(["shared-a", "ghost", "walter"])).keys()].sort()).toEqual(["shared-a", "walter"]);

    await registry().delete("walter");
    await registry().delete("walter");
    expect(await registry().get("walter")).toBeNull();
  });

  it("watches the registry as a snapshot followed by changes, for all gateways or one", async () => {
    await registry().create(runtimeRecord("walter"));
    const all = recordingListener<"fleetRegistry">();
    const one = recordingListener<"fleetRegistry">();
    harness.store.watch({ aggregate: "fleetRegistry", filter: {} }, all);
    harness.store.watch({ aggregate: "fleetRegistry", filter: { gatewayId: "walter" } }, one);

    await vi.waitFor(() => expect(all.events[0]).toMatchObject({ kind: "snapshot", records: [expect.objectContaining({ gatewayId: "walter" })] }), WAIT);
    await vi.waitFor(() => expect(one.events[0]).toMatchObject({ kind: "snapshot", records: [expect.objectContaining({ gatewayId: "walter" })] }), WAIT);
    await registry().create(runtimeRecord("flexo"));
    await vi.waitFor(() => expect(changeKeys(all)).toEqual(["added:flexo"]), WAIT);
    await registry().recordHeartbeat("walter", { status: "ready", mountedCustomers: [] });
    await vi.waitFor(() => expect(changeKeys(all)).toEqual(["added:flexo", "modified:walter"]), WAIT);
    await registry().delete("walter");
    await vi.waitFor(() => expect(changeKeys(all)).toEqual(["added:flexo", "modified:walter", "removed:walter"]), WAIT);
    await vi.waitFor(() => expect(changeKeys(one)).toEqual(["modified:walter", "removed:walter"]), WAIT);
    expect(all.errors).toEqual([]);
  });
});
