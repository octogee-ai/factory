import { createComputerHomeClient } from "../lib/compute-home.js";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { FieldValue, type Firestore } from "firebase-admin/firestore";
import type { GatewayVmSpec, HelmInstancesMap } from "@octogee/shared/types/glm";
import type { CreateGatewayVmInput, CreateGatewayVmResult, GatewayVmClient, GatewayVmDescription } from "../lib/compute-vm";
import { ComputeOperationError, GATEWAY_VM_ACCESS_SCOPES } from "../lib/compute-vm";
import type { HelmRunner } from "../helm-runner";
import {
  createRuntimeDispatchingHelmRunner,
  createVmGatewayRuntime,
  parseGatewayVmSpec,
  resolveBuilderComputerPolicy,
  resolveDisposableBuilderParking,
  stampGatewayRuntime,
  vmRoutesFromDocs,
} from "../vm-gateway-runtime";
import { ComputerCreationPendingError, builderComputerInstanceInput } from "../vm-computer-lifecycle";

const renderedJson = readFileSync(new URL("./fixtures/vm-runtime-render.json", import.meta.url), "utf8");
const concatenated = (JSON.parse(renderedJson) as unknown[]).map((item) => JSON.stringify(item)).join("\n");

const spec: GatewayVmSpec = {
  zones: ["us-west1-b"], machineType: "n2-standard-4", imageFamily: "octogee-computer", diskSizeGb: 40, bootDiskType: "pd-ssd", homeDiskSizeGb: 20,
  provisioningModel: "SPOT", desktop: "omarchy", serviceAccountEmail: "octogee-computer-test@octogee.iam.gserviceaccount.com",
  subnetwork: "regions/us-west1/subnetworks/octogee-west-gke",
};

type Docs = Record<string, Record<string, unknown>>;

function readPath(data: Record<string, unknown>, field: string): unknown {
  return field.split(".").reduce<unknown>((value, key) => (value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined), data);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && !(value instanceof FieldValue);
}

function mergeInto(target: Record<string, unknown>, data: Record<string, unknown>): Record<string, unknown> {
  for (const [k, v] of Object.entries(data)) {
    if (v instanceof FieldValue && v.isEqual(FieldValue.delete())) delete target[k];
    else if (isPlainObject(v) && isPlainObject(target[k])) target[k] = mergeInto({ ...(target[k] as Record<string, unknown>) }, v);
    else if (isPlainObject(v)) target[k] = mergeInto({}, v);
    else target[k] = v;
  }
  return target;
}

function fakeDb(docs: Docs, beforeWrite?: (path: string, data: Record<string, unknown>) => void) {
  const writes: Array<{ path: string; data: unknown; merge: boolean }> = [];
  const deletes: string[] = [];
  const docRef = (path: string) => ({
    id: path.split("/").at(-1)!,
    get: async () => ({ exists: docs[path] !== undefined, data: () => docs[path] }),
    set: async (data: Record<string, unknown>, opts?: { merge?: boolean }) => {
      beforeWrite?.(path, data);
      writes.push({ path, data, merge: opts?.merge === true });
      docs[path] = opts?.merge ? mergeInto({ ...(docs[path] ?? {}) }, data) : mergeInto({}, data);
    },
    delete: async () => { deletes.push(path); delete docs[path]; },
  });
  type Ref = ReturnType<typeof docRef>;
  const db = {
    doc: docRef,
    runTransaction: async <T>(fn: (tx: { get: (ref: Ref) => Promise<unknown>; set: (ref: Ref, data: Record<string, unknown>, opts?: { merge?: boolean }) => void }) => Promise<T>) =>
      {
        const pending: Promise<void>[] = [];
        const result = await fn({ get: (ref) => ref.get(), set: (ref, data, opts) => { pending.push(ref.set(data, opts)); } });
        await Promise.all(pending);
        return result;
      },
    collection: (name: string) => ({
      doc: (id: string) => docRef(`${name}/${id}`),
      where: (field: string, _op: string, value: unknown) => ({
        get: async () => ({
          docs: Object.entries(docs)
            .filter(([path, data]) => path.startsWith(`${name}/`) && !path.slice(name.length + 1).includes("/") && readPath(data, field) === value)
            .map(([path, data]) => ({ id: path.slice(name.length + 1), data: () => data })),
        }),
      }),
    }),
  } as unknown as Firestore;
  return { db, docs, writes, deletes };
}

const COMPUTER = "octogee-computer-test-uida";
const OWNER_LABELS = { "octogee-owner-uid": "uida", "octogee-environment": "test", purpose: "octogee-computer" };
const running: GatewayVmDescription = {
  machineType: "n2-standard-4",
  serviceAccounts: [{ email: spec.serviceAccountEmail, scopes: [...GATEWAY_VM_ACCESS_SCOPES] }],
  name: COMPUTER, zone: "us-west1-b", status: "RUNNING", instanceId: "4242", internalIp: "172.20.0.9", provisioningModel: "SPOT", gatewayId: "b-x",
  labels: { ...OWNER_LABELS, "octogee-gateway-id": "b-x" }, metadata: { "gateway-id": "b-x", "gateway-image": "us-docker.pkg.dev/octogee/octogee/gateway:main.abc123", "octogee-api-url": "http://172.20.7.7:3001" }, lastStartedAt: 100,
};
const stopped: GatewayVmDescription = { ...running, status: "TERMINATED", internalIp: null };
const suspended: GatewayVmDescription = { ...running, status: "SUSPENDED", internalIp: null };
const CURRENT_IMAGE = { name: "octogee-computer-20260927", id: "2027" };
const OLD_IMAGE = { name: "octogee-computer-20260914", id: "1914" };
const recorded = { instanceName: COMPUTER, zone: "us-west1-b", instanceId: "4242", internalIp: "172.20.0.9", status: "RUNNING", startedAt: 100, provisioningModel: "SPOT", stopReason: null, updatedAt: 1 };

function harness(
  docs: Docs,
  vmOverrides: Partial<GatewayVmClient> = {},
  bridge = "172.20.7.7",
  desiredStatus: Record<string, string | null> = {},
  extra: { beforeWrite?: (path: string, data: Record<string, unknown>) => void; disposableParking?: boolean; clock?: { now: number }; onWait?: (ms: number, waits: number) => void | Promise<void>; homeCheckpointTimeoutMs?: number; applyFails?: boolean; onApply?: (routes: Record<string, string>) => Promise<void>; vmSpec?: GatewayVmSpec } = {},
) {
  docs["users/UidA"] ??= { provisioning: { openclaw: { gatewayId: "b-x" } } };
  const { db, writes, deletes } = fakeDb(docs, extra.beforeWrite);
  const clock = extra.clock ?? { now: 1_000 };
  const waits: number[] = [];
  const vm: GatewayVmClient = {
    create: vi.fn(async (input) => ({ description: { ...running, machineType: input.machineType }, provisioningModel: "SPOT", fellBackToStandard: false, alreadyExisted: false })),
    describe: vi.fn(async () => running),
    find: vi.fn(async () => null),
    findByLabels: vi.fn(async () => null),
    list: vi.fn(async () => []),
    bind: vi.fn(async () => {}),
    expandHome: vi.fn(async (home, _owner, sizeGb) => ({ ...home, sizeGb: Math.max(home.sizeGb, sizeGb) })),
    retainHome: vi.fn(async () => ({ projectId: "octogee-test", zone: "us-west1-b", name: "computer-home", id: "777", sizeGb: 30, diskType: "pd-ssd" as const, source: "projects/octogee-test/zones/us-west1-b/disks/computer-home" })),
    verifyDetachedHome: vi.fn(async () => {}),
    deleteRetainedHome: vi.fn(async () => {}),
    deleteRetainingHome: vi.fn(async () => {}),
    setServiceAccount: vi.fn(async () => {}),
    setMachineType: vi.fn(async () => {}),
    setProvisioningModel: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    start: vi.fn(async () => ({ fellBackToStandard: false })),
    suspend: vi.fn(async () => {}),
    resume: vi.fn(async () => ({ fellBackToStandard: false })),
    delete: vi.fn(async () => true),
    lastPreemptedAt: vi.fn(async () => null),
    readBootImage: vi.fn(async () => CURRENT_IMAGE),
    readFamilyImage: vi.fn(async () => CURRENT_IMAGE),
    readImage: vi.fn(async () => CURRENT_IMAGE),
    ...vmOverrides,
  };
  const log = vi.fn();
  const creationSettled = vi.fn();
  const helmCalls: string[][] = [];
  const kubectlCalls: Array<{ args: string[]; stdin?: string }> = [];
  const runtime = createVmGatewayRuntime({
    db, namespace: "octogee-test", environment: "test",
    runHelm: async (args) => { helmCalls.push(args); return { stdout: concatenated.replaceAll("b-x", args[1].slice("octogee-gw-".length)), stderr: "", code: 0 }; },
    runKubectl: async (args, opts) => {
      kubectlCalls.push({ args, stdin: opts?.stdin });
      if (args[0] === "create") return { stdout: opts!.stdin!, stderr: "", code: 0 };
      if (args[0] === "get" && args[1] === "svc") return { stdout: bridge, stderr: "", code: 0 };
      if (args[0] === "get" && args[1] === "secret") return { stdout: Buffer.from(`${args[2]}-value`).toString("base64"), stderr: "", code: 0 };
      if (args[0] === "apply" && extra.applyFails) return { stdout: "", stderr: "configmaps is forbidden", code: 1 };
      if (args[0] === "apply") await extra.onApply?.(JSON.parse(JSON.parse(opts!.stdin!).data["routes.json"]));
      return { stdout: "", stderr: "", code: 0 };
    },
    vm, vmSpec: extra.vmSpec ?? spec, computeProjectId: "octogee", bridgeServiceName: "octogee-vm-bridge",
    hostAliasNames: ["octogee-api.octogee-test.svc.cluster.local", "mattermost.octogee-test.svc.cluster.local"],
    kubernetes: { apiHost: "172.20.16.18", apiPort: "443", caCert: "CA" },
    routesConfigMap: "octogee-vm-routes",
    ensureAuthSecret: vi.fn(async () => {}),
    readDesiredStatus: async (gatewayId) => gatewayId in desiredStatus ? desiredStatus[gatewayId] : "running",
    journalBootUpgrade: async (_input, work) => work(async () => {}),
    wait: async (ms) => { waits.push(ms); clock.now += ms; await extra.onWait?.(ms, waits.length); },
    disposableParking: extra.disposableParking,
    homeCheckpointTimeoutMs: extra.homeCheckpointTimeoutMs ?? 60_000,
    homeCheckpointPollMs: 10_000,
    onComputerCreationSettled: creationSettled,
    now: () => clock.now, log,
  });
  const routesPublished = () => kubectlCalls.filter((c) => c.args[0] === "apply").map((c) => JSON.parse(JSON.parse(c.stdin!).data["routes.json"]) as Record<string, string>);
  return { runtime, db, docs, writes, deletes, vm, log, creationSettled, helmCalls, kubectlCalls, routesPublished, clock, waits };
}

const upsertOpts = {
  namespace: "octogee-test", gatewayId: "b-x", imageRepository: "us-docker.pkg.dev/octogee/octogee/gateway", imageTag: "main.abc123",
  chartPath: "/chart", builderIdentity: { ownerUid: "UidA", builderSlug: "mama" }, gatewayClass: "builder" as const, profile: "builder" as const,
  imageProfile: "builder" as const, chartFingerprint: "cf", deploymentIntentFingerprint: "dif",
};

async function createComputer(h: ReturnType<typeof harness>, opts: typeof upsertOpts = upsertOpts): Promise<void> {
  const settled = h.creationSettled.mock.calls.length;
  await expect(h.runtime.upsertInstance(opts)).rejects.toBeInstanceOf(ComputerCreationPendingError);
  await vi.waitFor(() => expect(h.creationSettled.mock.calls.length).toBeGreaterThan(settled));
}

async function deployCreatingComputer(h: ReturnType<typeof harness>, opts: typeof upsertOpts = upsertOpts): Promise<void> {
  await createComputer(h, opts);
  await h.runtime.upsertInstance(opts);
}

describe("builderComputerInstanceInput", () => {
  const source = { gatewayId: "b-X", ownerUid: "UidA", spec, environment: "test", image: "us-docker.pkg.dev/octogee/octogee/gateway:main.abc123", bridgeIp: "172.20.7.7" };

  it("names the computer for the Builder, labels it for the tenant, and carries the boot contract in metadata", () => {
    expect(builderComputerInstanceInput(source)).toEqual({
      instanceName: COMPUTER,
      ...spec,
      labels: { "octogee-gateway-id": "b-x", "octogee-environment": "test", purpose: "octogee-computer", "octogee-owner-uid": "uida" },
      metadata: {
        "gateway-id": "b-X",
        "octogee-owner-uid": "UidA",
        "octogee-environment": "test",
        "gateway-image": "us-docker.pkg.dev/octogee/octogee/gateway:main.abc123",
        "octogee-api-url": "http://172.20.7.7:3001",
        "octogee-computer-desktop": "omarchy",
      },
    });
    expect(builderComputerInstanceInput({ ...source, spec: { ...spec, imageProject: "octogee-images" } }).imageProject).toBe("octogee-images");
    expect(builderComputerInstanceInput({ ...source, spec: { ...spec, desktop: "x11" } }).metadata["octogee-computer-desktop"]).toBe("x11");
  });

  it("sets every metadata attribute the octo-gateway-agent unit reads at boot, on a create and a rebind", async () => {
    const unit = readFileSync(new URL("../../../infra/desktop/image/rootfs/usr/local/bin/octo-gateway-agent", import.meta.url), "utf8");
    const readByAgent = [...new Set([...unit.matchAll(/\$\(attr ([a-z-]+)\)/g)].map((m) => m[1]))];
    expect(readByAgent).toEqual(["gateway-id", "gateway-image", "octogee-api-url"]);
    const gatewayDoc = { "glmGateways/b-x": { docKind: "runtime", gatewayId: "b-x", runtime: "gce-vm" } };

    const created = harness({ ...gatewayDoc });
    await deployCreatingComputer(created);
    const parkedElsewhere = { ...stopped, gatewayId: "b-old" };
    const rebound = harness({ ...gatewayDoc }, {
      findByLabels: vi.fn(async () => parkedElsewhere),
      describe: vi.fn(async () => running).mockResolvedValueOnce(parkedElsewhere),
    });
    await rebound.runtime.upsertInstance(upsertOpts);

    const paths = {
      create: created.vm.create.mock.calls[0][0].metadata,
      bind: rebound.vm.bind.mock.calls[0][2].metadata,
    };
    expect(rebound.vm.create).not.toHaveBeenCalled();
    for (const [path, metadata] of Object.entries(paths)) {
      for (const key of readByAgent) expect(metadata[key], `${path} ${key}`).toMatch(/\S/);
      expect(metadata).toEqual(paths.create);
    }
  });
});

describe("createVmGatewayRuntime.upsertInstance", () => {
  it("serializes route reads and publication so a slow snapshot cannot remove a concurrently started VM", async () => {
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const firstApply = new Promise<void>(resolve => { entered = resolve; });
    const applied: Record<string, string>[] = [];
    let calls = 0;
    const createdComputers = new Map<string, GatewayVmDescription>();
    const h = harness({
      "glmGateways/b-x": { docKind: "runtime", gatewayId: "b-x", runtime: "gce-vm", vm: { ...recorded } },
      "glmGateways/b-y": { docKind: "runtime", gatewayId: "b-y", runtime: "gce-vm" },
      "users/UidB": { provisioning: { openclaw: { gatewayId: "b-y" } } },
    }, {
      create: vi.fn(async input => {
        const description = { ...running, name: input.instanceName, gatewayId: "b-y", internalIp: "172.20.0.10", labels: input.labels, metadata: input.metadata };
        createdComputers.set(input.instanceName, description);
        return { description, provisioningModel: "SPOT" as const, fellBackToStandard: false, alreadyExisted: false };
      }),
      describe: vi.fn(async (name: string) => createdComputers.get(name) ?? running),
    }, "172.20.7.7", {}, {
      onApply: async routes => {
        if (calls++ === 0) { entered(); await held; }
        applied.push(routes);
      },
    });
    const first = h.runtime.upsertInstance(upsertOpts);
    await firstApply;
    const second = deployCreatingComputer(h, { ...upsertOpts, gatewayId: "b-y", builderIdentity: { ownerUid: "UidB", builderSlug: "bob" } });
    try {
      await vi.waitFor(() => expect(h.docs["glmGateways/b-y/vm/runtime"]).toBeDefined());
      expect(h.routesPublished()).toHaveLength(1);
    } finally {
      release();
      await Promise.all([first, second]);
    }
    expect(applied[0]).toEqual({ "b-x": "172.20.0.9" });
    expect(applied.at(-1)).toEqual({ "b-x": "172.20.0.9", "b-y": "172.20.0.10" });
  });

  it("reports a route publication failure while allowing the next queued publication to succeed", async () => {
    let calls = 0;
    const h = harness({ "glmGateways/b-x": { docKind: "runtime", gatewayId: "b-x", runtime: "gce-vm", vm: { ...recorded } } },
      {}, "172.20.7.7", {}, { onApply: async () => { if (calls++ === 0) throw new Error("route publication failed"); } });

    const results = await Promise.allSettled([h.runtime.upsertInstance(upsertOpts), h.runtime.upsertInstance(upsertOpts)]);

    expect(results[0]).toMatchObject({ status: "rejected", reason: new Error("route publication failed") });
    expect(results[1]).toMatchObject({ status: "fulfilled" });
    expect(h.routesPublished()).toHaveLength(2);
    expect(h.docs["glmGateways/b-x"].vmInstance).toMatchObject({ gatewayId: "b-x" });
  });

  it("resizes a parked Team computer to the recorded Pro shape before starting it", async () => {
    let computer = { ...stopped };
    const h = harness({ "glmGateways/b-x": { gatewayId: "b-x", runtime: "gce-vm", vmSpec: { ...spec, machineType: "n2-standard-2" }, vm: recorded } }, {
      describe: vi.fn(async () => computer),
      setMachineType: vi.fn(async (_name, _zone, machineType) => { computer = { ...computer, machineType }; }),
      start: vi.fn(async () => { computer = { ...computer, status: "RUNNING" }; return { fellBackToStandard: false }; }),
    });
    await h.runtime.upsertInstance(upsertOpts);
    expect(h.vm.setMachineType).toHaveBeenCalledWith(COMPUTER, "us-west1-b", "n2-standard-2");
    expect(h.vm.setMachineType.mock.invocationCallOrder[0]).toBeLessThan(h.vm.start.mock.invocationCallOrder[0]);
    expect(h.vm.delete).not.toHaveBeenCalled();
  });

  it("renders an X11 computer's runtime with the X11 desktop in its gateway and no host desktop node", async () => {
    const h = harness({ "glmGateways/b-x": { gatewayId: "b-x", runtime: "gce-vm", vmSpec: { ...spec, desktop: "x11" }, vm: recorded } }, {
      describe: vi.fn(async () => ({ ...running, metadata: { ...running.metadata, "octogee-owner-uid": "UidA", "octogee-computer-desktop": "x11" } })),
    });
    await h.runtime.upsertInstance(upsertOpts);
    expect(h.helmCalls.at(-1)).toEqual(expect.arrayContaining(["computerDesktop=x11", "runtimeKind=gce-vm"]));
    const bundle = h.docs["glmGateways/b-x/vm/runtime"];
    expect(bundle).toMatchObject({ desktop: "x11" });
    expect((bundle.containers as Array<{ name: string }>).map((container) => container.name)).toEqual(["gateway", "gateway-edge"]);
  });

  it("reads a recorded spec from before desktops and boot disk types as the Omarchy pd-ssd computer it describes", async () => {
    const { desktop: _desktop, bootDiskType: _bootDiskType, ...omarchyEra } = spec;
    const h = harness({ "glmGateways/b-x": { gatewayId: "b-x", runtime: "gce-vm", vmSpec: omarchyEra, vm: recorded } }, {
      describe: vi.fn(async () => ({ ...running, metadata: { ...running.metadata, "octogee-owner-uid": "UidA" } })),
    });
    await h.runtime.upsertInstance(upsertOpts);
    expect(h.helmCalls.at(-1)).toEqual(expect.arrayContaining(["computerDesktop=omarchy"]));
    expect(h.docs["glmGateways/b-x/vm/runtime"]).toMatchObject({ desktop: "omarchy" });
  });

  it("refuses a recorded spec with an unknown desktop or boot disk type", async () => {
    for (const vmSpec of [{ ...spec, desktop: "kde" }, { ...spec, bootDiskType: "pd-standard" }]) {
      const h = harness({ "glmGateways/b-x": { gatewayId: "b-x", runtime: "gce-vm", vmSpec, vm: recorded } });
      await expect(h.runtime.upsertInstance(upsertOpts)).rejects.toThrow(/unknown (desktop|boot disk type)/);
      expect(h.vm.start).not.toHaveBeenCalled();
    }
  });

  it("stops a suspended computer before giving it another desktop, so it boots into that desktop", async () => {
    let computer: GatewayVmDescription = { ...suspended, metadata: { ...suspended.metadata, "octogee-owner-uid": "UidA" } };
    const h = harness({ "glmGateways/b-x": { gatewayId: "b-x", runtime: "gce-vm", vmSpec: { ...spec, desktop: "x11" }, vm: recorded } }, {
      describe: vi.fn(async () => computer),
      stop: vi.fn(async () => { computer = { ...computer, status: "TERMINATED" }; }),
      bind: vi.fn(async (_name, _zone, input) => { computer = { ...computer, metadata: { ...computer.metadata, ...input.metadata } }; }),
      start: vi.fn(async () => { computer = { ...computer, status: "RUNNING" }; return { fellBackToStandard: false }; }),
    });
    await h.runtime.upsertInstance(upsertOpts);
    expect(h.vm.bind).toHaveBeenCalledWith(COMPUTER, "us-west1-b", expect.objectContaining({ metadata: expect.objectContaining({ "octogee-computer-desktop": "x11" }) }));
    expect(h.vm.stop.mock.invocationCallOrder[0]).toBeLessThan(h.vm.bind.mock.invocationCallOrder[0]);
    expect(h.vm.start).toHaveBeenCalledWith(COMPUTER, "us-west1-b");
    expect(h.vm.resume).not.toHaveBeenCalled();
  });

  it("stops a suspended computer bound to an earlier gateway before rebinding it to another desktop", async () => {
    let computer: GatewayVmDescription = { ...suspended, gatewayId: "b-old", metadata: { ...suspended.metadata, "gateway-id": "b-old", "octogee-owner-uid": "UidA" } };
    const h = harness({ "glmGateways/b-x": { gatewayId: "b-x", runtime: "gce-vm", vmSpec: { ...spec, desktop: "x11" } } }, {
      findByLabels: vi.fn(async () => computer),
      describe: vi.fn(async () => computer),
      stop: vi.fn(async () => { computer = { ...computer, status: "TERMINATED" }; }),
      bind: vi.fn(async (_name, _zone, input) => { computer = { ...computer, gatewayId: input.metadata["gateway-id"], labels: input.labels, metadata: { ...computer.metadata, ...input.metadata } }; }),
      start: vi.fn(async () => { computer = { ...computer, status: "RUNNING" }; return { fellBackToStandard: false }; }),
    });
    await h.runtime.upsertInstance(upsertOpts);
    expect(h.vm.stop.mock.invocationCallOrder[0]).toBeLessThan(h.vm.bind.mock.invocationCallOrder[0]);
    expect(h.vm.bind).toHaveBeenCalledWith(COMPUTER, "us-west1-b", expect.objectContaining({ metadata: expect.objectContaining({ "gateway-id": "b-x", "octogee-computer-desktop": "x11" }) }));
    expect(h.vm.start).toHaveBeenCalledWith(COMPUTER, "us-west1-b");
    expect(h.vm.resume).not.toHaveBeenCalled();
  });

  it("leaves a running computer's desktop for its next park", async () => {
    const h = harness({ "glmGateways/b-x": { gatewayId: "b-x", runtime: "gce-vm", vmSpec: { ...spec, desktop: "x11" }, vm: recorded } }, {
      describe: vi.fn(async () => ({ ...running, metadata: { ...running.metadata, "octogee-owner-uid": "UidA" } })),
    });
    await expect(h.runtime.upsertInstance(upsertOpts)).rejects.toThrow(/desktop omarchy.*x11.*pause and resume/);
    expect(h.vm.bind).not.toHaveBeenCalled();
    expect(h.vm.stop).not.toHaveBeenCalled();
  });

  it("moves a parked Spot computer to the recorded on-demand capacity before starting it", async () => {
    let computer = { ...stopped };
    const h = harness({ "glmGateways/b-x": { gatewayId: "b-x", runtime: "gce-vm", vmSpec: { ...spec, provisioningModel: "STANDARD" }, vm: recorded } }, {
      describe: vi.fn(async () => computer),
      setProvisioningModel: vi.fn(async (_name, _zone, provisioningModel) => { computer = { ...computer, provisioningModel }; }),
      start: vi.fn(async () => { computer = { ...computer, status: "RUNNING" }; return { fellBackToStandard: false }; }),
    });
    await h.runtime.upsertInstance(upsertOpts);
    expect(h.vm.setProvisioningModel).toHaveBeenCalledExactlyOnceWith(COMPUTER, "us-west1-b", "STANDARD");
    expect(h.vm.setProvisioningModel.mock.invocationCallOrder[0]).toBeLessThan(h.vm.start.mock.invocationCallOrder[0]);
    expect(h.docs["glmGateways/b-x"].vm).toMatchObject({ provisioningModel: "STANDARD", status: "RUNNING" });
  });

  it("stops a suspended Spot computer before moving it to on-demand capacity", async () => {
    let computer = { ...suspended };
    const h = harness({ "glmGateways/b-x": { gatewayId: "b-x", runtime: "gce-vm", vmSpec: { ...spec, provisioningModel: "STANDARD" }, vm: recorded } }, {
      describe: vi.fn(async () => computer),
      stop: vi.fn(async () => { computer = { ...computer, status: "TERMINATED" }; }),
      setProvisioningModel: vi.fn(async (_name, _zone, provisioningModel) => { computer = { ...computer, provisioningModel }; }),
      start: vi.fn(async () => { computer = { ...computer, status: "RUNNING" }; return { fellBackToStandard: false }; }),
    });
    await h.runtime.upsertInstance(upsertOpts);
    expect(h.vm.stop.mock.invocationCallOrder[0]).toBeLessThan(h.vm.setProvisioningModel.mock.invocationCallOrder[0]);
    expect(h.vm.setProvisioningModel.mock.invocationCallOrder[0]).toBeLessThan(h.vm.start.mock.invocationCallOrder[0]);
    expect(h.vm.resume).not.toHaveBeenCalled();
  });

  it("refuses to start a parked computer whose provisioning model did not converge", async () => {
    const h = harness({ "glmGateways/b-x": { gatewayId: "b-x", runtime: "gce-vm", vmSpec: { ...spec, provisioningModel: "STANDARD" }, vm: recorded } }, {
      describe: vi.fn(async () => stopped),
    });
    await expect(h.runtime.upsertInstance(upsertOpts)).rejects.toThrow(/provisioning model did not converge to STANDARD/);
    expect(h.vm.start).not.toHaveBeenCalled();
  });

  it("leaves a running Spot computer's capacity for its next park", async () => {
    const h = harness({ "glmGateways/b-x": { gatewayId: "b-x", runtime: "gce-vm", vmSpec: { ...spec, provisioningModel: "STANDARD" }, vm: recorded } });
    await h.runtime.upsertInstance(upsertOpts);
    expect(h.vm.setProvisioningModel).not.toHaveBeenCalled();
    expect(h.vm.stop).not.toHaveBeenCalled();
    expect(h.log).toHaveBeenCalledWith(expect.stringMatching(/b-x: tier capacity will apply on the next resume/));
  });

  it("applies the cheaper machine after parking while retaining a larger home", async () => {
    let computer = { ...stopped };
    const h = harness({ "glmGateways/b-x": { gatewayId: "b-x", runtime: "gce-vm", vmSpec: { ...spec, machineType: "n2-standard-2", homeDiskSizeGb: 10 }, vm: recorded } }, {
      describe: vi.fn(async () => computer),
      stop: vi.fn(async () => { computer = { ...computer, status: "TERMINATED" }; }),
      setMachineType: vi.fn(async (_name, _zone, machineType) => { computer = { ...computer, machineType }; }),
      start: vi.fn(async () => { computer = { ...computer, status: "RUNNING" }; return { fellBackToStandard: false }; }),
    });
    await h.runtime.upsertInstance(upsertOpts);
    expect(h.vm.stop).not.toHaveBeenCalled();
    expect(h.vm.expandHome).not.toHaveBeenCalled();
    expect(h.docs["users/UidA"].provisioning.homeCapacity).toMatchObject({ desiredGiB: 10, allocatedGiB: 30, status: "shrink-pending" });
    expect(h.vm.delete).not.toHaveBeenCalled();
  });

  it("expands a parked home before restarting to grow its filesystem", async () => {
    let computer = { ...stopped };
    const h = harness({ "glmGateways/b-x": { gatewayId: "b-x", runtime: "gce-vm", vmSpec: { ...spec, homeDiskSizeGb: 100 }, vm: recorded } }, {
      describe: vi.fn(async () => computer),
      stop: vi.fn(async () => { computer = { ...computer, status: "TERMINATED" }; }),
      start: vi.fn(async () => { computer = { ...computer, status: "RUNNING" }; return { fellBackToStandard: false }; }),
    });
    await h.runtime.upsertInstance(upsertOpts);
    expect(h.vm.expandHome).toHaveBeenCalledWith(expect.objectContaining({ id: "777" }), "UidA", 100);
    expect(h.vm.stop).not.toHaveBeenCalled();
    expect(h.vm.expandHome.mock.invocationCallOrder[0]).toBeLessThan(h.vm.start.mock.invocationCallOrder[0]);
    expect(h.docs["users/UidA"].provisioning.homeCapacity).toMatchObject({ desiredGiB: 100, allocatedGiB: 100, status: "ready" });
    expect(h.vm.delete).not.toHaveBeenCalled();
  });

  it.each([
    { machineType: spec.machineType, homeDiskSizeGb: 100, status: "grow-pending" },
    { machineType: "n2-standard-2", homeDiskSizeGb: 10, status: "shrink-pending" },
  ])("defers running tier capacity changes until resume: $status", async ({ machineType, homeDiskSizeGb, status }) => {
    const h = harness({ "glmGateways/b-x": { gatewayId: "b-x", runtime: "gce-vm", vmSpec: { ...spec, machineType, homeDiskSizeGb }, vm: recorded } }, {
      describe: vi.fn(async () => running),
    });
    await h.runtime.upsertInstance(upsertOpts);
    expect(h.vm.stop).not.toHaveBeenCalled();
    expect(h.vm.start).not.toHaveBeenCalled();
    expect(h.vm.expandHome).not.toHaveBeenCalled();
    expect(h.vm.setMachineType).not.toHaveBeenCalled();
    expect(h.docs["users/UidA"].provisioning.homeCapacity).toMatchObject({ desiredGiB: homeDiskSizeGb, allocatedGiB: 30, status, applyOnResume: true });
  });

  it("repairs a parked computer's identity scopes before starting it without replacing its disk", async () => {
    const old = { ...stopped, serviceAccounts: [{ email: spec.serviceAccountEmail, scopes: ["https://www.googleapis.com/auth/cloud-platform"] }] };
    const h = harness({ "glmGateways/b-x": { gatewayId: "b-x", runtime: "gce-vm", vm: recorded } }, {
      describe: vi.fn(async () => running).mockResolvedValueOnce(old),
      retainHome: vi.fn(async () => ({ projectId: "octogee-test", zone: "us-west1-b", name: "computer-home", id: "777", sizeGb: 30, diskType: "pd-ssd" as const, source: "projects/octogee-test/zones/us-west1-b/disks/computer-home" })),
    verifyDetachedHome: vi.fn(async () => {}),
    deleteRetainedHome: vi.fn(async () => {}),
    deleteRetainingHome: vi.fn(async () => {}),
    setServiceAccount: vi.fn(async () => {}),
    });
    await h.runtime.upsertInstance(upsertOpts);
    expect(h.vm.setServiceAccount).toHaveBeenCalledWith(COMPUTER, "us-west1-b", spec.serviceAccountEmail);
    expect(h.vm.setServiceAccount.mock.invocationCallOrder[0]).toBeLessThan(h.vm.start.mock.invocationCallOrder[0]);
    expect(h.vm.delete).not.toHaveBeenCalled();
    expect(h.vm.create).not.toHaveBeenCalled();
  });

  it("rejects a running computer with stale scopes before publishing a new gateway image", async () => {
    const old = { ...running, serviceAccounts: [{ email: spec.serviceAccountEmail, scopes: [] }] };
    const h = harness({ "glmGateways/b-x": { gatewayId: "b-x", runtime: "gce-vm", vm: recorded } }, {
      describe: vi.fn(async () => old),
      retainHome: vi.fn(async () => ({ projectId: "octogee-test", zone: "us-west1-b", name: "computer-home", id: "777", sizeGb: 30, diskType: "pd-ssd" as const, source: "projects/octogee-test/zones/us-west1-b/disks/computer-home" })),
    verifyDetachedHome: vi.fn(async () => {}),
    deleteRetainedHome: vi.fn(async () => {}),
    deleteRetainingHome: vi.fn(async () => {}),
    setServiceAccount: vi.fn(async () => {}),
    });
    await expect(h.runtime.upsertInstance({ ...upsertOpts, imageTag: "main.new-agent" })).rejects.toThrow(/pause and resume/i);
    expect(h.vm.stop).not.toHaveBeenCalled();
    expect(h.vm.bind).not.toHaveBeenCalled();
    expect(h.vm.setServiceAccount).not.toHaveBeenCalled();
    expect(h.docs["glmGateways/b-x/vm/runtime"]).toBeUndefined();
  });

  it("repairs stale scopes through pause and resume while retaining the same Builder computer", async () => {
    let description: GatewayVmDescription = { ...running, serviceAccounts: [{ email: spec.serviceAccountEmail, scopes: ["https://www.googleapis.com/auth/cloud-platform"] }] };
    const h = harness({ "glmGateways/b-x": { gatewayId: "b-x", runtime: "gce-vm", vm: recorded } }, {
      describe: vi.fn(async () => description),
      suspend: vi.fn(async () => { description = { ...description, status: "SUSPENDED" }; }),
      stop: vi.fn(async () => { description = { ...description, status: "TERMINATED" }; }),
      retainHome: vi.fn(async () => ({ projectId: "octogee-test", zone: "us-west1-b", name: "computer-home", id: "777", sizeGb: 30, diskType: "pd-ssd" as const, source: "projects/octogee-test/zones/us-west1-b/disks/computer-home" })),
    verifyDetachedHome: vi.fn(async () => {}),
    deleteRetainedHome: vi.fn(async () => {}),
    deleteRetainingHome: vi.fn(async () => {}),
    setServiceAccount: vi.fn(async () => { description = { ...description, serviceAccounts: running.serviceAccounts }; }),
      start: vi.fn(async () => { description = { ...description, status: "RUNNING" }; return { fellBackToStandard: false }; }),
    });
    await h.runtime.upsertInstance({ ...upsertOpts, replicas: 0 });
    expect(h.docs["glmGateways/b-x"].vm).toMatchObject({ instanceId: "4242", status: "SUSPENDED", stopReason: "operator" });
    expect(h.vm.setServiceAccount).not.toHaveBeenCalled();
    expect(h.vm.start).not.toHaveBeenCalled();
    await h.runtime.upsertInstance(upsertOpts);
    expect(h.vm.setServiceAccount).toHaveBeenCalledWith(COMPUTER, "us-west1-b", spec.serviceAccountEmail);
    expect(h.vm.stop.mock.invocationCallOrder[0]).toBeLessThan(h.vm.setServiceAccount.mock.invocationCallOrder[0]);
    expect(h.vm.setServiceAccount.mock.invocationCallOrder[0]).toBeLessThan(h.vm.start.mock.invocationCallOrder[0]);
    expect(h.docs["glmGateways/b-x"].vm).toMatchObject({ instanceId: "4242", status: "RUNNING", stopReason: null });
    expect(h.vm.delete).not.toHaveBeenCalled();
    expect(h.vm.create).not.toHaveBeenCalled();
  });

  it("updates the bootstrap image on an existing gateway without restarting its computer", async () => {
    const h = harness({ "glmGateways/b-x": { gatewayId: "b-x", runtime: "gce-vm", vm: recorded } });
    await h.runtime.upsertInstance({ ...upsertOpts, imageTag: "main.new-agent" });
    expect(h.vm.bind).toHaveBeenCalledWith(COMPUTER, running.zone, expect.objectContaining({
      metadata: expect.objectContaining({ "gateway-image": `${upsertOpts.imageRepository}:main.new-agent` }),
    }));
    expect(h.vm.stop).not.toHaveBeenCalled();
  });
  it("renders the chart through helm template, stores the bundle and instance, creates the VM, and publishes routes", async () => {
    const h = harness({ "glmGateways/b-x": { docKind: "runtime", gatewayId: "b-x", runtime: "gce-vm" } });

    await deployCreatingComputer(h);

    expect(h.helmCalls[0].slice(0, 3)).toEqual(["template", "octogee-gw-b-x", "/chart"]);
    expect(h.helmCalls[0]).not.toContain("--wait");
    expect(h.helmCalls[0].join(" ")).toContain("--set computerDesktop=omarchy --set runtimeKind=gce-vm");
    const bundle = h.docs["glmGateways/b-x/vm/runtime"] as Record<string, unknown>;
    expect(bundle.gatewayId).toBe("b-x");
    expect(bundle.builderIdentity).toEqual({ ownerUid: "UidA", builderSlug: "mama" });
    expect((bundle.containers as Array<{ name: string; env: Record<string, string> }>)[0].env.OPENCLAW_GATEWAY_TOKEN).toBe("gateway-auth-token-b-x-value");
    expect(bundle.hostAliases).toEqual({
      "octogee-api.octogee-test.svc.cluster.local": "172.20.7.7",
      "mattermost.octogee-test.svc.cluster.local": "172.20.7.7",
    });
    const glm = h.docs["glmGateways/b-x"];
    expect(glm.vmInstance).toMatchObject({ enabled: true, gatewayId: "b-x", image: { repository: upsertOpts.imageRepository, tag: "main.abc123" }, chartFingerprint: "cf", ownerUid: "UidA", builderSlug: "mama" });
    expect(JSON.stringify(glm.vmInstance)).not.toContain("undefined");
    expect(h.vm.findByLabels).toHaveBeenCalledWith(OWNER_LABELS);
    expect(h.vm.find).not.toHaveBeenCalled();
    expect(h.vm.create).toHaveBeenCalledWith(expect.objectContaining({
      instanceName: COMPUTER, zones: ["us-west1-b"], provisioningModel: "SPOT",
      labels: expect.objectContaining({ "octogee-gateway-id": "b-x", "octogee-owner-uid": "uida" }),
      metadata: { "gateway-id": "b-x", "octogee-owner-uid": "UidA", "octogee-environment": "test", "gateway-image": `${upsertOpts.imageRepository}:main.abc123`, "octogee-api-url": "http://172.20.7.7:3001", "octogee-computer-desktop": "omarchy" },
    }));
    expect(glm.vm).toEqual({ ...recorded, updatedAt: 1_000 });
    const apply = h.kubectlCalls.find((c) => c.args[0] === "apply");
    expect(JSON.parse(apply!.stdin!)).toMatchObject({ kind: "ConfigMap", metadata: { name: "octogee-vm-routes" }, data: { "routes.json": JSON.stringify({ "b-x": "172.20.0.9" }) } });
  });

  it("places a cold computer in the configured zones, least-occupied first, even when the gateway recorded an older single-zone spec", async () => {
    const zones = ["us-central1-b", "us-central1-c", "us-central1-f"];
    const { zones: _zones, ...shape } = spec;
    const recordedSpec = { ...shape, machineType: "n2-standard-8", zone: "us-central1-a", fallbackZones: zones };
    const neighbour = { ...running, name: "octogee-computer-test-uidb", zone: "us-central1-b", labels: { ...OWNER_LABELS, "octogee-owner-uid": "uidb" } };
    const h = harness(
      { "glmGateways/b-x": { docKind: "runtime", gatewayId: "b-x", runtime: "gce-vm", vmSpec: recordedSpec } },
      { list: vi.fn(async () => [neighbour]) },
      "172.20.7.7", {}, { vmSpec: { ...spec, zones } },
    );

    await deployCreatingComputer(h);

    expect(h.vm.list).toHaveBeenCalledWith({ labels: { "octogee-environment": "test", purpose: "octogee-computer" } });
    const created = vi.mocked(h.vm.create).mock.calls[0][0];
    expect(created).toMatchObject({ instanceName: COMPUTER, machineType: "n2-standard-8", zones: ["us-central1-c", "us-central1-f", "us-central1-b"] });
    expect(created).not.toHaveProperty("zone");
    expect(created).not.toHaveProperty("fallbackZones");
    expect(h.docs["glmGateways/b-x"].vmSpec).toMatchObject({ machineType: "n2-standard-8", zones });
  });

  it("reuses a running VM, restarts a stopped one, and refuses to render without the bridge IP", async () => {
    const existing = { docKind: "runtime", gatewayId: "b-x", runtime: "gce-vm", vm: { ...recorded } };
    const reuse = harness({ "glmGateways/b-x": { ...existing } });
    await reuse.runtime.upsertInstance(upsertOpts);
    expect(reuse.vm.create).not.toHaveBeenCalled();
    expect(reuse.vm.findByLabels).not.toHaveBeenCalled();
    expect(reuse.vm.list).not.toHaveBeenCalled();
    expect(reuse.vm.stop).not.toHaveBeenCalled();
    expect(reuse.vm.start).not.toHaveBeenCalled();

    const parked = harness({ "glmGateways/b-x": { ...existing, vm: { ...recorded, status: "TERMINATED", internalIp: null, stopReason: "idle" } } }, {
      describe: vi.fn(async () => running).mockResolvedValueOnce(stopped),
      start: vi.fn(async () => ({ fellBackToStandard: true })),
    });
    await parked.runtime.upsertInstance(upsertOpts);
    expect(parked.vm.start).toHaveBeenCalledWith(COMPUTER, "us-west1-b");
    expect(parked.docs["glmGateways/b-x"].vm).toEqual({ ...recorded, updatedAt: 1_000 });
    expect(parked.log).toHaveBeenCalledWith(expect.stringMatching(/started octogee-computer-test-uida -> RUNNING \(on-demand fallback\)/));
    expect(parked.routesPublished().at(-1)).toEqual({ "b-x": "172.20.0.9" });

    const noBridge = harness({ "glmGateways/b-x": { ...existing } }, {}, "");
    await expect(noBridge.runtime.upsertInstance(upsertOpts)).rejects.toThrow(/no internal load balancer IP/);
    expect(noBridge.docs["glmGateways/b-x/vm/runtime"]).toBeUndefined();
  });

  it("records the deployment only after the computer and its route exist, so a failed allocation is retried", async () => {
    const gatewayDoc = { docKind: "runtime", gatewayId: "b-x", runtime: "gce-vm" };
    const create = vi.fn(async () => ({ description: running, provisioningModel: "SPOT" as const, fellBackToStandard: false, alreadyExisted: false }))
      .mockRejectedValueOnce(new Error("ZONE_RESOURCE_POOL_EXHAUSTED"));
    const h = harness({ "glmGateways/b-x": { ...gatewayDoc } }, { create });

    await createComputer(h);
    expect(h.log).toHaveBeenCalledWith(expect.stringMatching(/⚠ b-x: creating octogee-computer-test-uida failed: ZONE_RESOURCE_POOL_EXHAUSTED/));
    expect(h.docs["glmGateways/b-x/vm/runtime"]).toBeUndefined();
    expect(h.docs["glmGateways/b-x"].vmInstance).toBeUndefined();
    expect(h.docs["glmGateways/b-x"].vm).toBeUndefined();
    expect(await h.runtime.readDeployedInstance({ namespace: "octogee-test", gatewayId: "b-x" })).toBeNull();
    expect(h.waits).toEqual([30_000]);

    await deployCreatingComputer(h);
    expect(create).toHaveBeenCalledTimes(2);
    expect(h.docs["glmGateways/b-x"].vmInstance).toMatchObject({ gatewayId: "b-x", deploymentIntentFingerprint: "dif" });
    expect(h.docs["glmGateways/b-x"].vm).toEqual({ ...recorded, updatedAt: 31_000 });

    const routesFail = harness({ "glmGateways/b-x": { ...gatewayDoc } }, {}, "172.20.7.7", {}, { applyFails: true });
    await createComputer(routesFail);
    await expect(routesFail.runtime.upsertInstance(upsertOpts)).rejects.toThrow(/configmaps is forbidden/);
    expect(routesFail.docs["glmGateways/b-x"].vm).toEqual({ ...recorded, updatedAt: 1_000 });
    expect(routesFail.docs["glmGateways/b-x"].vmInstance).toBeUndefined();
  });

  it("pauses by suspending the Builder's running computer instead of claiming or starting one, and records the paused deployment", async () => {
    const paused = { ...upsertOpts, replicas: 0 };
    let current = running;
    const withComputer = harness({ "glmGateways/b-x": { docKind: "runtime", gatewayId: "b-x", runtime: "gce-vm", vm: { ...recorded } } }, {
      describe: vi.fn(async () => current),
      suspend: vi.fn(async () => { current = suspended; }),
      resume: vi.fn(async () => { current = running; return { fellBackToStandard: false }; }),
    });
    await withComputer.runtime.upsertInstance(paused);
    expect(withComputer.vm.suspend).toHaveBeenCalledWith(COMPUTER, "us-west1-b");
    expect(withComputer.vm.stop).not.toHaveBeenCalled();
    expect(withComputer.vm.start).not.toHaveBeenCalled();
    expect(withComputer.vm.create).not.toHaveBeenCalled();
    expect(withComputer.vm.findByLabels).not.toHaveBeenCalled();
    expect(withComputer.vm.list).not.toHaveBeenCalled();
    expect(withComputer.docs["glmGateways/b-x"].vm).toEqual({ ...recorded, status: "SUSPENDED", internalIp: null, stopReason: "operator", updatedAt: 1_000 });
    expect(withComputer.docs["glmGateways/b-x"].vmInstance).toMatchObject({ gatewayId: "b-x", replicas: 0 });
    expect(withComputer.docs["glmGateways/b-x/vm/runtime"]).toBeDefined();
    expect(withComputer.routesPublished().at(-1)).toEqual({});
    expect(withComputer.log).toHaveBeenCalledWith(expect.stringMatching(/b-x: suspended octogee-computer-test-uida for operator -> SUSPENDED; boot and home disks retained/));

    await withComputer.runtime.recoverUnreachable("b-x");
    expect(withComputer.vm.resume).not.toHaveBeenCalled();
    expect(withComputer.vm.start).not.toHaveBeenCalled();

    await withComputer.runtime.upsertInstance({ ...upsertOpts, replicas: 1 });
    expect(withComputer.vm.resume).toHaveBeenCalledWith(COMPUTER, "us-west1-b");
    expect(withComputer.vm.start).not.toHaveBeenCalled();
    expect(withComputer.log).toHaveBeenCalledWith(expect.stringMatching(/b-x: resumed octogee-computer-test-uida -> RUNNING/));
    expect(withComputer.docs["glmGateways/b-x"].vm).toEqual({ ...recorded, updatedAt: 1_000 });
    expect(withComputer.docs["glmGateways/b-x"].vmInstance).toMatchObject({ replicas: 1 });
    expect(withComputer.routesPublished().at(-1)).toEqual({ "b-x": "172.20.0.9" });

    const alreadyStopped = harness({ "glmGateways/b-x": { docKind: "runtime", gatewayId: "b-x", runtime: "gce-vm", vm: { ...recorded, status: "TERMINATED", internalIp: null, stopReason: "idle" } } }, {
      describe: vi.fn(async () => stopped),
    });
    await alreadyStopped.runtime.upsertInstance(paused);
    expect(alreadyStopped.vm.stop).not.toHaveBeenCalled();
    expect(alreadyStopped.vm.start).not.toHaveBeenCalled();
    expect(alreadyStopped.docs["glmGateways/b-x"].vm).toEqual({ ...recorded, status: "TERMINATED", internalIp: null, stopReason: "operator", updatedAt: 1_000 });
    expect(alreadyStopped.docs["glmGateways/b-x"].vmInstance).toMatchObject({ replicas: 0 });

    const vanished = harness({ "glmGateways/b-x": { docKind: "runtime", gatewayId: "b-x", runtime: "gce-vm", vm: { ...recorded } } }, {
      describe: vi.fn(async () => null),
    });
    await vanished.runtime.upsertInstance(paused);
    expect(vanished.vm.stop).not.toHaveBeenCalled();
    expect(vanished.docs["glmGateways/b-x"].vm).toEqual(recorded);
    expect(vanished.docs["glmGateways/b-x"].vmInstance).toMatchObject({ replicas: 0 });

    const noComputer = harness({ "glmGateways/b-x": { docKind: "runtime", gatewayId: "b-x", runtime: "gce-vm" } });
    await noComputer.runtime.upsertInstance(paused);
    expect(noComputer.vm.describe).not.toHaveBeenCalled();
    expect(noComputer.vm.findByLabels).not.toHaveBeenCalled();
    expect(noComputer.vm.list).not.toHaveBeenCalled();
    expect(noComputer.vm.create).not.toHaveBeenCalled();
    expect(noComputer.vm.stop).not.toHaveBeenCalled();
    expect(noComputer.docs["glmGateways/b-x"].vm).toBeUndefined();
    expect(noComputer.docs["glmGateways/b-x"].vmInstance).toMatchObject({ replicas: 0 });
  });

  it("retains an absent source identity while a native return checkpoint remains held", async () => {
    const vmHome = { returnOperationId: "return-one", checkpointRequestedAt: 900, parkRequestedAt: 900 };
    const h = harness({ "glmGateways/b-x": { runtime: "gce-vm", vm: { ...recorded }, vmHome } }, {
      describe: vi.fn(async () => null),
    });
    await h.runtime.upsertInstance({ ...upsertOpts, replicas: 0 });
    expect(h.vm.stop).not.toHaveBeenCalled();
    expect(h.docs["glmGateways/b-x"].vm).toEqual(recorded);
    expect(h.docs["glmGateways/b-x"].vmHome).toEqual(vmHome);
    delete (h.docs["glmGateways/b-x"].vmHome as Record<string, unknown>).checkpointRequestedAt;
    await h.runtime.upsertInstance({ ...upsertOpts, replicas: 0 });
    expect(h.docs["glmGateways/b-x"].vm).toEqual(recorded);
  });

  it.each(["b-x", null])("never stops a same-name replacement computer while pausing (binding %s)", async gatewayId => {
    const h = harness({ "glmGateways/b-x": { runtime: "gce-vm", vm: { ...recorded } } }, {
      describe: vi.fn(async () => ({ ...running, instanceId: "replacement", gatewayId })),
    });
    await expect(h.runtime.upsertInstance({ ...upsertOpts, replicas: 0 })).rejects.toThrow(/identity changed/);
    expect(h.vm.stop).not.toHaveBeenCalled();
    expect(h.docs["glmGateways/b-x"].vm).toEqual(recorded);
  });

  it("binds the Builder's parked computer to the new lease's gateway and starts it", async () => {
    const parkedElsewhere = { ...stopped, gatewayId: "b-old" };
    const h = harness({ "glmGateways/b-x": { docKind: "runtime", gatewayId: "b-x", runtime: "gce-vm" } }, {
      findByLabels: vi.fn(async () => parkedElsewhere),
      describe: vi.fn(async () => running).mockResolvedValueOnce(parkedElsewhere),
    });

    await h.runtime.upsertInstance(upsertOpts);

    expect(h.vm.findByLabels).toHaveBeenCalledWith(OWNER_LABELS);
    expect(h.vm.list).not.toHaveBeenCalled();
    expect(h.vm.create).not.toHaveBeenCalled();
    expect(h.vm.stop).not.toHaveBeenCalled();
    expect(h.vm.bind).toHaveBeenCalledWith(COMPUTER, "us-west1-b", {
      labels: { "octogee-gateway-id": "b-x", "octogee-environment": "test", purpose: "octogee-computer", "octogee-owner-uid": "uida" },
      metadata: { "gateway-id": "b-x", "octogee-owner-uid": "UidA", "octogee-environment": "test", "gateway-image": `${upsertOpts.imageRepository}:main.abc123`, "octogee-api-url": "http://172.20.7.7:3001", "octogee-computer-desktop": "omarchy" },
    });
    expect(h.vm.start).toHaveBeenCalledWith(COMPUTER, "us-west1-b");
    expect(h.docs["glmGateways/b-x"].vm).toEqual({ ...recorded, updatedAt: 1_000 });
    expect(h.log).toHaveBeenCalledWith(expect.stringMatching(/bound octogee-computer-test-uida to b-x \(was b-old\)/));
    expect(h.routesPublished().at(-1)).toEqual({ "b-x": "172.20.0.9" });
  });

  it("stops a running computer before rebinding it so the agent boots into the new gateway", async () => {
    const runningElsewhere = { ...running, gatewayId: "b-old" };
    const h = harness({ "glmGateways/b-x": { docKind: "runtime", gatewayId: "b-x", runtime: "gce-vm" } }, {
      findByLabels: vi.fn(async () => runningElsewhere),
      describe: vi.fn(async () => running).mockResolvedValueOnce({ ...stopped, gatewayId: "b-old" }).mockResolvedValueOnce(stopped),
    });

    await h.runtime.upsertInstance(upsertOpts);

    expect(h.vm.stop).toHaveBeenCalledWith(COMPUTER, "us-west1-b");
    expect(h.vm.bind).toHaveBeenCalled();
    expect(h.vm.start).toHaveBeenCalledWith(COMPUTER, "us-west1-b");
    expect(h.vm.stop.mock.invocationCallOrder[0]).toBeLessThan(h.vm.bind.mock.invocationCallOrder[0]);
    expect(h.vm.bind.mock.invocationCallOrder[0]).toBeLessThan(h.vm.start.mock.invocationCallOrder[0]);
  });

  it.each(["RUNNING", "STOPPING", "missing", "recreated"])("does not rebind after stop when the observed computer is %s", async (status) => {
    const previous = { ...running, gatewayId: "b-old" };
    const observed = status === "missing" ? null : { ...previous, status: status === "recreated" ? "TERMINATED" : status,
      instanceId: status === "recreated" ? "4243" : previous.instanceId };
    const h = harness({ "glmGateways/b-x": { docKind: "runtime", gatewayId: "b-x", runtime: "gce-vm" } }, {
      findByLabels: vi.fn(async () => previous), describe: vi.fn(async () => observed),
    });
    await expect(h.runtime.upsertInstance(upsertOpts)).rejects.toThrow(/verified stopped computer/);
    expect(h.vm.stop).toHaveBeenCalledOnce();
    expect(h.vm.bind).not.toHaveBeenCalled();
    expect(h.vm.setServiceAccount).not.toHaveBeenCalled();
    expect(h.vm.start).not.toHaveBeenCalled();
    expect(h.docs["glmGateways/b-x"].vm).toBeUndefined();
  });

  it.each(["octogee-owner-uid", "octogee-environment", "purpose"])("does not overwrite changed %s custody during a stop/rebind", async key => {
    const previous = { ...running, gatewayId: "b-old", labels: { ...running.labels, ...OWNER_LABELS } };
    const observed = { ...previous, status: "TERMINATED", labels: { ...previous.labels, [key]: "other-custody" } };
    const h = harness({ "glmGateways/b-x": { docKind: "runtime", gatewayId: "b-x", runtime: "gce-vm" } }, {
      findByLabels: vi.fn(async () => previous), describe: vi.fn(async () => observed),
    });
    await expect(h.runtime.upsertInstance(upsertOpts)).rejects.toThrow(/verified stopped computer/);
    expect(h.vm.bind).not.toHaveBeenCalled();
    expect(h.vm.start).not.toHaveBeenCalled();
  });

  it("refuses to bind while another gateway record still holds the computer", async () => {
    const h = harness({
      "glmGateways/b-x": { docKind: "runtime", gatewayId: "b-x", runtime: "gce-vm" },
      "glmGateways/b-old": { docKind: "runtime", gatewayId: "b-old", runtime: "gce-vm", vm: { ...recorded, status: "TERMINATED", stopReason: "idle" } },
    }, { findByLabels: vi.fn(async () => ({ ...stopped, gatewayId: "b-old" })) });

    await expect(h.runtime.upsertInstance(upsertOpts)).rejects.toThrow(/octogee-computer-test-uida is still recorded by gateway b-old/);

    expect(h.vm.bind).not.toHaveBeenCalled();
    expect(h.vm.start).not.toHaveBeenCalled();
    expect(h.docs["glmGateways/b-x"].vm).toBeUndefined();
  });

  it("requires an owner and waits out a computer Compute is still stopping", async () => {
    const ownerless = harness({ "glmGateways/b-x": { docKind: "runtime", gatewayId: "b-x", runtime: "gce-vm" } });
    await expect(ownerless.runtime.upsertInstance({ ...upsertOpts, builderIdentity: undefined })).rejects.toThrow(/needs an owner/);
    expect(ownerless.vm.findByLabels).not.toHaveBeenCalled();
    expect(ownerless.vm.list).not.toHaveBeenCalled();

    const stopping = harness({ "glmGateways/b-x": { docKind: "runtime", gatewayId: "b-x", runtime: "gce-vm", vm: { ...recorded } } }, {
      describe: vi.fn(async () => ({ ...running, status: "STOPPING" })),
    });
    await expect(stopping.runtime.upsertInstance(upsertOpts)).rejects.toThrow(/still stopping/);
    expect(stopping.vm.start).not.toHaveBeenCalled();
  });
});

describe("createVmGatewayRuntime creating a fresh computer", () => {
  const otherBuilder = { ...upsertOpts, gatewayId: "b-y", builderIdentity: { ownerUid: "UidB", builderSlug: "papa" } };

  function heldInserts() {
    const finish = new Map<string, (outcome: GatewayVmDescription | Error) => void>();
    const create = vi.fn((input: CreateGatewayVmInput) => new Promise<CreateGatewayVmResult>((resolve, reject) => {
      finish.set(input.labels["octogee-owner-uid"], (outcome) => outcome instanceof Error
        ? reject(outcome)
        : resolve({ description: outcome, provisioningModel: "SPOT", fellBackToStandard: false, alreadyExisted: false }));
    }));
    return { create, finish };
  }

  function settledOrWaiting(work: Promise<unknown>): Promise<unknown> {
    return Promise.race([
      work.then(() => "deployed", (error: unknown) => error),
      new Promise((resolve) => setTimeout(() => resolve("still waiting on the insert"), 200)),
    ]);
  }

  it("returns while Compute inserts the computer, so another Builder's converge starts its own insert, then adopts the computer", async () => {
    const { create, finish } = heldInserts();
    const h = harness({
      "glmGateways/b-x": { docKind: "runtime", gatewayId: "b-x", runtime: "gce-vm" },
      "glmGateways/b-y": { docKind: "runtime", gatewayId: "b-y", runtime: "gce-vm" },
    }, { create });

    expect(await settledOrWaiting(h.runtime.upsertInstance(upsertOpts))).toMatchObject({ name: "ComputerCreationPendingError" });
    expect(await settledOrWaiting(h.runtime.upsertInstance(otherBuilder))).toMatchObject({ name: "ComputerCreationPendingError" });
    expect(await settledOrWaiting(h.runtime.upsertInstance(upsertOpts))).toMatchObject({ name: "ComputerCreationPendingError" });
    expect(create.mock.calls.map(([input]) => input.labels["octogee-owner-uid"])).toEqual(["uida", "uidb"]);
    expect(h.docs["glmGateways/b-x"].vm).toBeUndefined();
    expect(h.docs["glmGateways/b-x"].vmInstance).toBeUndefined();
    expect(h.docs["glmGateways/b-x/vm/runtime"]).toBeUndefined();
    expect(h.creationSettled).not.toHaveBeenCalled();

    finish.get("uida")!(running);
    await vi.waitFor(() => expect(h.creationSettled).toHaveBeenCalledWith("b-x"));
    expect(h.docs["glmGateways/b-x"].vm).toEqual({ ...recorded, updatedAt: 1_000 });
    expect(h.log).toHaveBeenCalledWith("[vm-gateway-runtime] b-x: created octogee-computer-test-uida in us-west1-b (SPOT)");

    await h.runtime.upsertInstance(upsertOpts);
    expect(create).toHaveBeenCalledTimes(2);
    expect(h.docs["glmGateways/b-x"].vmInstance).toMatchObject({ gatewayId: "b-x", ownerUid: "UidA" });
    expect((h.docs["glmGateways/b-x/vm/runtime"] as Record<string, unknown>).gatewayId).toBe("b-x");
    expect(h.routesPublished().at(-1)).toEqual({ "b-x": "172.20.0.9" });
  });

  it("waits for a computer it is still creating before parking it, so retiring mid-insert parks the new computer", async () => {
    const { create, finish } = heldInserts();
    const h = harness({ "glmGateways/b-x": { docKind: "runtime", gatewayId: "b-x", runtime: "gce-vm" } }, {
      create, describe: vi.fn(async () => suspended).mockResolvedValueOnce(running),
    });
    expect(await settledOrWaiting(h.runtime.upsertInstance(upsertOpts))).toMatchObject({ name: "ComputerCreationPendingError" });

    await h.runtime.recoverUnreachable("b-x");
    const removing = h.runtime.removeInstance({ namespace: "octogee-test", gatewayId: "b-x" });
    expect(await settledOrWaiting(removing)).toBe("still waiting on the insert");
    expect(h.vm.suspend).not.toHaveBeenCalled();

    finish.get("uida")!(running);
    await removing;
    expect(h.vm.suspend).toHaveBeenCalledWith(COMPUTER, "us-west1-b");
    expect(h.docs["glmGateways/b-x"].vm).toMatchObject({ instanceName: COMPUTER, instanceId: "4242", status: "SUSPENDED", stopReason: "idle" });
    expect(h.log).not.toHaveBeenCalledWith(expect.stringMatching(/absent from Compute/));
  });

  it("reports a failed insert, reports it again until its backoff ends, then inserts again", async () => {
    const { create, finish } = heldInserts();
    let endBackoff!: () => void;
    const backoff = new Promise<void>((resolve) => { endBackoff = resolve; });
    const h = harness({ "glmGateways/b-x": { docKind: "runtime", gatewayId: "b-x", runtime: "gce-vm" } }, { create },
      "172.20.7.7", {}, { onWait: (ms) => (ms === 30_000 ? backoff : undefined) });
    expect(await settledOrWaiting(h.runtime.upsertInstance(upsertOpts))).toMatchObject({ name: "ComputerCreationPendingError" });

    finish.get("uida")!(new ComputeOperationError("insert octogee-computer-test-uida: ZONE_RESOURCE_POOL_EXHAUSTED: no capacity", ["ZONE_RESOURCE_POOL_EXHAUSTED"]));
    await vi.waitFor(() => expect(h.waits).toContain(30_000));
    expect(h.log).toHaveBeenCalledWith(expect.stringMatching(/⚠ b-x: creating octogee-computer-test-uida failed: insert octogee-computer-test-uida: ZONE_RESOURCE_POOL_EXHAUSTED/));
    await expect(h.runtime.upsertInstance(upsertOpts)).rejects.toThrow(/creating octogee-computer-test-uida failed: .*ZONE_RESOURCE_POOL_EXHAUSTED.*retrying after 30000ms/);
    expect(create).toHaveBeenCalledOnce();
    expect(h.creationSettled).not.toHaveBeenCalled();
    expect(h.docs["glmGateways/b-x"].vm).toBeUndefined();

    endBackoff();
    await vi.waitFor(() => expect(h.creationSettled).toHaveBeenCalledWith("b-x"));
    expect(await settledOrWaiting(h.runtime.upsertInstance(upsertOpts))).toMatchObject({ name: "ComputerCreationPendingError" });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("fails another gateway of the same owner loudly while the owner's computer is being created, so its converge is retried", async () => {
    const { create, finish } = heldInserts();
    const h = harness({
      "glmGateways/b-x": { docKind: "runtime", gatewayId: "b-x", runtime: "gce-vm" },
      "glmGateways/b-z": { docKind: "runtime", gatewayId: "b-z", runtime: "gce-vm" },
    }, { create });
    expect(await settledOrWaiting(h.runtime.upsertInstance(upsertOpts))).toMatchObject({ name: "ComputerCreationPendingError" });

    const sameOwner = await settledOrWaiting(h.runtime.upsertInstance({ ...upsertOpts, gatewayId: "b-z" }));
    expect(sameOwner).not.toBeInstanceOf(ComputerCreationPendingError);
    expect(sameOwner).toMatchObject({ message: "computer octogee-computer-test-uida is being created for b-x; retrying once it exists" });
    expect(create).toHaveBeenCalledOnce();
    finish.get("uida")!(running);
  });

  it("inserts one computer when two gateways of the same owner converge concurrently, failing the other loudly", async () => {
    const { create, finish } = heldInserts();
    const h = harness({
      "glmGateways/b-x": { docKind: "runtime", gatewayId: "b-x", runtime: "gce-vm" },
      "glmGateways/b-z": { docKind: "runtime", gatewayId: "b-z", runtime: "gce-vm" },
    }, { create });

    const [first, sameOwner] = await Promise.all([
      settledOrWaiting(h.runtime.upsertInstance(upsertOpts)),
      settledOrWaiting(h.runtime.upsertInstance({ ...upsertOpts, gatewayId: "b-z" })),
    ]);
    expect(create).toHaveBeenCalledOnce();
    expect(first).toMatchObject({ name: "ComputerCreationPendingError" });
    expect(sameOwner).toMatchObject({ message: "computer octogee-computer-test-uida is being created for b-x; retrying once it exists" });
    finish.get("uida")!(running);
  });

  it("stops a computer whose runtime record was deleted while Compute created it", async () => {
    const { create, finish } = heldInserts();
    const h = harness({ "glmGateways/b-x": { docKind: "runtime", gatewayId: "b-x", runtime: "gce-vm" } }, { create });
    expect(await settledOrWaiting(h.runtime.upsertInstance(upsertOpts))).toMatchObject({ name: "ComputerCreationPendingError" });

    delete h.docs["glmGateways/b-x"];
    finish.get("uida")!(running);
    await vi.waitFor(() => expect(h.creationSettled).toHaveBeenCalledWith("b-x"));
    expect(h.vm.stop).toHaveBeenCalledWith(COMPUTER, "us-west1-b");
    expect(h.docs["glmGateways/b-x"]).toBeUndefined();
    expect(h.log).toHaveBeenCalledWith("[vm-gateway-runtime] ⚠ b-x: created octogee-computer-test-uida in us-west1-b after its runtime record was deleted; stopped it for the owner's next Builder or erasure");
  });

  it("creates no computer for an owner while that owner's computer is being deleted", async () => {
    const { create, finish } = heldInserts();
    let endLookup!: (description: GatewayVmDescription | null) => void;
    const h = harness({ "glmGateways/b-x": { docKind: "runtime", gatewayId: "b-x", runtime: "gce-vm" } }, { create });
    vi.mocked(h.vm.findByLabels).mockImplementationOnce(() => new Promise((resolve) => { endLookup = resolve; }));

    const deleting = h.runtime.deleteComputer("UidA");
    await expect(h.runtime.upsertInstance(upsertOpts)).rejects.toThrow("the computer of UidA is being deleted; not creating one until the deletion finishes");
    expect(create).not.toHaveBeenCalled();

    endLookup(null);
    expect(await deleting).toBe(false);
    expect(await settledOrWaiting(h.runtime.upsertInstance(upsertOpts))).toMatchObject({ name: "ComputerCreationPendingError" });
    finish.get("uida")!(running);
  });

  it("waits for an owner's computer still being created before deleting it", async () => {
    const { create, finish } = heldInserts();
    const h = harness({ "glmGateways/b-x": { docKind: "runtime", gatewayId: "b-x", runtime: "gce-vm" } }, {
      create, findByLabels: vi.fn(async () => running),
    });
    vi.mocked(h.vm.findByLabels).mockResolvedValueOnce(null);
    expect(await settledOrWaiting(h.runtime.upsertInstance(upsertOpts))).toMatchObject({ name: "ComputerCreationPendingError" });

    const deleting = h.runtime.deleteComputer("UidA");
    expect(await settledOrWaiting(deleting)).toBe("still waiting on the insert");
    expect(h.vm.delete).not.toHaveBeenCalled();

    finish.get("uida")!(running);
    expect(await deleting).toBe(true);
    expect(h.vm.delete).toHaveBeenCalledWith(COMPUTER, "us-west1-b");
  });
});

describe("suspend parking", () => {
  const suspendedElsewhere = { ...suspended, gatewayId: "b-old" };

  it("falls back to stopping, loudly, when Compute rejects the suspend", async () => {
    let current = running;
    const h = harness({ "glmGateways/b-x": { docKind: "runtime", gatewayId: "b-x", runtime: "gce-vm", vm: { ...recorded } } }, {
      describe: vi.fn(async () => current),
      suspend: vi.fn(async () => { throw new Error("UNSUPPORTED_OPERATION: instance cannot be suspended"); }),
      stop: vi.fn(async () => { current = stopped; }),
    });
    await h.runtime.upsertInstance({ ...upsertOpts, replicas: 0 });
    expect(h.vm.suspend).toHaveBeenCalledWith(COMPUTER, "us-west1-b");
    expect(h.vm.stop).toHaveBeenCalledWith(COMPUTER, "us-west1-b");
    expect(h.vm.suspend.mock.invocationCallOrder[0]).toBeLessThan(h.vm.stop.mock.invocationCallOrder[0]);
    expect(h.docs["glmGateways/b-x"].vm).toEqual({ ...recorded, status: "TERMINATED", internalIp: null, stopReason: "operator", updatedAt: 1_000 });
    expect(h.log).toHaveBeenCalledWith(expect.stringMatching(/⚠ b-x: could not suspend octogee-computer-test-uida \(UNSUPPORTED_OPERATION: instance cannot be suspended\); stopping it instead/));
    expect(h.log).toHaveBeenCalledWith(expect.stringMatching(/b-x: stopped octogee-computer-test-uida for operator -> TERMINATED; boot and home disks retained/));
  });

  it("stops instead of suspending a computer whose return asked for a stop", async () => {
    let current = running;
    const stopOnPark = { operationId: "builder-return-b-x-g1", reason: "live source cleanup failed: unmount refused" };
    const h = harness({ "glmGateways/b-x": { docKind: "runtime", gatewayId: "b-x", runtime: "gce-vm", vm: { ...recorded }, vmStopOnPark: stopOnPark } }, {
      describe: vi.fn(async () => current),
      stop: vi.fn(async () => {
        expect(h.docs["glmGateways/b-x"].vmStopOnPark).toEqual({ ...stopOnPark, claimedAt: 1_000 });
        current = stopped;
      }),
    });
    await h.runtime.upsertInstance({ ...upsertOpts, replicas: 0 });
    expect(h.vm.suspend).not.toHaveBeenCalled();
    expect(h.vm.stop).toHaveBeenCalledExactlyOnceWith(COMPUTER, "us-west1-b");
    expect(h.docs["glmGateways/b-x"].vmStopOnPark).toBeUndefined();
    expect(h.docs["glmGateways/b-x"].vm).toEqual({ ...recorded, status: "TERMINATED", internalIp: null, stopReason: "operator", updatedAt: 1_000 });
    expect(h.log).toHaveBeenCalledWith(expect.stringMatching(/b-x: stopping octogee-computer-test-uida instead of suspending it for builder-return-b-x-g1: live source cleanup failed: unmount refused/));
  });

  it("suspends instead of stopping when the stop request it read was withdrawn before it acts", async () => {
    let current = running;
    const h = harness({ "glmGateways/b-x": { docKind: "runtime", gatewayId: "b-x", runtime: "gce-vm", vm: { ...recorded },
      vmStopOnPark: { operationId: "builder-return-b-x-g1", reason: "live source cleanup failed: earlier attempt" } } }, {
      describe: vi.fn(async () => {
        if (vi.mocked(h.vm.describe).mock.calls.length === 1) {
          const { vmStopOnPark: _withdrawn, ...rest } = h.docs["glmGateways/b-x"];
          h.docs["glmGateways/b-x"] = rest;
        }
        return current;
      }),
      suspend: vi.fn(async () => { current = suspended; }),
      stop: vi.fn(async () => { current = stopped; }),
    });
    await h.runtime.upsertInstance({ ...upsertOpts, replicas: 0 });
    expect(h.vm.stop).not.toHaveBeenCalled();
    expect(h.vm.suspend).toHaveBeenCalledWith(COMPUTER, "us-west1-b");
    expect(h.docs["glmGateways/b-x"].vm).toMatchObject({ status: "SUSPENDED", stopReason: "operator" });
    expect(h.log).toHaveBeenCalledWith(expect.stringMatching(/b-x: the stop request of builder-return-b-x-g1 was withdrawn; parking normally/));
  });

  it("honors a stop claimed by a pass that crashed before stopping, and deletes it once the stop is confirmed", async () => {
    let current = running;
    const h = harness({ "glmGateways/b-x": { docKind: "runtime", gatewayId: "b-x", runtime: "gce-vm", vm: { ...recorded },
      vmStopOnPark: { operationId: "builder-return-b-x-g1", reason: "live source cleanup failed", claimedAt: 500 } } }, {
      describe: vi.fn(async () => current),
      stop: vi.fn(async () => { current = stopped; }),
    });
    await h.runtime.upsertInstance({ ...upsertOpts, replicas: 0 });
    expect(h.vm.suspend).not.toHaveBeenCalled();
    expect(h.vm.stop).toHaveBeenCalledExactlyOnceWith(COMPUTER, "us-west1-b");
    expect(h.docs["glmGateways/b-x"].vmStopOnPark).toBeUndefined();
  });

  it("keeps a claimed stop across a wake even when its return finished", async () => {
    const claimed = { operationId: "builder-return-b-x-g1", reason: "live source cleanup failed", claimedAt: 500 };
    const h = harness({
      "glmGateways/b-x": { docKind: "runtime", gatewayId: "b-x", runtime: "gce-vm", vm: { ...recorded }, vmStopOnPark: claimed },
      "gateways/b-x": { gatewayClass: "builder", desiredStatus: "running" },
      "glmOperations/builder-return-b-x-g1": { kind: "migrate-customer", status: "failed" },
    });
    await h.runtime.upsertInstance(upsertOpts);
    expect(h.docs["glmGateways/b-x"].vmStopOnPark).toEqual(claimed);
  });

  it("stops an already suspended computer whose return asked for a stop", async () => {
    let current = suspended;
    const h = harness({ "glmGateways/b-x": { docKind: "runtime", gatewayId: "b-x", runtime: "gce-vm", vm: { ...recorded, status: "SUSPENDED", internalIp: null, stopReason: "operator" },
      vmStopOnPark: { operationId: "builder-return-b-x-g1", reason: "source computer is SUSPENDED" } } }, {
      describe: vi.fn(async () => current),
      stop: vi.fn(async () => { current = stopped; }),
    });
    await h.runtime.upsertInstance({ ...upsertOpts, replicas: 0 });
    expect(h.vm.suspend).not.toHaveBeenCalled();
    expect(h.vm.stop).toHaveBeenCalledWith(COMPUTER, "us-west1-b");
    expect(h.docs["glmGateways/b-x"].vm).toMatchObject({ status: "TERMINATED", stopReason: "operator" });
  });

  it("keeps a stop request whose return paused the gateway after the wake pass snapshotted running, so the next park stops", async () => {
    let current = running;
    const stopOnPark = { operationId: "builder-return-b-x-g2", reason: "live source cleanup failed: unmount refused" };
    const h = harness({
      "glmGateways/b-x": { docKind: "runtime", gatewayId: "b-x", runtime: "gce-vm", vm: { ...recorded }, vmStopOnPark: stopOnPark },
      "gateways/b-x": { gatewayClass: "builder", desiredStatus: "paused" },
      "glmOperations/builder-return-b-x-g2": { kind: "migrate-customer", status: "running" },
    }, {
      describe: vi.fn(async () => current),
      stop: vi.fn(async () => { current = stopped; }),
    });
    await h.runtime.upsertInstance(upsertOpts);
    expect(h.docs["glmGateways/b-x"].vmStopOnPark).toEqual(stopOnPark);
    await h.runtime.upsertInstance({ ...upsertOpts, replicas: 0 });
    expect(h.vm.suspend).not.toHaveBeenCalled();
    expect(h.vm.stop).toHaveBeenCalledWith(COMPUTER, "us-west1-b");
  });

  it("keeps a stop request whose return is still running even while the root reads running", async () => {
    const stopOnPark = { operationId: "builder-return-b-x-g2", reason: "live source cleanup failed: unmount refused" };
    const h = harness({
      "glmGateways/b-x": { docKind: "runtime", gatewayId: "b-x", runtime: "gce-vm", vm: { ...recorded }, vmStopOnPark: stopOnPark },
      "gateways/b-x": { gatewayClass: "builder", desiredStatus: "running" },
      "glmOperations/builder-return-b-x-g2": { kind: "migrate-customer", status: "running" },
    });
    await h.runtime.upsertInstance(upsertOpts);
    expect(h.docs["glmGateways/b-x"].vmStopOnPark).toEqual(stopOnPark);
  });

  it("clears a finished return's leftover stop request when the gateway wakes its computer", async () => {
    const h = harness({
      "glmGateways/b-x": { docKind: "runtime", gatewayId: "b-x", runtime: "gce-vm", vm: { ...recorded, status: "SUSPENDED", internalIp: null, stopReason: "operator" },
        vmStopOnPark: { operationId: "builder-return-b-x-g1", reason: "live source cleanup failed: abandoned" } },
      "gateways/b-x": { gatewayClass: "builder", desiredStatus: "running" },
      "glmOperations/builder-return-b-x-g1": { kind: "migrate-customer", status: "failed" },
    }, {
      describe: vi.fn(async () => running).mockResolvedValueOnce(suspended),
      resume: vi.fn(async () => ({ fellBackToStandard: false })),
    });
    await h.runtime.upsertInstance(upsertOpts);
    expect(h.vm.resume).toHaveBeenCalledWith(COMPUTER, "us-west1-b");
    expect(h.docs["glmGateways/b-x"].vmStopOnPark).toBeUndefined();
    expect(h.log).toHaveBeenCalledWith(expect.stringMatching(/b-x: cleared the leftover stop request of builder-return-b-x-g1/));
  });

  it("refuses to park on a malformed stop request", async () => {
    const h = harness({ "glmGateways/b-x": { docKind: "runtime", gatewayId: "b-x", runtime: "gce-vm", vm: { ...recorded }, vmStopOnPark: { reason: 7 } } }, {
      describe: vi.fn(async () => running),
    });
    await expect(h.runtime.upsertInstance({ ...upsertOpts, replicas: 0 })).rejects.toThrow(/vmStopOnPark request is malformed/);
    expect(h.vm.suspend).not.toHaveBeenCalled();
    expect(h.vm.stop).not.toHaveBeenCalled();
  });

  it("wakes a suspended computer by resuming it instead of starting it", async () => {
    const h = harness({ "glmGateways/b-x": { docKind: "runtime", gatewayId: "b-x", runtime: "gce-vm", vm: { ...recorded, status: "SUSPENDED", internalIp: null, stopReason: "idle" } } }, {
      describe: vi.fn(async () => running).mockResolvedValueOnce(suspended),
      resume: vi.fn(async () => ({ fellBackToStandard: true })),
    });
    await h.runtime.upsertInstance(upsertOpts);
    expect(h.vm.resume).toHaveBeenCalledWith(COMPUTER, "us-west1-b");
    expect(h.vm.start).not.toHaveBeenCalled();
    expect(h.vm.stop).not.toHaveBeenCalled();
    expect(h.docs["glmGateways/b-x"].vm).toEqual({ ...recorded, updatedAt: 1_000 });
    expect(h.log).toHaveBeenCalledWith(expect.stringMatching(/b-x: resumed octogee-computer-test-uida -> RUNNING \(on-demand fallback\)/));
    expect(h.routesPublished().at(-1)).toEqual({ "b-x": "172.20.0.9" });
  });

  it("releases the owner's parked-computer record when the same gateway resumes its suspended computer", async () => {
    const parked = { instanceName: COMPUTER, zone: "us-west1-b", instanceId: "4242", gatewayId: "b-x", parkedAt: 1, checkpoint: { outcome: "fresh", requestedAt: null, completedAt: null } };
    const h = harness({
      "glmGateways/b-x": { docKind: "runtime", gatewayId: "b-x", runtime: "gce-vm", vm: { ...recorded, status: "SUSPENDED", internalIp: null, stopReason: "idle" } },
      "users/UidA": { provisioning: { computer: parked } },
    }, {
      describe: vi.fn(async () => running).mockResolvedValueOnce(suspended),
      resume: vi.fn(async () => ({ fellBackToStandard: false })),
    });
    await h.runtime.upsertInstance(upsertOpts);
    expect(h.vm.resume).toHaveBeenCalledWith(COMPUTER, "us-west1-b");
    expect(h.vm.stop).not.toHaveBeenCalled();
    expect(readPath(h.docs["users/UidA"], "provisioning.computer")).toBeUndefined();
  });

  it("stops a suspended computer before rebinding it so the guest boots into the new gateway", async () => {
    let current: GatewayVmDescription = suspendedElsewhere;
    const h = harness({ "glmGateways/b-x": { docKind: "runtime", gatewayId: "b-x", runtime: "gce-vm" } }, {
      findByLabels: vi.fn(async () => current),
      describe: vi.fn(async () => current),
      bind: vi.fn(async () => { current = { ...current, gatewayId: "b-x" }; }),
      stop: vi.fn(async () => { current = { ...current, status: "TERMINATED" }; }),
      start: vi.fn(async () => { current = { ...current, status: "RUNNING", internalIp: running.internalIp }; return { fellBackToStandard: false }; }),
    });
    await h.runtime.upsertInstance(upsertOpts);
    expect(h.vm.stop).toHaveBeenCalledOnce();
    expect(h.vm.bind).toHaveBeenCalledOnce();
    expect(h.vm.resume).not.toHaveBeenCalled();
    expect(h.vm.stop.mock.invocationCallOrder[0]).toBeLessThan(h.vm.bind.mock.invocationCallOrder[0]);
    expect(h.vm.bind.mock.invocationCallOrder[0]).toBeLessThan(h.vm.start.mock.invocationCallOrder[0]);
    expect(h.log).toHaveBeenCalledWith(expect.stringMatching(/b-x: stopped octogee-computer-test-uida to rebind it from b-old/));
    expect(h.docs["glmGateways/b-x"].vm).toMatchObject({ status: "RUNNING", instanceId: "4242", stopReason: null });
  });

  it("refreshes bootstrap metadata on a suspended computer bound to the same gateway without stopping it, then resumes", async () => {
    const h = harness({ "glmGateways/b-x": { docKind: "runtime", gatewayId: "b-x", runtime: "gce-vm", vm: { ...recorded, status: "SUSPENDED", internalIp: null, stopReason: "operator" } } }, {
      describe: vi.fn(async () => running).mockResolvedValueOnce(suspended),
    });
    await h.runtime.upsertInstance({ ...upsertOpts, imageTag: "main.new-agent" });
    expect(h.vm.bind).toHaveBeenCalledWith(COMPUTER, "us-west1-b", expect.objectContaining({ metadata: expect.objectContaining({ "gateway-image": `${upsertOpts.imageRepository}:main.new-agent` }) }));
    expect(h.vm.resume).toHaveBeenCalledWith(COMPUTER, "us-west1-b");
    expect(h.vm.stop).not.toHaveBeenCalled();
    expect(h.vm.start).not.toHaveBeenCalled();
    expect(h.vm.bind.mock.invocationCallOrder[0]).toBeLessThan(h.vm.resume.mock.invocationCallOrder[0]);
  });

  it("stops a suspended same-gateway computer and refreshes again when Compute rejects the metadata refresh, then starts it", async () => {
    let current: GatewayVmDescription = suspended;
    const h = harness({ "glmGateways/b-x": { docKind: "runtime", gatewayId: "b-x", runtime: "gce-vm", vm: { ...recorded, status: "SUSPENDED", internalIp: null, stopReason: "operator" } } }, {
      describe: vi.fn(async () => current),
      bind: vi.fn(async () => {}).mockRejectedValueOnce(new Error("UNSUPPORTED_OPERATION: instance is suspended")),
      stop: vi.fn(async () => { current = { ...current, status: "TERMINATED" }; }),
      start: vi.fn(async () => { current = running; return { fellBackToStandard: false }; }),
    });
    await h.runtime.upsertInstance({ ...upsertOpts, imageTag: "main.new-agent" });
    expect(h.vm.bind).toHaveBeenCalledTimes(2);
    expect(h.vm.resume).not.toHaveBeenCalled();
    expect(h.vm.bind.mock.invocationCallOrder[0]).toBeLessThan(h.vm.stop.mock.invocationCallOrder[0]);
    expect(h.vm.stop.mock.invocationCallOrder[0]).toBeLessThan(h.vm.bind.mock.invocationCallOrder[1]);
    expect(h.vm.bind.mock.invocationCallOrder[1]).toBeLessThan(h.vm.start.mock.invocationCallOrder[0]);
    expect(h.log).toHaveBeenCalledWith(expect.stringMatching(/⚠ b-x: could not bind suspended octogee-computer-test-uida \(UNSUPPORTED_OPERATION: instance is suspended\); stopping it to refresh its bootstrap metadata/));
  });

  it("stops a suspended computer before changing its machine type, then starts it", async () => {
    let computer: GatewayVmDescription = { ...suspended };
    const h = harness({ "glmGateways/b-x": { gatewayId: "b-x", runtime: "gce-vm", vmSpec: { ...spec, machineType: "n2-standard-2" }, vm: { ...recorded, status: "SUSPENDED", stopReason: "idle" } } }, {
      describe: vi.fn(async () => computer),
      stop: vi.fn(async () => { computer = { ...computer, status: "TERMINATED" }; }),
      setMachineType: vi.fn(async (_name, _zone, machineType) => { computer = { ...computer, machineType }; }),
      start: vi.fn(async () => { computer = { ...computer, status: "RUNNING" }; return { fellBackToStandard: false }; }),
    });
    await h.runtime.upsertInstance(upsertOpts);
    expect(h.vm.stop.mock.invocationCallOrder[0]).toBeLessThan(h.vm.setMachineType.mock.invocationCallOrder[0]);
    expect(h.vm.setMachineType.mock.invocationCallOrder[0]).toBeLessThan(h.vm.start.mock.invocationCallOrder[0]);
    expect(h.vm.resume).not.toHaveBeenCalled();
    expect(h.log).toHaveBeenCalledWith(expect.stringMatching(/b-x: stopped suspended octogee-computer-test-uida to change its machine type/));
  });

  it("stops a suspended computer before repairing its identity scopes", async () => {
    let computer: GatewayVmDescription = { ...suspended, serviceAccounts: [{ email: spec.serviceAccountEmail, scopes: [] }] };
    const h = harness({ "glmGateways/b-x": { gatewayId: "b-x", runtime: "gce-vm", vm: { ...recorded, status: "SUSPENDED", stopReason: "operator" } } }, {
      describe: vi.fn(async () => computer),
      stop: vi.fn(async () => { computer = { ...computer, status: "TERMINATED" }; }),
      setServiceAccount: vi.fn(async () => { computer = { ...computer, serviceAccounts: running.serviceAccounts }; }),
      start: vi.fn(async () => { computer = { ...computer, status: "RUNNING" }; return { fellBackToStandard: false }; }),
    });
    await h.runtime.upsertInstance(upsertOpts);
    expect(h.vm.stop.mock.invocationCallOrder[0]).toBeLessThan(h.vm.setServiceAccount.mock.invocationCallOrder[0]);
    expect(h.vm.setServiceAccount.mock.invocationCallOrder[0]).toBeLessThan(h.vm.start.mock.invocationCallOrder[0]);
    expect(h.vm.resume).not.toHaveBeenCalled();
  });

  it("does not restart a suspended computer Cowboy parked, and warns about one suspended outside Cowboy", async () => {
    const parked = harness({ "glmGateways/b-x": { runtime: "gce-vm", vm: { ...recorded, status: "SUSPENDED", stopReason: "idle" } } }, { describe: vi.fn(async () => suspended) });
    await parked.runtime.recoverUnreachable("b-x");
    expect(parked.vm.describe).not.toHaveBeenCalled();
    expect(parked.vm.resume).not.toHaveBeenCalled();

    const outside = harness({ "glmGateways/b-x": { runtime: "gce-vm", vm: { ...recorded } } }, { describe: vi.fn(async () => suspended) });
    await outside.runtime.recoverUnreachable("b-x");
    expect(outside.vm.resume).not.toHaveBeenCalled();
    expect(outside.vm.start).not.toHaveBeenCalled();
    expect(outside.log).toHaveBeenCalledWith(expect.stringMatching(/⚠ b-x: octogee-computer-test-uida is SUSPENDED outside Cowboy; not resuming it/));
  });
});

describe("createVmGatewayRuntime.removeInstance + reads", () => {
  const otherVm = { ...recorded, instanceName: "octogee-computer-test-uidb", instanceId: "4343", internalIp: "172.20.0.10" };

  it("suspends the computer instead of deleting it, records the idle park, and republishes routes without it", async () => {
    const h = harness({
      "glmGateways/b-x": { docKind: "runtime", gatewayId: "b-x", runtime: "gce-vm", vm: { ...recorded }, vmInstance: { enabled: true } },
      "glmGateways/b-x/vm/runtime": { version: "v" },
      "glmGateways/b-y": { docKind: "runtime", gatewayId: "b-y", runtime: "gce-vm", vm: otherVm, vmInstance: { enabled: true, gatewayId: "b-y" } },
    }, { describe: vi.fn(async () => suspended).mockResolvedValueOnce(running) });
    h.docs["glmGateways/b-x"].vmHome = { checkpointRequestedAt: 900, lastCheckpoint: { completedAt: 950 } };
    expect(Object.keys(await h.runtime.readDeployedInstances({ namespace: "octogee-test" }))).toEqual(["b-x", "b-y"]);

    await h.runtime.removeInstance({ namespace: "octogee-test", gatewayId: "b-x" });

    expect(h.vm.suspend).toHaveBeenCalledWith(COMPUTER, "us-west1-b");
    expect(h.vm.stop).not.toHaveBeenCalled();
    expect(h.vm.delete).not.toHaveBeenCalled();
    expect(h.deletes).toContain("glmGateways/b-x/vm/runtime");
    expect(h.docs["glmGateways/b-x"].vm).toEqual({
      ...recorded, status: "SUSPENDED", internalIp: null, stopReason: "idle", updatedAt: 1_000,
      parkedCheckpoint: { outcome: "stale", requestedAt: null, completedAt: 950 },
    });
    expect(h.docs["glmGateways/b-x"].vmInstance).toBeUndefined();
    expect(h.routesPublished().at(-1)).toEqual({ "b-y": "172.20.0.10" });
    expect(h.log).toHaveBeenCalledWith(expect.stringMatching(/b-x: suspended octogee-computer-test-uida for idle -> SUSPENDED; boot and home disks retained/));
    expect(await h.runtime.readDeployedInstance({ namespace: "octogee-test", gatewayId: "b-y" })).toMatchObject({ gatewayId: "b-y" });
    expect(await h.runtime.listPendingReleases({ namespace: "octogee-test" })).toEqual([]);
  });

  it("re-drives against an already stopped computer and leaves one that another gateway has since bound", async () => {
    const already = harness({ "glmGateways/b-x": { docKind: "runtime", gatewayId: "b-x", runtime: "gce-vm", vm: { ...recorded } } }, {
      describe: vi.fn(async () => stopped),
    });
    await already.runtime.removeInstance({ namespace: "octogee-test", gatewayId: "b-x" });
    expect(already.vm.stop).not.toHaveBeenCalled();
    expect(already.waits).toEqual([]);
    expect(readPath(already.docs["glmGateways/b-x"], "vmHome")).toBeUndefined();
    expect(already.docs["glmGateways/b-x"].vm).toEqual({
      ...recorded, status: "TERMINATED", internalIp: null, stopReason: "idle", updatedAt: 1_000,
      parkedCheckpoint: { outcome: "stale", requestedAt: null, completedAt: null },
    });

    const rebound = harness({ "glmGateways/b-x": { docKind: "runtime", gatewayId: "b-x", runtime: "gce-vm", vm: { ...recorded } } }, {
      describe: vi.fn(async () => ({ ...running, gatewayId: "b-new" })),
    });
    await rebound.runtime.removeInstance({ namespace: "octogee-test", gatewayId: "b-x" });
    expect(rebound.vm.stop).not.toHaveBeenCalled();
    expect(rebound.docs["glmGateways/b-x"].vm).toBeNull();
    expect(rebound.log).toHaveBeenCalledWith(expect.stringMatching(/leaving octogee-computer-test-uida running: bound to b-new/));
  });

  const ownedDoc = { docKind: "runtime", gatewayId: "b-x", runtime: "gce-vm", vm: { ...recorded }, vmInstance: { enabled: true, ownerUid: "UidA" } };
  const userDoc = { provisioning: { openclaw: { gatewayId: "b-x", slug: "mama" } }, tier: "builder" };

  it("records the parked computer on the Builder's provisioning record with the checkpoint outcome, keeping the rest of the record", async () => {
    const h = harness({ "glmGateways/b-x": { ...ownedDoc, vmHome: { checkpointRequestedAt: 1_000, checkpointAcknowledgedAt: 1_000, parkRequestedAt: 1_000, lastCheckpoint: { completedAt: 1_500 } } }, "users/UidA": { ...userDoc } }, {
      describe: vi.fn(async () => suspended).mockResolvedValueOnce(running),
    }, "172.20.7.7", {}, { clock: { now: 2_000 } });

    await h.runtime.removeInstance({ namespace: "octogee-test", gatewayId: "b-x" });

    expect(h.docs["users/UidA"]).toEqual({
      ...userDoc,
      provisioning: {
        ...userDoc.provisioning,
        computer: { instanceName: COMPUTER, zone: "us-west1-b", instanceId: "4242", gatewayId: "b-x", parkedAt: 2_000, checkpoint: { outcome: "fresh", requestedAt: 1_000, completedAt: 1_500 } },
      },
    });

    const vmHome = { checkpointRequestedAt: 1_000, checkpointAcknowledgedAt: 1_000, parkRequestedAt: 1_000, lastCheckpoint: { completedAt: 1_500 } };
    const unstamped = harness({ "glmGateways/b-x": { ...ownedDoc, vmInstance: { enabled: true }, vmHome }, "users/UidA": { ...userDoc } }, {
      describe: vi.fn(async () => ({ ...stopped, metadata: { ...stopped.metadata, "octogee-owner-uid": "UidA" } })).mockResolvedValueOnce({ ...running, metadata: { ...running.metadata, "octogee-owner-uid": "UidA" } }),
    }, "172.20.7.7", {}, { clock: { now: 2_000 } });
    await unstamped.runtime.removeInstance({ namespace: "octogee-test", gatewayId: "b-x" });
    expect(readPath(unstamped.docs["users/UidA"], "provisioning.computer")).toMatchObject({ instanceName: COMPUTER, gatewayId: "b-x", parkedAt: 2_000 });

    const ownerless = harness({ "glmGateways/b-x": { ...ownedDoc, vmInstance: { enabled: true }, vmHome } }, {
      describe: vi.fn(async () => suspended).mockResolvedValueOnce(running),
    }, "172.20.7.7", {}, { clock: { now: 2_000 } });
    await ownerless.runtime.removeInstance({ namespace: "octogee-test", gatewayId: "b-x" });
    expect(ownerless.vm.suspend).toHaveBeenCalled();
    expect(ownerless.writes.filter((write) => write.path.startsWith("users/"))).toEqual([]);
    expect(ownerless.log).toHaveBeenCalledWith(expect.stringMatching(/⚠ b-x: parked octogee-computer-test-uida without an owner; it is not replaceable while parked/));
  });

  it("parks retained home without requesting a full archive or waiting on an unavailable exporter", async () => {
    const vmHome = { checkpointRequestedAt: 100_000, lastCheckpoint: { completedAt: 90_000 } };
    const h = harness({ "glmGateways/b-x": { ...ownedDoc, vmHome }, "users/UidA": { ...userDoc } }, {
      describe: vi.fn(async () => suspended).mockResolvedValueOnce(running),
    }, "172.20.7.7", {}, { clock: { now: 200_000 } });
    await h.runtime.removeInstance({ namespace: "octogee-test", gatewayId: "b-x" });
    expect(h.vm.suspend).toHaveBeenCalledWith(COMPUTER, "us-west1-b");
    expect(h.waits).toEqual([]);
    expect(readPath(h.docs["glmGateways/b-x"], "vmHome")).toEqual(vmHome);
    expect(h.vm.delete).not.toHaveBeenCalled();
    expect(h.deletes).toContain("glmGateways/b-x/vm/runtime");
  });

  it.each(["RUNNING", "STOPPING", "missing", "recreated"])("does not release a retained computer after an unverified stop (%s)", async status => {
    const observed = status === "missing" ? null : status === "recreated" ? { ...stopped, instanceId: "9999" } : { ...stopped, status };
    const h = harness({ "glmGateways/b-x": { ...ownedDoc }, "glmGateways/b-x/vm/runtime": { version: "v" }, "users/UidA": { ...userDoc } }, {
      describe: vi.fn().mockResolvedValueOnce(running).mockResolvedValue(observed),
    });
    await expect(h.runtime.removeInstance({ namespace: "octogee-test", gatewayId: "b-x" })).rejects.toThrow(/verified stopped computer/);
    expect(h.deletes).not.toContain("glmGateways/b-x/vm/runtime");
    expect(h.docs["glmGateways/b-x"].vmInstance).toEqual(ownedDoc.vmInstance);
    expect(readPath(h.docs["users/UidA"], "provisioning.computer")).toBeUndefined();
    expect(h.vm.delete).not.toHaveBeenCalled();
  });

  it("waits in place for the final checkpoint when retirement asks it to, with the replace action's poll, and parks stale at the bound", async () => {
    const h = harness({ "glmGateways/b-x": { ...ownedDoc }, "users/UidA": { ...userDoc } }, {
      describe: vi.fn(async () => suspended).mockResolvedValueOnce(running),
    }, "172.20.7.7", {}, {
      onWait: (_ms, waits) => { if (waits === 2) Object.assign(h.docs["glmGateways/b-x"].vmHome as object, { lastCheckpoint: { instanceId: "4242", completedAt: 21_000 }, checkpointAcknowledgedAt: 1_000 }); },
    });

    await h.runtime.removeInstance({ namespace: "octogee-test", gatewayId: "b-x", awaitHomeCheckpoint: true });

    expect(h.waits).toEqual([10_000, 10_000]);
    expect(h.vm.suspend).toHaveBeenCalledWith(COMPUTER, "us-west1-b");
    expect(h.docs["glmGateways/b-x"].vm).toMatchObject({ stopReason: "idle", updatedAt: 21_000, parkedCheckpoint: { outcome: "fresh", requestedAt: 1_000, completedAt: 21_000 } });
    expect(h.deletes).toContain("glmGateways/b-x/vm/runtime");

    const never = harness({ "glmGateways/b-x": { ...ownedDoc }, "users/UidA": { ...userDoc } }, {
      describe: vi.fn(async () => suspended).mockResolvedValueOnce(running),
    });
    await never.runtime.removeInstance({ namespace: "octogee-test", gatewayId: "b-x", awaitHomeCheckpoint: true });
    expect(never.waits).toEqual([10_000, 10_000, 10_000, 10_000, 10_000, 10_000]);
    expect(never.vm.suspend).toHaveBeenCalledWith(COMPUTER, "us-west1-b");
    expect(never.docs["glmGateways/b-x"].vm).toMatchObject({ stopReason: "idle", parkedCheckpoint: { outcome: "stale", requestedAt: 1_000, completedAt: null } });
    expect(readPath(never.docs["users/UidA"], "provisioning.computer")).toMatchObject({ checkpoint: { outcome: "stale" } });
  });

  it("derives the outcome from the record for a computer that is already stopped: fresh only when the park's own request completed", async () => {
    const h = harness({ "glmGateways/b-x": { ...ownedDoc, vmHome: { checkpointRequestedAt: 500, checkpointAcknowledgedAt: 500, parkRequestedAt: 500, lastCheckpoint: { completedAt: 600 } } }, "users/UidA": { ...userDoc } }, {
      describe: vi.fn(async () => stopped),
    });
    await h.runtime.removeInstance({ namespace: "octogee-test", gatewayId: "b-x" });
    expect(h.vm.stop).not.toHaveBeenCalled();
    expect(h.waits).toEqual([]);
    expect(h.docs["glmGateways/b-x"].vm).toMatchObject({ parkedCheckpoint: { outcome: "fresh", requestedAt: 500, completedAt: 600 } });
    expect(readPath(h.docs["glmGateways/b-x"], "vmHome.checkpointRequestedAt")).toBe(500);

    const earlier = harness({ "glmGateways/b-x": { ...ownedDoc, vmHome: { checkpointRequestedAt: 500, lastCheckpoint: { completedAt: 600 } } }, "users/UidA": { ...userDoc } }, {
      describe: vi.fn(async () => stopped),
    });
    await earlier.runtime.removeInstance({ namespace: "octogee-test", gatewayId: "b-x" });
    expect(earlier.docs["glmGateways/b-x"].vm).toMatchObject({ parkedCheckpoint: { outcome: "stale", requestedAt: null, completedAt: 600 } });
    expect(readPath(earlier.docs["glmGateways/b-x"], "vmHome.checkpointRequestedAt")).toBe(500);
  });

  it("drops the park observation instead of re-creating a runtime record that retirement deleted mid-park", async () => {
    const vmHome = { checkpointRequestedAt: 500, checkpointAcknowledgedAt: 500, parkRequestedAt: 500, lastCheckpoint: { completedAt: 600 } };
    const h = harness({ "glmGateways/b-x": { ...ownedDoc, vmHome }, "glmGateways/b-x/vm/runtime": { version: "v" }, "users/UidA": { ...userDoc } }, {
      describe: vi.fn(async () => suspended).mockResolvedValueOnce(running),
      suspend: vi.fn(async () => { delete h.docs["glmGateways/b-x"]; }),
    });

    await h.runtime.removeInstance({ namespace: "octogee-test", gatewayId: "b-x" });

    expect(h.vm.suspend).toHaveBeenCalledWith(COMPUTER, "us-west1-b");
    expect(h.docs["glmGateways/b-x"]).toBeUndefined();
    expect(h.deletes).toContain("glmGateways/b-x/vm/runtime");
    expect(readPath(h.docs["users/UidA"], "provisioning.computer")).toMatchObject({ instanceName: COMPUTER, gatewayId: "b-x", checkpoint: { outcome: "fresh" } });
    expect(h.log).toHaveBeenCalledWith(expect.stringMatching(/b-x: runtime record is gone; dropped the park observation/));
  });
});

describe("createVmGatewayRuntime.removeInstance with disposable parking", () => {
  const vmHome = { checkpointRequestedAt: 1_000, checkpointAcknowledgedAt: 1_000, parkRequestedAt: 1_000, lastCheckpoint: { name: "20260905T101500Z.tar.gz", size: 2048, sha256: "a".repeat(64), generation: "9007199254740995", coverage: "builder-home-v2" as const, writerProtocol: 3 as const, instanceId: "4242", completedAt: 1_500 } };
  const earlierPark = { instanceName: COMPUTER, zone: "us-west1-b", instanceId: "4242", gatewayId: "b-x", parkedAt: 500, checkpoint: { outcome: "fresh", requestedAt: 400, completedAt: 450 } };
  const parkDocs = (home: Record<string, unknown> = vmHome) => ({
    "glmGateways/b-x": { docKind: "runtime", gatewayId: "b-x", runtime: "gce-vm", vm: { ...recorded }, vmSpec: spec, vmInstance: { enabled: true, ownerUid: "UidA" }, vmHome: { ...home } },
    "glmGateways/b-x/vm/runtime": { version: "v" },
    "users/UidA": { tier: "builder", provisioning: { openclaw: { gatewayId: "b-x" }, computer: earlierPark } },
  });

  it("keeps both disks through idle retirement even when a legacy disposal flag and future checkpoint are present", async () => {
    const h = harness(parkDocs(), { describe: vi.fn(async () => suspended).mockResolvedValueOnce(running), readBootImage: vi.fn(async () => OLD_IMAGE) }, "172.20.7.7", { "b-x": "retired" }, { disposableParking: true, clock: { now: 2_000 } });
    await h.runtime.removeInstance({ namespace: "octogee-test", gatewayId: "b-x" });
    expect(h.vm.delete).not.toHaveBeenCalled();
    expect(h.vm.suspend).toHaveBeenCalled();
    expect(h.docs["glmGateways/b-x"].vm).toMatchObject({ instanceId: "4242", status: "SUSPENDED" });
    expect(readPath(h.docs["users/UidA"], "provisioning.computer")).toMatchObject({ instanceName: COMPUTER });
    expect(h.docs["glmGateways/b-x"].vmSpec).toEqual(spec);
  });

  it("parks a computer already on the family's current image exactly as before", async () => {
    const h = harness(parkDocs(), { describe: vi.fn(async () => suspended).mockResolvedValueOnce(running) }, "172.20.7.7", {}, { clock: { now: 2_000 } });

    await h.runtime.removeInstance({ namespace: "octogee-test", gatewayId: "b-x" });

    expect(h.vm.suspend).toHaveBeenCalledWith(COMPUTER, "us-west1-b");
    expect(h.vm.delete).not.toHaveBeenCalled();
    expect(h.docs["glmGateways/b-x"].vm).toMatchObject({ stopReason: "idle", parkedCheckpoint: { outcome: "fresh", completedAt: 1_500 } });
    expect(readPath(h.docs["users/UidA"], "provisioning.computer")).toMatchObject({ instanceName: COMPUTER, parkedAt: 2_000, checkpoint: { outcome: "fresh" } });
  });

  it("stops rather than deletes a computer whose final home checkpoint is stale, and says why", async () => {
    const h = harness(parkDocs({ checkpointRequestedAt: 500, lastCheckpoint: { completedAt: 600 } }), {
      describe: vi.fn(async () => stopped),
      readBootImage: vi.fn(async () => OLD_IMAGE),
    });

    await h.runtime.removeInstance({ namespace: "octogee-test", gatewayId: "b-x" });

    expect(h.vm.delete).not.toHaveBeenCalled();
    expect(h.docs["glmGateways/b-x"].vm).toMatchObject({ stopReason: "idle", parkedCheckpoint: { outcome: "stale" } });
    expect(readPath(h.docs["users/UidA"], "provisioning.computer")).toMatchObject({ checkpoint: { outcome: "stale" } });
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining("boot and home disks retained"));
  });

  it("stops rather than deletes when the image family cannot be resolved, and says why", async () => {
    const h = harness(parkDocs(), {
      describe: vi.fn(async () => suspended).mockResolvedValueOnce(running),
      readBootImage: vi.fn(async () => OLD_IMAGE),
      readFamilyImage: vi.fn(async () => { throw new Error("http 403"); }),
    });

    await h.runtime.removeInstance({ namespace: "octogee-test", gatewayId: "b-x" });

    expect(h.vm.suspend).toHaveBeenCalledWith(COMPUTER, "us-west1-b");
    expect(h.vm.delete).not.toHaveBeenCalled();
    expect(h.docs["glmGateways/b-x"].vm).toMatchObject({ stopReason: "idle", parkedCheckpoint: { outcome: "fresh" } });
    expect(h.vm.readFamilyImage).not.toHaveBeenCalled();
  });
});

describe("createVmGatewayRuntime.upsertInstance waking a parked computer whose boot image the family has moved past", () => {
  const parkedRecord = (outcome: "fresh" | "stale") => ({ instanceName: COMPUTER, zone: "us-west1-b", instanceId: "4242", gatewayId: "b-x", parkedAt: 500, checkpoint: { outcome, requestedAt: 400, completedAt: 450 }, homeCheckpoint: { name: "20260905T101500Z.tar.gz", size: 2048, sha256: "a".repeat(64), generation: "9007199254740995", coverage: "builder-home-v2" as const, writerProtocol: 3 as const, instanceId: "4242", completedAt: 450 } });
  const wakeDocs = (computer?: ReturnType<typeof parkedRecord>) => ({
    "glmGateways/b-x": { docKind: "runtime", gatewayId: "b-x", runtime: "gce-vm", vm: { ...recorded, status: "TERMINATED", internalIp: null, stopReason: "idle" }, vmSpec: { ...spec, machineType: "n2-standard-2" } },
    "users/UidA": { tier: "builder", provisioning: { openclaw: { gatewayId: "b-x" }, ...(computer ? { computer } : {}) } },
  });

  it("starts a retained disk until its next held final checkpoint, even when the boot image is old", async () => {
    const h = harness(wakeDocs(parkedRecord("fresh")), { describe: vi.fn(async () => ({ ...running, machineType: "n2-standard-2" })).mockResolvedValueOnce({ ...stopped, machineType: "n2-standard-2" }) }, "172.20.7.7", { "b-x": "retired" }, { disposableParking: true });
    await h.runtime.upsertInstance(upsertOpts);
    expect(h.vm.delete).not.toHaveBeenCalled();
    expect(h.vm.create).not.toHaveBeenCalled();
    expect(h.vm.start).toHaveBeenCalled();
  });

  it("starts it as before when its park checkpoint is stale or missing, and says why", async () => {
    for (const computer of [parkedRecord("stale"), undefined]) {
      const h = harness(wakeDocs(computer), {
        describe: vi.fn(async () => ({ ...stopped, machineType: "n2-standard-2" })),
        readBootImage: vi.fn(async () => OLD_IMAGE),
      });

      await h.runtime.upsertInstance(upsertOpts);

      expect(h.vm.delete).not.toHaveBeenCalled();
      expect(h.vm.create).not.toHaveBeenCalled();
      expect(h.vm.start).toHaveBeenCalledWith(COMPUTER, "us-west1-b");
      expect(h.docs["users/UidA"]).toMatchObject({ tier: "builder", provisioning: { openclaw: { gatewayId: "b-x" }, homeDisk: { id: "777", sizeGb: 30 } } });
    expect(readPath(h.docs["users/UidA"], "provisioning.computer")).toBeUndefined();
    }
  });

  it("starts it as before when it has run since its park record, so an earlier park's checkpoint never authorizes a delete", async () => {
    const h = harness(wakeDocs(parkedRecord("fresh")), {
      describe: vi.fn(async () => ({ ...stopped, machineType: "n2-standard-2", lastStartedAt: 600 })),
      readBootImage: vi.fn(async () => OLD_IMAGE),
    });

    await h.runtime.upsertInstance(upsertOpts);

    expect(h.vm.delete).not.toHaveBeenCalled();
    expect(h.vm.start).toHaveBeenCalledWith(COMPUTER, "us-west1-b");
  });

  it("clears the parked record before starting the computer, so a failed clear leaves it stopped", async () => {
    const h = harness(wakeDocs(parkedRecord("stale")), { describe: vi.fn(async () => ({ ...running, machineType: "n2-standard-2" })).mockResolvedValueOnce({ ...stopped, machineType: "n2-standard-2" }) });
    const collection = h.db.collection.bind(h.db);
    Object.assign(h.db, {
      collection: (name: string) => name !== "users" ? collection(name) : {
        doc: (id: string) => ({ ...collection(name).doc(id), set: async () => { throw new Error("firestore unavailable"); } }),
      },
    });

    await expect(h.runtime.upsertInstance(upsertOpts)).rejects.toThrow(/firestore unavailable/);

    expect(h.vm.start).not.toHaveBeenCalled();
  });

  it("starts it as before when the image family cannot be resolved", async () => {
    const h = harness(wakeDocs(parkedRecord("fresh")), {
      describe: vi.fn(async () => ({ ...stopped, machineType: "n2-standard-2", metadata: { ...stopped.metadata, "octogee-owner-uid": "UidA" } })),
      readBootImage: vi.fn(async () => OLD_IMAGE),
      readFamilyImage: vi.fn(async () => { throw new Error("http 503"); }),
    });

    await h.runtime.upsertInstance(upsertOpts);

    expect(h.vm.delete).not.toHaveBeenCalled();
    expect(h.vm.start).toHaveBeenCalledWith(COMPUTER, "us-west1-b");
    expect(h.vm.readFamilyImage).toHaveBeenCalled();
  });
});

describe("createVmGatewayRuntime.upsertInstance after a park", () => {
  it("clears the Builder's parked record when the computer is bound to the new gateway, leaving the rest of the record", async () => {
    const parkedRecord = { instanceName: COMPUTER, zone: "us-west1-b", instanceId: "4242", gatewayId: "b-old", parkedAt: 500, checkpoint: { outcome: "fresh", requestedAt: 400, completedAt: 450 } };
    const parkedVm = { ...stopped, gatewayId: "b-old", labels: { ...OWNER_LABELS, "octogee-gateway-id": "b-old" }, metadata: { "gateway-id": "b-old" } };
    const h = harness({
      "glmGateways/b-x": { docKind: "runtime", gatewayId: "b-x", runtime: "gce-vm" },
      "users/UidA": { tier: "builder", provisioning: { openclaw: { gatewayId: "b-x" }, computer: parkedRecord } },
    }, { describe: vi.fn(async () => running), findByLabels: vi.fn(async () => parkedVm) });

    await h.runtime.upsertInstance(upsertOpts);

    expect(h.vm.bind).toHaveBeenCalledWith(COMPUTER, "us-west1-b", expect.objectContaining({ metadata: expect.objectContaining({ "gateway-id": "b-x" }) }));
    expect(h.docs["users/UidA"]).toMatchObject({ tier: "builder", provisioning: { openclaw: { gatewayId: "b-x" }, homeDisk: { id: "777", sizeGb: 30 } } });
    expect(readPath(h.docs["users/UidA"], "provisioning.computer")).toBeUndefined();

    const fresh = harness({ "glmGateways/b-x": { docKind: "runtime", gatewayId: "b-x", runtime: "gce-vm" }, "users/UidA": { tier: "builder" } }, {
      describe: vi.fn(async () => running), findByLabels: vi.fn(async () => parkedVm),
    });
    await fresh.runtime.upsertInstance(upsertOpts);
    expect(readPath(fresh.docs["users/UidA"], "provisioning.homeDisk")).toMatchObject({ id: "777", sizeGb: 30 });
  });
});

describe("createVmGatewayRuntime.recoverUnreachable", () => {
  const live = (vm: Record<string, unknown> = recorded) => ({ "glmGateways/b-x": { docKind: "runtime", gatewayId: "b-x", runtime: "gce-vm", vm, vmInstance: { enabled: true, gatewayId: "b-x" } } });

  it("restarts a preempted computer, records the preemption first, and republishes its route", async () => {
    const h = harness(live(), {
      describe: vi.fn(async () => running).mockResolvedValueOnce(stopped),
      start: vi.fn(async () => ({ fellBackToStandard: true })),
    });

    await h.runtime.recoverUnreachable("b-x");

    expect(h.vm.start).toHaveBeenCalledWith(COMPUTER, "us-west1-b");
    const vmWrites = h.writes.filter((w) => w.path === "glmGateways/b-x").map((w) => (w.data as { vm: unknown }).vm);
    expect(vmWrites[0]).toEqual({ ...recorded, status: "TERMINATED", internalIp: null, stopReason: "preempted", updatedAt: 1_000 });
    expect(h.docs["glmGateways/b-x"].vm).toEqual({ ...recorded, updatedAt: 1_000 });
    expect(h.routesPublished().at(-1)).toEqual({ "b-x": "172.20.0.9" });
    expect(h.log).toHaveBeenCalledWith(expect.stringMatching(/b-x: octogee-computer-test-uida was preempted \(TERMINATED\); restarting/));
    expect(h.log).toHaveBeenCalledWith(expect.stringMatching(/b-x: restarted octogee-computer-test-uida -> RUNNING \(on-demand fallback\)/));
  });

  it("never restarts a computer Cowboy stopped, a retired gateway's, or one bound to another gateway", async () => {
    for (const stopReason of ["idle", "operator"] as const) {
      const h = harness(live({ ...recorded, status: "TERMINATED", stopReason }));
      await h.runtime.recoverUnreachable("b-x");
      expect(h.vm.describe).not.toHaveBeenCalled();
      expect(h.vm.start).not.toHaveBeenCalled();
    }

    const retired = harness(live(), { describe: vi.fn(async () => stopped) }, "172.20.7.7", { "b-x": "retired" });
    await retired.runtime.recoverUnreachable("b-x");
    expect(retired.vm.describe).not.toHaveBeenCalled();

    const elsewhere = harness(live(), { describe: vi.fn(async () => ({ ...stopped, gatewayId: "b-new" })) });
    await elsewhere.runtime.recoverUnreachable("b-x");
    expect(elsewhere.vm.start).not.toHaveBeenCalled();
    expect(elsewhere.log).toHaveBeenCalledWith(expect.stringMatching(/bound to b-new/));

    const cluster = harness({ "glmGateways/b-x": { docKind: "runtime", gatewayId: "b-x", runtime: "cluster" } });
    await cluster.runtime.recoverUnreachable("b-x");
    expect(cluster.vm.describe).not.toHaveBeenCalled();
  });

  it("records a computer Compute is still stopping and waits, without write churn", async () => {
    const h = harness(live(), { describe: vi.fn(async () => ({ ...running, status: "STOPPING" })) });

    await h.runtime.recoverUnreachable("b-x");
    await h.runtime.recoverUnreachable("b-x");

    expect(h.vm.start).not.toHaveBeenCalled();
    expect(h.docs["glmGateways/b-x"].vm).toMatchObject({ status: "STOPPING", stopReason: "preempted" });
    expect(h.writes.filter((w) => w.path === "glmGateways/b-x")).toHaveLength(1);
    expect(h.log).toHaveBeenCalledWith(expect.stringMatching(/being stopped by Compute/));
  });

  it("refreshes a stale record when the computer is already back and reports a vanished one", async () => {
    const stale = harness(live({ ...recorded, status: "TERMINATED", internalIp: null, stopReason: "preempted" }));
    await stale.runtime.recoverUnreachable("b-x");
    expect(stale.vm.start).not.toHaveBeenCalled();
    expect(stale.docs["glmGateways/b-x"].vm).toEqual({ ...recorded, updatedAt: 1_000 });
    expect(stale.routesPublished().at(-1)).toEqual({ "b-x": "172.20.0.9" });

    const gone = harness(live(), { describe: vi.fn(async () => null) });
    await gone.runtime.recoverUnreachable("b-x");
    expect(gone.log).toHaveBeenCalledWith(expect.stringMatching(/octogee-computer-test-uida is absent from Compute/));
    expect(gone.docs["glmGateways/b-x"].vm).toEqual(recorded);
  });

  it("records the computer's start time when the running record lacks it or Compute restarted it", async () => {
    const { startedAt: _startedAt, ...unstamped } = recorded;
    const legacy = harness(live(unstamped));
    await legacy.runtime.recoverUnreachable("b-x");
    expect(legacy.docs["glmGateways/b-x"].vm).toEqual({ ...recorded, updatedAt: 1_000 });

    const restarted = harness(live(), { describe: vi.fn(async () => ({ ...running, lastStartedAt: 500 })) });
    await restarted.runtime.recoverUnreachable("b-x");
    expect(restarted.docs["glmGateways/b-x"].vm).toEqual({ ...recorded, startedAt: 500, updatedAt: 1_000 });

    const unchanged = harness(live());
    await unchanged.runtime.recoverUnreachable("b-x");
    expect(unchanged.writes.filter((w) => w.path === "glmGateways/b-x")).toHaveLength(0);
  });

  it("stops recovering once retirement has deleted the runtime record: no preemption write, no restart", async () => {
    const h = harness(live(), { describe: vi.fn(async () => { delete h.docs["glmGateways/b-x"]; return stopped; }) });

    await h.runtime.recoverUnreachable("b-x");

    expect(h.vm.start).not.toHaveBeenCalled();
    expect(h.docs["glmGateways/b-x"]).toBeUndefined();
    expect(h.log).toHaveBeenCalledWith(expect.stringMatching(/b-x: runtime record is gone; dropped the preempted observation/));
  });
});

describe("createVmGatewayRuntime.deleteComputer", () => {
  it("deletes the owner's computer wherever it is and reports absence", async () => {
    const h = harness({}, { findByLabels: vi.fn(async () => ({ ...stopped, name: "octogee-computer-test-uida-2", zone: "us-central1-a" })) });
    expect(await h.runtime.deleteComputer("UidA")).toBe(true);
    expect(h.vm.findByLabels).toHaveBeenCalledWith(OWNER_LABELS);
    expect(h.vm.delete).toHaveBeenCalledWith("octogee-computer-test-uida-2", "us-central1-a");

    const none = harness({});
    expect(await none.runtime.deleteComputer("UidA")).toBe(false);
    expect(none.vm.delete).not.toHaveBeenCalled();
  });
});

describe("vmRoutesFromDocs", () => {
  it("publishes only running gce-vm gateways with an internal IP", () => {
    expect(vmRoutesFromDocs([
      { id: "a", data: () => ({ runtime: "gce-vm", vm: { internalIp: "1.1.1.1", status: "RUNNING" } }) },
      { id: "b", data: () => ({ runtime: "gce-vm", vm: { internalIp: "1.1.1.2", status: "TERMINATED" } }) },
      { id: "c", data: () => ({ runtime: "cluster", vm: { internalIp: "1.1.1.3", status: "RUNNING" } }) },
      { id: "d", data: () => ({ runtime: "gce-vm", vm: null }) },
    ])).toEqual({ a: "1.1.1.1" });
  });
});

describe("runtime policy and stamping", () => {
  it("resolves tier policy and validates VM configuration", () => {
    expect(resolveBuilderComputerPolicy("s").runtime).toBe("gce-vm");
    expect(resolveBuilderComputerPolicy("m").runtime).toBe("gce-vm");
    expect(resolveBuilderComputerPolicy("l").machineType).toBe("e2-standard-4");
    expect(parseGatewayVmSpec(JSON.stringify(spec))).toEqual(spec);
    expect(() => parseGatewayVmSpec(undefined)).toThrow(/required/);
    expect(() => parseGatewayVmSpec(JSON.stringify({ ...spec, diskSizeGb: "40" }))).toThrow(/diskSizeGb/);
    expect(() => parseGatewayVmSpec(JSON.stringify({ ...spec, homeDiskSizeGb: undefined }))).toThrow("GATEWAY_VM_SPEC_JSON.homeDiskSizeGb must be a positive number");
    expect(() => parseGatewayVmSpec(JSON.stringify({ ...spec, provisioningModel: "PREEMPTIBLE" }))).toThrow(/provisioningModel/);
    expect(() => parseGatewayVmSpec(JSON.stringify({ ...spec, desktop: "kde" }))).toThrow("GATEWAY_VM_SPEC_JSON.desktop must be omarchy or x11");
    expect(() => parseGatewayVmSpec(JSON.stringify({ ...spec, bootDiskType: "pd-standard" }))).toThrow("GATEWAY_VM_SPEC_JSON.bootDiskType must be pd-ssd or pd-balanced");
  });

  it("requires a non-empty list of distinct placement zones and rejects the single-zone shape", () => {
    const zones = ["us-central1-b", "us-central1-c", "us-central1-f"];
    expect(parseGatewayVmSpec(JSON.stringify({ ...spec, zones })).zones).toEqual(zones);
    const { zones: _zones, ...withoutZones } = spec;
    expect(() => parseGatewayVmSpec(JSON.stringify({ ...withoutZones, zone: "us-central1-a", fallbackZones: ["us-central1-b"] }))).toThrow("GATEWAY_VM_SPEC_JSON.zones must be a non-empty array of zone names");
    expect(() => parseGatewayVmSpec(JSON.stringify({ ...spec, zones: [] }))).toThrow("GATEWAY_VM_SPEC_JSON.zones must be a non-empty array of zone names");
    expect(() => parseGatewayVmSpec(JSON.stringify({ ...spec, zones: ["us-central1-b", ""] }))).toThrow("GATEWAY_VM_SPEC_JSON.zones must be a non-empty array of zone names");
    expect(() => parseGatewayVmSpec(JSON.stringify({ ...spec, zones: ["us-central1-b", "us-central1-b"] }))).toThrow("GATEWAY_VM_SPEC_JSON.zones must not repeat a zone");
  });

  it.each([
    ["s", "e2-medium", 40, "pd-balanced", 10, "x11"], ["m", "e2-standard-2", 50, "pd-ssd", 50, "omarchy"], ["l", "e2-standard-4", 50, "pd-ssd", 100, "omarchy"],
  ] as const)("stamps new %s Builders as on-demand computers with their tier's machine, boot disk, desktop and home", async (sizingTier, machineType, diskSizeGb, bootDiskType, homeDiskSizeGb, desktop) => {
    const { db, docs } = fakeDb({});
    expect(await stampGatewayRuntime({ db, gatewayId: "b-new", gatewayClass: "builder", sizingTier, vmSpec: spec, log: vi.fn() })).toBe("gce-vm");
    expect(docs["glmGateways/b-new"]).toEqual({ runtime: "gce-vm", vmSpec: { ...spec, machineType, diskSizeGb, bootDiskType, homeDiskSizeGb, provisioningModel: "STANDARD", desktop } });
  });

  it.each([
    { existing: undefined, sizingTier: "s", expectedRuntime: "gce-vm" },
    { existing: undefined, sizingTier: "m", expectedRuntime: "gce-vm" },
    { existing: { runtime: "gce-vm", vmSpec: { ...spec, machineType: "n2-standard-2", homeDiskSizeGb: 50 } }, sizingTier: "l", expectedRuntime: "gce-vm" },
  ] as const)("rejects storage preflight before stamping or resizing $expectedRuntime", async ({ existing, sizingTier, expectedRuntime }) => {
    const { db, docs, writes } = fakeDb(existing ? { "glmGateways/b-x": existing } : {});
    const before = structuredClone(docs);
    const assertStorage = vi.fn(async () => { throw new Error("storage migration required"); });
    await expect(stampGatewayRuntime({ db, gatewayId: "b-x", gatewayClass: "builder", sizingTier, vmSpec: spec, assertStorage, log: vi.fn() })).rejects.toThrow("storage migration required");
    expect(assertStorage).toHaveBeenCalledExactlyOnceWith(expectedRuntime);
    expect(writes).toEqual([]);
    expect(docs).toEqual(before);
  });

  it("updates desired VM capacity from persisted Pro to Team and back without changing runtime", async () => {
    const { db, docs } = fakeDb({ "glmGateways/b-x": { runtime: "gce-vm", vmSpec: { ...spec, machineType: "e2-standard-2" } } });
    await stampGatewayRuntime({ db, gatewayId: "b-x", gatewayClass: "builder", sizingTier: "l", vmSpec: spec, log: vi.fn() });
    expect(docs["glmGateways/b-x"].vmSpec).toMatchObject({ machineType: "e2-standard-4", homeDiskSizeGb: 100 });
    await stampGatewayRuntime({ db, gatewayId: "b-x", gatewayClass: "builder", sizingTier: "m", vmSpec: spec, log: vi.fn() });
    expect(docs["glmGateways/b-x"].vmSpec).toMatchObject({ machineType: "e2-standard-2", homeDiskSizeGb: 50 });
  });

  it("moves a persisted computer spec to its tier's desktop", async () => {
    const persisted = { ...spec, machineType: "e2-medium", diskSizeGb: 40, bootDiskType: "pd-balanced" as const, homeDiskSizeGb: 10, provisioningModel: "STANDARD" as const, desktop: "omarchy" as const };
    const { db, docs } = fakeDb({ "glmGateways/b-x": { runtime: "gce-vm", vmSpec: persisted } });
    await stampGatewayRuntime({ db, gatewayId: "b-x", gatewayClass: "builder", sizingTier: "s", vmSpec: spec, log: vi.fn() });
    expect(docs["glmGateways/b-x"].vmSpec).toEqual({ ...persisted, desktop: "x11" });
  });

  it("moves a persisted Spot computer spec to its tier's on-demand capacity", async () => {
    const persisted = { ...spec, machineType: "e2-standard-2", diskSizeGb: 50, homeDiskSizeGb: 50, provisioningModel: "SPOT" as const };
    const { db, docs } = fakeDb({ "glmGateways/b-x": { runtime: "gce-vm", vmSpec: persisted } });
    await stampGatewayRuntime({ db, gatewayId: "b-x", gatewayClass: "builder", sizingTier: "m", vmSpec: spec, log: vi.fn() });
    expect(docs["glmGateways/b-x"].vmSpec).toEqual({ ...persisted, provisioningModel: "STANDARD" });
  });

  const deployedCluster = {
    docKind: "runtime", gatewayId: "b-x", lifecycle: "serving",
    helm: { releaseName: "octogee-gw-b-x", deploymentName: "octogee-gateway-b-x", lastAppliedAt: 100 },
    heartbeat: { status: "ready", podName: "octogee-gateway-b-x-abc", startedAt: 110 },
    kubernetes: { status: "ready", totalPods: 1, readyPods: 1, observedAt: 120 },
  };

  it("preserves an unstamped deployed cluster Builder when computers become the new default", async () => {
    const { db, docs } = fakeDb({ "glmGateways/b-x": deployedCluster });
    expect(await stampGatewayRuntime({ db, gatewayId: "b-x", gatewayClass: "builder", sizingTier: "l", vmSpec: spec, log: vi.fn() })).toBe("cluster");
    expect(docs["glmGateways/b-x"]).toEqual({ ...deployedCluster, runtime: "cluster" });
  });

  it("preserves the deployed cluster identity even when its pod is stopped or missing", async () => {
    const previous = { ...deployedCluster, kubernetes: { status: "missing", totalPods: 0, readyPods: 0, observedAt: 130 } };
    const { db, docs } = fakeDb({ "glmGateways/b-x": previous });
    expect(await stampGatewayRuntime({ db, gatewayId: "b-x", gatewayClass: "builder", sizingTier: "l", vmSpec: spec, log: vi.fn() })).toBe("cluster");
    expect(docs["glmGateways/b-x"].runtime).toBe("cluster");
  });

  it("chooses the VM default only before a new Builder has a deployed identity", async () => {
    const { db, docs } = fakeDb({ "glmGateways/b-x": { docKind: "runtime", gatewayId: "b-x", lifecycle: "provisioning", helm: { lastAppliedAt: null }, heartbeat: { status: "unknown" } } });
    expect(await stampGatewayRuntime({ db, gatewayId: "b-x", gatewayClass: "builder", sizingTier: "l", vmSpec: spec, log: vi.fn() })).toBe("gce-vm");
    expect(docs["glmGateways/b-x"].runtime).toBe("gce-vm");
  });

  it("preserves an explicit cluster stamp and accepts generic VM heartbeat names without mistaking them for pod evidence", async () => {
    const { db, writes } = fakeDb({
      "glmGateways/b-x": { ...deployedCluster, runtime: "cluster" },
      "glmGateways/b-vm": { runtime: "gce-vm", vm: recorded, heartbeat: { status: "ready", podName: "generic-vm-hostname" }, helm: { lastAppliedAt: 100, availableReplicas: 1 }, kubernetes: { status: "unknown", totalPods: 0 } },
    });
    expect(await stampGatewayRuntime({ db, gatewayId: "b-x", gatewayClass: "builder", sizingTier: "l", vmSpec: spec, log: vi.fn() })).toBe("cluster");
    expect(await stampGatewayRuntime({ db, gatewayId: "b-vm", gatewayClass: "builder", sizingTier: "s", vmSpec: null, log: vi.fn() })).toBe("gce-vm");
    expect(writes).toEqual([]);
  });

  it.each([
    { ...deployedCluster, runtime: "cluster", vm: recorded },
    { ...deployedCluster, runtime: "gce-vm", vm: recorded },
    { vm: recorded },
    { vmInstance: { enabled: true } },
    { ...deployedCluster, runtime: "unknown-backend" },
  ])("rejects contradictory or malformed runtime state before any write %j", async (existing) => {
    const { db, writes } = fakeDb({ "glmGateways/b-x": existing });
    await expect(stampGatewayRuntime({ db, gatewayId: "b-x", gatewayClass: "builder", sizingTier: "l", vmSpec: spec, log: vi.fn() })).rejects.toThrow(/runtime|conflict|unstamped/);
    expect(writes).toEqual([]);
  });

  it("stamps a Builder gateway with the policy runtime once and never rewrites an existing runtime", async () => {
    const { db, docs, writes } = fakeDb({});
    const log = vi.fn();
    expect(await stampGatewayRuntime({ db, gatewayId: "b-x", gatewayClass: "builder", sizingTier: "l", vmSpec: spec, log })).toBe("gce-vm");
    expect(docs["glmGateways/b-x"]).toEqual({ runtime: "gce-vm", vmSpec: { ...spec, machineType: "e2-standard-4", diskSizeGb: 50, homeDiskSizeGb: 100, provisioningModel: "STANDARD" } });
    expect(await stampGatewayRuntime({ db, gatewayId: "b-x", gatewayClass: "builder", sizingTier: "s", vmSpec: null, log })).toBe("gce-vm");
    expect(writes).toHaveLength(1);
    expect(await stampGatewayRuntime({ db, gatewayId: "shared-1", gatewayClass: "shared", sizingTier: "l", vmSpec: spec, log })).toBe("cluster");
    expect(docs["glmGateways/shared-1"]).toEqual({ runtime: "cluster" });
    await expect(stampGatewayRuntime({ db, gatewayId: "b-z", gatewayClass: "builder", sizingTier: "l", vmSpec: null, log })).rejects.toThrow(/needs a vmSpec/);
  });
});

describe("createRuntimeDispatchingHelmRunner", () => {
  function fakeRunner(name: string, instances: HelmInstancesMap): HelmRunner & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      readDeployedInstances: async () => { calls.push("readAll"); return instances; },
      readDeployedInstance: async ({ gatewayId }) => { calls.push(`read:${gatewayId}`); return instances[gatewayId] ?? null; },
      upsertInstance: async ({ gatewayId }) => { calls.push(`upsert:${gatewayId}`); },
      removeInstance: async ({ gatewayId }) => { calls.push(`remove:${gatewayId}`); },
      listPendingReleases: async () => { calls.push("pending"); return [name]; },
      recoverRelease: async ({ gatewayId }) => { calls.push(`recover:${gatewayId}`); return name; },
    };
  }

  it("rejects simultaneous Helm and VM deployments instead of hiding the cluster observation", async () => {
    const instance = { enabled: true, gatewayId: "b-x", image: { repository: "r", tag: "t" } };
    const cluster = fakeRunner("cluster", { "b-x": instance });
    const vm = fakeRunner("vm", { "b-x": instance });
    const runner = createRuntimeDispatchingHelmRunner({ cluster, vm, isVmGateway: async () => true });
    await expect(runner.readDeployedInstances({ namespace: "ns" })).rejects.toThrow(/conflicting cluster and VM/);
    await expect(runner.readDeployedInstance({ namespace: "ns", gatewayId: "b-x" })).rejects.toThrow(/conflicting cluster and VM/);
    expect(cluster.calls.every((call) => call.startsWith("read"))).toBe(true);
    expect(vm.calls.every((call) => call.startsWith("read"))).toBe(true);
  });

  it.each([true, false])("rejects deployed backend evidence that contradicts the VM stamp %s", async (vmStamped) => {
    const instance = { enabled: true, gatewayId: "b-x", image: { repository: "r", tag: "t" } };
    const cluster = fakeRunner("cluster", vmStamped ? { "b-x": instance } : {});
    const vm = fakeRunner("vm", vmStamped ? {} : { "b-x": instance });
    const runner = createRuntimeDispatchingHelmRunner({ cluster, vm, isVmGateway: async () => vmStamped });
    await expect(runner.readDeployedInstances({ namespace: "ns" })).rejects.toThrow(/conflicting cluster and VM/);
    await expect(runner.readDeployedInstance({ namespace: "ns", gatewayId: "b-x" })).rejects.toThrow(/conflicting cluster and VM/);
  });

  it("merges observations and routes each mutation to the gateway's runtime", async () => {
    const cluster = fakeRunner("cluster", { "shared-1": { enabled: true, gatewayId: "shared-1", image: { repository: "r", tag: "t" } } });
    const vm = fakeRunner("vm", { "b-x": { enabled: true, gatewayId: "b-x", image: { repository: "r", tag: "t" } } });
    const runner = createRuntimeDispatchingHelmRunner({ cluster, vm, isVmGateway: async (id) => id.startsWith("b-") });
    const opts = { namespace: "ns", gatewayId: "b-x", imageRepository: "r", imageTag: "t", chartPath: "/c" };

    expect(Object.keys(await runner.readDeployedInstances({ namespace: "ns" }))).toEqual(["shared-1", "b-x"]);
    await runner.upsertInstance(opts);
    await runner.upsertInstance({ ...opts, gatewayId: "shared-1" });
    await runner.removeInstance({ namespace: "ns", gatewayId: "b-x" });
    expect(await runner.listPendingReleases({ namespace: "ns" })).toEqual(["cluster"]);
    expect(await runner.recoverRelease({ namespace: "ns", gatewayId: "b-x" })).toBe("vm");

    expect(vm.calls).toEqual(["readAll", "upsert:b-x", "remove:b-x", "recover:b-x"]);
    expect(cluster.calls).toEqual(["readAll", "upsert:shared-1", "pending"]);
  });
});


describe("readDeploymentPrerequisiteError", () => {
  it("reports the running computer's missing email scope without mutating it", async () => {
    const h = harness({ "glmGateways/b-x": { runtime: "gce-vm", vm: recorded } }, {
      describe: vi.fn(async () => ({ ...running, serviceAccounts: [{ email: spec.serviceAccountEmail, scopes: [GATEWAY_VM_ACCESS_SCOPES[0]] }] })),
    });
    expect(await h.runtime.readDeploymentPrerequisiteError("b-x")).toContain("pause and resume");
    expect(h.vm.stop).not.toHaveBeenCalled();
    expect(h.vm.bind).not.toHaveBeenCalled();
    expect(h.vm.setServiceAccount).not.toHaveBeenCalled();
    expect(h.writes).toEqual([]);
  });

  it.each(["TERMINATED", "STOPPED", "STOPPING"])("allows a %s computer to complete normal identity repair", async (status) => {
    const h = harness({ "glmGateways/b-x": { runtime: "gce-vm", vm: recorded } }, {
      describe: vi.fn(async () => ({ ...running, status, serviceAccounts: [] })),
    });
    expect(await h.runtime.readDeploymentPrerequisiteError("b-x")).toBeNull();
    expect(h.vm.setServiceAccount).not.toHaveBeenCalled();
  });

  it("uses the gateway's recorded VM spec for its expected identity", async () => {
    const h = harness({ "glmGateways/b-x": { runtime: "gce-vm", vm: recorded, vmSpec: { ...spec, serviceAccountEmail: "another@example.com" } } });
    expect(await h.runtime.readDeploymentPrerequisiteError("b-x")).toContain("identity scopes are outdated");
  });

  it("allows a computer with the expected identity", async () => {
    const h = harness({ "glmGateways/b-x": { runtime: "gce-vm", vm: recorded } });
    expect(await h.runtime.readDeploymentPrerequisiteError("b-x")).toBeNull();
  });

  it("allows first deployment or replacement when no computer exists", async () => {
    const empty = harness({ "gateways/b-x": { ownerUid: "UidA" } });
    expect(await empty.runtime.readDeploymentPrerequisiteError("b-x")).toBeNull();
    expect(empty.vm.describe).not.toHaveBeenCalled();
    const missing = harness({ "gateways/b-x": { ownerUid: "UidA" }, "glmGateways/b-x": { runtime: "gce-vm", vm: recorded } }, { describe: vi.fn(async () => null) });
    expect(await missing.runtime.readDeploymentPrerequisiteError("b-x")).toBeNull();
  });

  it.each([false, true])("checks the authoritative owner's computer when the recorded VM is absent (stale reference: %s)", async (staleReference) => {
    const h = harness({
      "gateways/b-x": { ownerUid: "UidA" },
      "glmGateways/b-x": { runtime: "gce-vm", ...(staleReference ? { vm: recorded } : {}), vmInstance: { ownerUid: "stale-owner" } },
    }, {
      describe: vi.fn(async () => null),
      findByLabels: vi.fn(async () => ({ ...running, serviceAccounts: [{ email: spec.serviceAccountEmail, scopes: [GATEWAY_VM_ACCESS_SCOPES[0]] }] })),
    });
    expect(await h.runtime.readDeploymentPrerequisiteError("b-x")).toContain("pause and resume");
    expect(h.vm.findByLabels).toHaveBeenCalledWith(OWNER_LABELS);
    expect(h.vm.create).not.toHaveBeenCalled();
    expect(h.vm.stop).not.toHaveBeenCalled();
    expect(h.vm.bind).not.toHaveBeenCalled();
    expect(h.vm.setServiceAccount).not.toHaveBeenCalled();
    expect(h.writes).toEqual([]);
  });

  it("allows the owner-labeled stopped computer to use normal identity repair", async () => {
    const h = harness({ "gateways/b-x": { ownerUid: "UidA" } }, {
      findByLabels: vi.fn(async () => ({ ...stopped, serviceAccounts: [] })),
    });
    expect(await h.runtime.readDeploymentPrerequisiteError("b-x")).toBeNull();
    expect(h.vm.findByLabels).toHaveBeenCalledWith(OWNER_LABELS);
    expect(h.vm.setServiceAccount).not.toHaveBeenCalled();
  });

  it("fails before discovery when there is no authoritative Builder owner", async () => {
    const h = harness({ "glmGateways/b-x": { runtime: "gce-vm", vmInstance: { ownerUid: "stale-owner" } } });
    expect(await h.runtime.readDeploymentPrerequisiteError("b-x")).toContain("needs an owner");
    expect(h.vm.findByLabels).not.toHaveBeenCalled();
  });

  it("propagates owner-label discovery failures for the rollout retry policy", async () => {
    const h = harness({ "gateways/b-x": { ownerUid: "UidA" } }, {
      findByLabels: vi.fn(async () => { throw new Error("ECONNRESET"); }),
    });
    await expect(h.runtime.readDeploymentPrerequisiteError("b-x")).rejects.toThrow("ECONNRESET");
  });

  it("propagates Compute failures for the rollout retry policy", async () => {
    const h = harness({ "glmGateways/b-x": { runtime: "gce-vm", vm: recorded } }, { describe: vi.fn(async () => { throw new Error("ECONNRESET"); }) });
    await expect(h.runtime.readDeploymentPrerequisiteError("b-x")).rejects.toThrow("ECONNRESET");
  });
});

describe("computer preemption", () => {
  const vmDoc = (vm: Record<string, unknown> = {}) => ({
    "glmGateways/b-x": { docKind: "runtime", gatewayId: "b-x", runtime: "gce-vm", vm: { ...recorded, ...vm }, vmInstance: { enabled: true } },
  });

  it("names the computer Compute preempted at or after the migration started", async () => {
    const h = harness(vmDoc(), { lastPreemptedAt: vi.fn(async () => 5_000) });

    expect(await h.runtime.detectPreemption("b-x", 5_000)).toBe(COMPUTER);
    expect(h.vm.lastPreemptedAt).toHaveBeenCalledWith(COMPUTER, "us-west1-b");
    expect(h.log).toHaveBeenCalledWith(expect.stringMatching(/b-x: Compute preempted octogee-computer-test-uida at 1970-01-01T00:00:05.000Z/));
  });

  it("does not blame a preemption that predates the migration, a computer never preempted, or a gateway without a computer", async () => {
    expect(await harness(vmDoc(), { lastPreemptedAt: vi.fn(async () => 4_999) }).runtime.detectPreemption("b-x", 5_000)).toBeNull();
    expect(await harness(vmDoc()).runtime.detectPreemption("b-x", 5_000)).toBeNull();
    const cluster = harness({ "glmGateways/b-x": { docKind: "runtime", gatewayId: "b-x", runtime: "cluster" } }, { lastPreemptedAt: vi.fn(async () => 9_000) });
    expect(await cluster.runtime.detectPreemption("b-x", 5_000)).toBeNull();
    expect(cluster.vm.lastPreemptedAt).not.toHaveBeenCalled();
  });

  it("trusts the computer's own preemption notice before Compute has recorded the preemption", async () => {
    const docs = vmDoc();
    docs["glmGateways/b-x"].vmPreemption = { instanceId: "4242", announcedAt: 5_500 };
    const h = harness(docs);

    expect(await h.runtime.detectPreemption("b-x", 5_000)).toBe(COMPUTER);
    expect(h.vm.lastPreemptedAt).not.toHaveBeenCalled();
    expect(h.log).toHaveBeenCalledWith(expect.stringMatching(/b-x: octogee-computer-test-uida announced its preemption at 1970-01-01T00:00:05.500Z/));
  });

  it("ignores a preemption notice from an earlier run or another instance", async () => {
    const earlier = vmDoc();
    earlier["glmGateways/b-x"].vmPreemption = { instanceId: "4242", announcedAt: 4_000 };
    expect(await harness(earlier).runtime.detectPreemption("b-x", 5_000)).toBeNull();
    const replaced = vmDoc();
    replaced["glmGateways/b-x"].vmPreemption = { instanceId: "1111", announcedAt: 5_500 };
    expect(await harness(replaced).runtime.detectPreemption("b-x", 5_000)).toBeNull();
  });

  it("says a computer Compute preempted was preempted when retirement parks it, instead of claiming an idle stop", async () => {
    const h = harness(vmDoc(), { describe: vi.fn(async () => stopped), lastPreemptedAt: vi.fn(async () => 900) });

    await h.runtime.removeInstance({ namespace: "octogee-test", gatewayId: "b-x" });

    expect(h.vm.stop).not.toHaveBeenCalled();
    expect(h.log).toHaveBeenCalledWith(expect.stringMatching(
      /b-x: octogee-computer-test-uida was preempted by Compute at 1970-01-01T00:00:00.900Z -> TERMINATED; parked for idle/,
    ));
    expect(h.log).not.toHaveBeenCalledWith(expect.stringMatching(/stopped octogee-computer-test-uida for idle/));
  });

  it("says a computer that stopped without Cowboy or a preemption stopped outside Cowboy", async () => {
    const h = harness(vmDoc(), { describe: vi.fn(async () => stopped) });

    await h.runtime.removeInstance({ namespace: "octogee-test", gatewayId: "b-x" });

    expect(h.log).toHaveBeenCalledWith(expect.stringMatching(/b-x: octogee-computer-test-uida was already TERMINATED \(stopped outside Cowboy\); parked for idle/));
  });

  it("still parks the computer when the preemption lookup fails, and says so", async () => {
    const h = harness(vmDoc(), { describe: vi.fn(async () => stopped), lastPreemptedAt: vi.fn(async () => { throw new Error("http 403"); }) });

    await h.runtime.removeInstance({ namespace: "octogee-test", gatewayId: "b-x" });

    expect(h.docs["glmGateways/b-x"].vm).toMatchObject({ status: "TERMINATED", stopReason: "idle" });
    expect(h.log).toHaveBeenCalledWith(expect.stringMatching(/b-x: could not read Compute preemptions of octogee-computer-test-uida: http 403/));
  });
});


describe("GCS-backed disposable Builder parking", () => {
  const saved = { name: "20260905T101500Z.tar.gz", size: 2048, sha256: "a".repeat(64), generation: "9007199254740995", coverage: "builder-home-v2" as const, writerProtocol: 3 as const, instanceId: "4242", completedAt: 1500 };
  const docs = () => ({
    "glmGateways/b-x": { runtime: "gce-vm", vm: { ...recorded }, vmInstance: { ownerUid: "UidA" }, vmHome: { checkpointRequestedAt: 1000, parkRequestedAt: 1000, checkpointAcknowledgedAt: 1000, lastCheckpoint: { ...saved } } },
    "users/UidA": { provisioning: { openclaw: { gatewayId: "b-x" } } },
  });
  it("defaults off and rejects an invalid rollout setting", () => {
    expect(resolveDisposableBuilderParking({})).toBe(false);
    expect(() => resolveDisposableBuilderParking({ GATEWAY_BUILDER_DISPOSABLE_PARKING: "true", GATEWAY_BUILDER_DISPOSABLE_STATE_CONTRACT: "checkpointed-home-only-v2" })).toThrow(/withdrawn/);
    expect(() => resolveDisposableBuilderParking({ GATEWAY_BUILDER_DISPOSABLE_PARKING: "yes" })).toThrow();
  });
  it("retains both disks when protocol 2 leaves SSH writers unfenced, even with disposal enabled and a fresh held checkpoint", async () => {
    const records = docs();
    (records["glmGateways/b-x"].vmHome.lastCheckpoint as { writerProtocol: 2 | 3 }).writerProtocol = 2;
    const h = harness(records, { describe: vi.fn(async () => suspended).mockResolvedValueOnce(running) }, "172.20.7.7", { "b-x": "retired" }, { disposableParking: true, clock: { now: 2000 } });
    await h.runtime.removeInstance({ namespace: "octogee-test", gatewayId: "b-x" });
    expect(h.vm.suspend).toHaveBeenCalledWith(COMPUTER, "us-west1-b");
    expect(h.vm.delete).not.toHaveBeenCalled();
    expect(h.docs["glmGateways/b-x"].vm).toMatchObject({ instanceId: "4242", stopReason: "idle" });
    expect(readPath(h.docs["users/UidA"], "provisioning.computer")).not.toMatchObject({ disposable: true });
  });
  it("retains the original disk even with a future protocol and legacy disposal flag", async () => {
    const h = harness(docs(), { describe: vi.fn(async () => stopped).mockResolvedValueOnce(running) }, "172.20.7.7", { "b-x": "retired" }, { disposableParking: true, clock: { now: 2000 } });
    await h.runtime.removeInstance({ namespace: "octogee-test", gatewayId: "b-x" });
    expect(h.vm.delete).not.toHaveBeenCalled();
    expect(h.docs["glmGateways/b-x"].vm).toMatchObject({ instanceId: "4242", stopReason: "idle" });
  });
  it.each(["wrong-instance", "missing-generation", "released", "not-acknowledged", "restarted"])("retains the disk for unsafe evidence: %s", async (reason) => {
    const records = docs();
    const home = records["glmGateways/b-x"].vmHome;
    if (reason === "wrong-instance") home.lastCheckpoint.instanceId = "other";
    if (reason === "missing-generation") delete (home.lastCheckpoint as Partial<typeof saved>).generation;
    if (reason === "released") home.checkpointRequestedAt = 0;
    if (reason === "not-acknowledged") home.checkpointAcknowledgedAt = 999;
    const vm = reason === "restarted" ? { ...stopped, lastStartedAt: 1600 } : stopped;
    const h = harness(records, { describe: vi.fn(async () => vm) }, "172.20.7.7", { "b-x": "retired" }, { disposableParking: true, clock: { now: 2000 } });
    await h.runtime.removeInstance({ namespace: "octogee-test", gatewayId: "b-x" });
    expect(h.vm.delete).not.toHaveBeenCalled();
  });
  it("refuses disposal if the checkpoint is released during stop", async () => {
    const h = harness(docs(), { describe: vi.fn(async () => suspended).mockResolvedValueOnce(running), suspend: vi.fn(async () => {
      (h.docs["glmGateways/b-x"].vmHome as { checkpointRequestedAt: number }).checkpointRequestedAt = 0;
    }) }, "172.20.7.7", { "b-x": "retired" }, { disposableParking: true });
    await h.runtime.removeInstance({ namespace: "octogee-test", gatewayId: "b-x" });
    expect(h.vm.delete).not.toHaveBeenCalled();
  });
  it("refuses disposal if the recorded owner changes during stop", async () => {
    const h = harness(docs(), { describe: vi.fn(async () => suspended).mockResolvedValueOnce(running), suspend: vi.fn(async () => {
      (h.docs["glmGateways/b-x"].vmInstance as { ownerUid: string }).ownerUid = "OtherOwner";
    }) }, "172.20.7.7", { "b-x": "retired" }, { disposableParking: true });
    await h.runtime.removeInstance({ namespace: "octogee-test", gatewayId: "b-x" });
    expect(h.vm.delete).not.toHaveBeenCalled();
  });
  it("resumes the retained source disk after a failed disposal without restoring older data", async () => {
    const records: Docs = docs();
    records["users/UidA"].provisioning = { homeCheckpoint: saved };
    const h = harness(records, { describe: vi.fn(async () => running).mockResolvedValueOnce(stopped) });
    await h.runtime.upsertInstance(upsertOpts);
    expect(h.vm.start).toHaveBeenCalled();
    expect(readPath(h.docs["glmGateways/b-x"], "vmHome.restoreCheckpoint")).toBeUndefined();
  });
  it("preserves the recovery anchor through failed restoration, stale parking, and gateway deletion", async () => {
    const records: Docs = { "users/UidA": { provisioning: { homeCheckpoint: saved } }, "glmGateways/b-x": { runtime: "gce-vm", vm: { ...recorded, instanceId: "5252" }, vmInstance: { ownerUid: "UidA" }, vmHome: { restoreCheckpoint: saved } } };
    const failedRestoreVm = { ...stopped, instanceId: "5252" };
    const h = harness(records, { describe: vi.fn(async () => failedRestoreVm) }, "172.20.7.7", { "b-x": "retired" }, { disposableParking: true });
    await h.runtime.removeInstance({ namespace: "octogee-test", gatewayId: "b-x" });
    expect(readPath(h.docs["users/UidA"], "provisioning.homeCheckpoint")).toEqual(saved);
    delete h.docs["glmGateways/b-x"];
    h.docs["glmGateways/b-x"] = { runtime: "gce-vm" };
    h.vm.describe = vi.fn(async () => null);
    h.vm.findByLabels = vi.fn(async () => ({ ...failedRestoreVm, gatewayId: "b-x" }));
    h.vm.bind = vi.fn(async () => {
      expect(readPath(h.docs["glmGateways/b-x"], "vmHome.restoreCheckpoint")).toEqual(saved);
    });
    await h.runtime.upsertInstance(upsertOpts);
    expect(readPath(h.docs["glmGateways/b-x"], "vmHome.restoreCheckpoint")).toEqual(saved);
    expect(readPath(h.docs["users/UidA"], "provisioning.homeCheckpoint")).toEqual(saved);
  });
  it("does not release an active checkpoint when an existing restored computer is rerendered", async () => {
    const records: Docs = docs();
    records["users/UidA"].provisioning = { homeCheckpoint: saved };
    records["glmGateways/b-x"].vm = { ...recorded, instanceId: "5252" };
    records["glmGateways/b-x"].vmHome = { restoreCheckpoint: saved, checkpointRequestedAt: 3000, parkRequestedAt: 3000 };
    const h = harness(records, { describe: vi.fn(async () => ({ ...running, instanceId: "5252" })) });
    await h.runtime.upsertInstance(upsertOpts);
    expect(readPath(h.docs["glmGateways/b-x"], "vmHome.checkpointRequestedAt")).toBe(3000);
  });
  it("keeps the disk when activation changes the desired status during shutdown", async () => {
    const desired = { "b-x": "retired" };
    const h = harness(docs(), { describe: vi.fn(async () => suspended).mockResolvedValueOnce(running), suspend: vi.fn(async () => { desired["b-x"] = "running"; }) }, "172.20.7.7", desired, { disposableParking: true });
    await h.runtime.removeInstance({ namespace: "octogee-test", gatewayId: "b-x" });
    expect(h.vm.delete).not.toHaveBeenCalled();
  });

});

describe("idle computer storage coverage", () => {
  it("retains both Omarchy disks even with a fresh checkpoint and obsolete boot image", async () => {
    const h = harness({ "glmGateways/b-x": { gatewayId: "b-x", runtime: "gce-vm", vmInstance: { ownerUid: "UidA" }, vm: recorded, vmSpec: spec,
      vmHome: { parkRequestedAt: 1000, checkpointRequestedAt: 1000, checkpointAcknowledgedAt: 1000, lastCheckpoint: { completedAt: 1500 } } },
      "users/UidA": { provisioning: { openclaw: { gatewayId: "b-x" } } } }, {
      describe: vi.fn(async () => suspended).mockResolvedValueOnce(running), readBootImage: vi.fn(async () => OLD_IMAGE),
    }, "172.20.7.7", {}, { clock: { now: 2000 } });
    await h.runtime.removeInstance({ namespace: "octogee-test", gatewayId: "b-x" });
    expect(h.vm.suspend).toHaveBeenCalledWith(COMPUTER, "us-west1-b");
    expect(h.vm.delete).not.toHaveBeenCalled();
    expect(h.docs["glmGateways/b-x"].vmSpec).toEqual(spec);
    expect(readPath(h.docs["users/UidA"], "provisioning.computer")).toMatchObject({ instanceName: COMPUTER, checkpoint: { outcome: "fresh" } });
  });

  it("wakes the original parked computer instead of deleting an unarchived system disk", async () => {
    const h = harness({ "glmGateways/b-x": { gatewayId: "b-x", runtime: "gce-vm", vm: recorded, vmSpec: spec },
      "users/UidA": { provisioning: { computer: { instanceName: COMPUTER, zone: "us-west1-b", instanceId: "4242", gatewayId: "b-x", parkedAt: 500, checkpoint: { outcome: "fresh", requestedAt: 400, completedAt: 450 } } } } }, {
      describe: vi.fn(async () => stopped), readBootImage: vi.fn(async () => OLD_IMAGE),
    });
    await h.runtime.upsertInstance(upsertOpts);
    expect(h.vm.start).toHaveBeenCalledWith(COMPUTER, "us-west1-b");
    expect(h.vm.delete).not.toHaveBeenCalled();
    expect(h.vm.create).not.toHaveBeenCalled();
  });

  it.each([["m", "l", "e2-standard-2", "e2-standard-4"], ["l", "m", "e2-standard-4", "e2-standard-2"]] as const)("applies persisted %s to %s changes before starting while preserving disks", async (_from, target, oldType, newType) => {
    let computer = { ...stopped, machineType: oldType as string };
    const h = harness({ "glmGateways/b-x": { gatewayId: "b-x", runtime: "gce-vm", vm: recorded, vmSpec: { ...spec, machineType: oldType } } }, {
      describe: vi.fn(async () => computer),
      setMachineType: vi.fn(async (_name, _zone, machineType) => { computer = { ...computer, machineType }; }),
      setProvisioningModel: vi.fn(async (_name, _zone, provisioningModel) => { computer = { ...computer, provisioningModel }; }),
      start: vi.fn(async () => { computer = { ...computer, status: "RUNNING" }; return { fellBackToStandard: false }; }),
    });
    await stampGatewayRuntime({ db: h.db, gatewayId: "b-x", gatewayClass: "builder", sizingTier: target, vmSpec: spec, log: h.log });
    await h.runtime.upsertInstance({ ...upsertOpts, sizingTier: target });
    expect(h.vm.setMachineType).toHaveBeenCalledWith(COMPUTER, "us-west1-b", newType);
    expect(h.vm.setMachineType.mock.invocationCallOrder[0]).toBeLessThan(h.vm.start.mock.invocationCallOrder[0]);
    expect(h.vm.delete).not.toHaveBeenCalled();
    expect(h.vm.create).not.toHaveBeenCalled();
  });
});


describe("retained home disk recovery", () => {
  const home = { projectId: "octogee-test", zone: "us-west1-b", name: "computer-home", id: "777", sizeGb: 30, diskType: "pd-ssd" as const, source: "projects/octogee-test/zones/us-west1-b/disks/computer-home" };
  it("retains the exact larger original home after VM loss and blocks an unqualified replacement boot", async () => {
    const h = harness({ "glmGateways/b-x": { runtime: "gce-vm" }, "users/UidA": { provisioning: { homeDisk: home } } }, { describe: vi.fn(async () => null) });
    await expect(h.runtime.upsertInstance(upsertOpts)).rejects.toThrow(/qualified current-SSH authority/);
    expect(h.vm.verifyDetachedHome).toHaveBeenCalledWith(home, "UidA");
    expect(h.vm.create).not.toHaveBeenCalled();
    expect(h.vm.start).not.toHaveBeenCalled();
    expect(readPath(h.docs["users/UidA"], "provisioning.homeDisk")).toEqual(home);
  });
  it("blocks provisioning when retained home is attached elsewhere or its identity cannot be verified", async () => {
    const h = harness({ "glmGateways/b-x": { runtime: "gce-vm" }, "users/UidA": { provisioning: { homeDisk: home } } }, { describe: vi.fn(async () => null), verifyDetachedHome: vi.fn(async () => { throw new Error("retained home is attached elsewhere"); }) });
    await expect(h.runtime.upsertInstance(upsertOpts)).rejects.toThrow("attached elsewhere");
    expect(h.vm.create).not.toHaveBeenCalled();
    expect(h.vm.start).not.toHaveBeenCalled();
  });
  it("blocks adoption of a different disk instead of overwriting the original recovery anchor", async () => {
    const h = harness({ "glmGateways/b-x": { runtime: "gce-vm", vm: recorded }, "users/UidA": { provisioning: { homeDisk: { ...home, id: "888" } } } });
    await expect(h.runtime.upsertInstance(upsertOpts)).rejects.toThrow(/original home/);
    expect(readPath(h.docs["users/UidA"], "provisioning.homeDisk.id")).toBe("888");
  });
  it("refuses another owner's source before rebinding or starting it", async () => {
    const h = harness({ "glmGateways/b-x": { runtime: "gce-vm", vm: recorded } }, { describe: vi.fn(async () => ({ ...stopped, metadata: { ...stopped.metadata, "octogee-owner-uid": "OtherOwner" } })) });
    await expect(h.runtime.upsertInstance(upsertOpts)).rejects.toThrow(/owner differs/);
    expect(h.vm.bind).not.toHaveBeenCalled();
    expect(h.vm.start).not.toHaveBeenCalled();
    expect(h.vm.retainHome).not.toHaveBeenCalled();
    expect(h.vm.deleteRetainingHome).not.toHaveBeenCalled();
  });
  it("retries a failed anchor clear after confirmed disk erasure without deleting another disk", async () => {
    let exists = true;
    let deletes = 0;
    let failClear = true;
    const client = createComputerHomeClient({ projectId: home.projectId, readInstance: async () => null,
      waitForOperation: async () => {}, request: async request => {
        if (request.method === "DELETE") { exists = false; deletes++; return { status: 200, data: { status: "DONE" } }; }
        if (!exists) throw Object.assign(new Error("missing disk"), { response: { status: 404 } });
        return { status: 200, data: { ...home, type: "zones/us-west1-b/diskTypes/pd-ssd", labels: { "octogee-owner-uid": "uida", "octogee-storage": "customer-home" } } };
      } });
    const h = harness({ "users/UidA": { provisioning: { homeDisk: home } } }, { deleteRetainedHome: client.deleteRetainedHome }, undefined, undefined,
      { beforeWrite: (_path, data) => {
        const disk = (data.provisioning as { homeDisk?: unknown })?.homeDisk;
        if (failClear && disk instanceof FieldValue && disk.isEqual(FieldValue.delete())) { failClear = false; throw new Error("anchor clear unavailable"); }
      } });
    await expect(h.runtime.deleteComputer("UidA")).rejects.toThrow("anchor clear unavailable");
    expect(readPath(h.docs["users/UidA"], "provisioning.homeDisk")).toEqual(home);
    await expect(h.runtime.deleteComputer("UidA")).resolves.toBe(true);
    expect(readPath(h.docs["users/UidA"], "provisioning.homeDisk")).toBeUndefined();
    expect(deletes).toBe(1);
  });
  it("erases an orphaned retained home only through explicit account erase", async () => {
    const h = harness({ "users/UidA": { provisioning: { homeDisk: home } } });
    await expect(h.runtime.deleteComputer("UidA")).resolves.toBe(true);
    expect(h.vm.deleteRetainedHome).toHaveBeenCalledWith(home, "UidA");
    expect(h.vm.delete).not.toHaveBeenCalled();
    expect(readPath(h.docs["users/UidA"], "provisioning.homeDisk")).toBeUndefined();
  });
});


describe("stopped retained-home boot replacement", () => {
  const home = { projectId: "octogee-test", zone: "us-west1-b", name: "computer-home", id: "777", sizeGb: 30, diskType: "pd-ssd" as const, source: "projects/octogee-test/zones/us-west1-b/disks/computer-home" };
  const receipt = { currentPointId: "image-old-" + "a".repeat(32), retainedPoints: 1, ready: true, bundleVersion: "v1", freeBytes: 3 * 1024 ** 3, instanceId: "4242", observedAt: 1000 };
  const vmDoc = (): Docs => ({ "glmGateways/b-x": { runtime: "gce-vm", vm: recorded, vmSpec: spec, vmBootRecovery: receipt } });
  const ownedStopped = { ...stopped, metadata: { ...stopped.metadata, "octogee-owner-uid": "UidA" } };
  const accepted = { name: "octogee-computer-accepted", id: "222", homeAdmission: true as const };
  it("updates an outdated stopped computer on boot while retaining its home", async () => {
    let deleted = false;
    const h = harness(vmDoc(), {
      describe: vi.fn(async () => deleted ? null : ownedStopped),
      deleteRetainingHome: vi.fn(async () => { deleted = true; return true; }),
      readBootImage: vi.fn(async () => CURRENT_IMAGE),
      readFamilyImage: vi.fn(async () => accepted),
      readImage: vi.fn(async () => accepted),
    });
    await h.runtime.upsertInstance(upsertOpts);
    expect(h.vm.deleteRetainingHome).toHaveBeenCalledWith(COMPUTER, ownedStopped.zone, "UidA", expect.objectContaining(home), "4242");
    expect(h.vm.create).toHaveBeenCalledWith(expect.objectContaining({ retainedHome: expect.objectContaining(home), image: expect.objectContaining(accepted) }));
    expect(h.vm.start).not.toHaveBeenCalled();
  });
  it("resumes a suspended computer on an outdated boot instead of stopping and replacing it", async () => {
    const h = harness(vmDoc(), {
      describe: vi.fn(async () => ({ ...ownedStopped, status: "SUSPENDED" })),
      readBootImage: vi.fn(async () => CURRENT_IMAGE),
      readFamilyImage: vi.fn(async () => accepted),
      readImage: vi.fn(async () => accepted),
    });
    await h.runtime.upsertInstance(upsertOpts);
    expect(h.vm.resume).toHaveBeenCalledWith(COMPUTER, ownedStopped.zone);
    expect(h.vm.stop).not.toHaveBeenCalled();
    expect(h.vm.deleteRetainingHome).not.toHaveBeenCalled();
    expect(h.vm.create).not.toHaveBeenCalled();
    expect(h.vm.readFamilyImage).not.toHaveBeenCalled();
  });
  it("updates a parked computer when a new Builder gateway claims it from Shared", async () => {
    let deleted = false;
    let source = { ...ownedStopped, gatewayId: "b-old", labels: { ...ownedStopped.labels, "octogee-gateway-id": "b-old" }, metadata: { ...ownedStopped.metadata, "gateway-id": "b-old" } };
    const parked = { instanceName: COMPUTER, zone: source.zone, instanceId: "4242", gatewayId: "b-old", parkedAt: 1000, checkpoint: { outcome: "fresh", requestedAt: 400, completedAt: 450 }, bootRecovery: receipt, vmSpec: spec };
    const h = harness({ "glmGateways/b-x": { runtime: "gce-vm", vmSpec: spec }, "gateways/shared-0": { gatewayClass: "shared" }, "users/UidA": { provisioning: { openclaw: { gatewayId: "shared-0" }, computer: parked } } }, {
      describe: vi.fn(async () => deleted ? null : source), findByLabels: vi.fn(async () => deleted ? null : source),
      bind: vi.fn(async (_name, _zone, binding) => { source = { ...source, gatewayId: "b-x", labels: binding.labels, metadata: binding.metadata }; }),
      deleteRetainingHome: vi.fn(async () => { deleted = true; return true; }),
      readBootImage: vi.fn(async () => CURRENT_IMAGE), readFamilyImage: vi.fn(async () => accepted), readImage: vi.fn(async () => accepted),
    });
    await h.runtime.upsertInstance(upsertOpts);
    expect(h.vm.deleteRetainingHome).toHaveBeenCalled();
    expect(h.vm.create).toHaveBeenCalledWith(expect.objectContaining({ retainedHome: expect.objectContaining(home), image: expect.objectContaining(accepted) }));
  });
  it("upgrades at boot after best-effort project autosave even when work may remain on the old disk", async () => {
    let deleted = false;
    const h = harness({ ...vmDoc(), "users/UidA": { provisioning: { openclaw: { gatewayId: "b-x" }, projectStorage: { nativeBoot: true } } } }, {
      describe: vi.fn(async () => deleted ? null : ownedStopped), deleteRetainingHome: vi.fn(async () => { deleted = true; return true; }),
      readBootImage: vi.fn(async () => CURRENT_IMAGE), readFamilyImage: vi.fn(async () => accepted), readImage: vi.fn(async () => accepted),
    });
    await h.runtime.upsertInstance(upsertOpts);
    expect(h.vm.deleteRetainingHome).toHaveBeenCalled();
    expect(h.vm.create).toHaveBeenCalledWith(expect.objectContaining({ retainedHome: expect.objectContaining(home) }));
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining("unsaved project work"));
  });
  it("upgrades a preempted computer when it restarts, retaining its home and runtime binding", async () => {
    let deleted = false;
    const source = { ...ownedStopped, metadata: { ...ownedStopped.metadata, "gateway-image": "registry/gateway:old", "octogee-api-url": "http://172.20.7.7:3001" } };
    const instance = { ownerUid: "UidA", image: { repository: "registry/gateway", tag: "old" } };
    const docs = vmDoc();
    docs["glmGateways/b-x"].vmInstance = instance;
    const h = harness(docs, {
      describe: vi.fn(async () => deleted ? null : source), deleteRetainingHome: vi.fn(async () => { deleted = true; return true; }),
      readBootImage: vi.fn(async () => CURRENT_IMAGE), readFamilyImage: vi.fn(async () => accepted), readImage: vi.fn(async () => accepted),
    });
    await h.runtime.recoverUnreachable("b-x");
    expect(h.vm.deleteRetainingHome).toHaveBeenCalled();
    expect(h.vm.create).toHaveBeenCalledWith(expect.objectContaining({ retainedHome: expect.objectContaining(home), image: expect.objectContaining(accepted) }));
    expect(h.docs["glmGateways/b-x"].vmInstance).toEqual(instance);
    expect(h.vm.start).not.toHaveBeenCalled();
  });
  it("recovers a preemption upgrade when the old computer was deleted but its acknowledgement was lost", async () => {
    let deleted = false;
    const source = { ...ownedStopped, metadata: { ...ownedStopped.metadata, "gateway-image": "registry/gateway:old", "octogee-api-url": "http://172.20.7.7:3001" } };
    const docs = vmDoc();
    docs["glmGateways/b-x"].vmInstance = { ownerUid: "UidA", image: { repository: "registry/gateway", tag: "old" } };
    const h = harness(docs, {
      describe: vi.fn(async () => deleted ? null : source), deleteRetainingHome: vi.fn(async () => { deleted = true; throw new Error("acknowledgement lost"); }),
      readBootImage: vi.fn(async () => CURRENT_IMAGE), readFamilyImage: vi.fn(async () => accepted), readImage: vi.fn(async () => accepted),
    });
    await expect(h.runtime.recoverUnreachable("b-x")).rejects.toThrow("acknowledgement lost");
    await h.runtime.recoverUnreachable("b-x");
    expect(h.vm.create).toHaveBeenCalledWith(expect.objectContaining({ retainedHome: expect.objectContaining(home), image: expect.objectContaining(accepted) }));
  });
  it("restarts the preempted computer when the latest image cannot be checked", async () => {
    const source = { ...ownedStopped, metadata: { ...ownedStopped.metadata, "gateway-image": "registry/gateway:old", "octogee-api-url": "http://172.20.7.7:3001" } };
    const h = harness(vmDoc(), {
      describe: vi.fn(async () => source), readBootImage: vi.fn(async () => CURRENT_IMAGE),
      readFamilyImage: vi.fn(async () => { throw new Error("image service unavailable"); }),
    });
    await h.runtime.recoverUnreachable("b-x");
    expect(h.vm.deleteRetainingHome).not.toHaveBeenCalled();
    expect(h.vm.start).toHaveBeenCalledWith(COMPUTER, source.zone);
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining("image service unavailable"));
  });
  it("does not start a missing source after a lost replacement acknowledgement", async () => {
    let deleted = false;
    const h = harness(vmDoc(), {
      describe: vi.fn(async () => deleted ? null : ownedStopped),
      deleteRetainingHome: vi.fn(async () => { deleted = true; throw new Error("acknowledgement lost"); }),
      readBootImage: vi.fn(async () => CURRENT_IMAGE), readFamilyImage: vi.fn(async () => accepted), readImage: vi.fn(async () => accepted),
    });
    await expect(h.runtime.upsertInstance(upsertOpts)).rejects.toThrow("acknowledgement lost");
    expect(h.vm.start).not.toHaveBeenCalled();
    await h.runtime.upsertInstance(upsertOpts);
    expect(h.vm.create).toHaveBeenCalledWith(expect.objectContaining({ retainedHome: expect.objectContaining(home), image: expect.objectContaining(accepted) }));
  });
  it("keeps the source when the admitted image family changes during replacement", async () => {
    const h = harness(vmDoc(), {
      describe: vi.fn(async () => ownedStopped), readBootImage: vi.fn(async () => CURRENT_IMAGE),
      readFamilyImage: vi.fn().mockResolvedValueOnce(accepted).mockResolvedValue({ ...accepted, id: "333" }),
    });
    await h.runtime.upsertInstance(upsertOpts);
    expect(h.vm.deleteRetainingHome).not.toHaveBeenCalled();
    expect(h.vm.start).toHaveBeenCalled();
  });
  it("keeps a stopped native boot that may hold unpublished project work", async () => {
    const h = harness({ ...vmDoc(), "users/UidA": { provisioning: { projectStorage: { nativeBoot: true } } } }, { describe: vi.fn(async () => ownedStopped), readFamilyImage: vi.fn(async () => accepted) }, undefined, { "b-x": "paused" });
    await expect(h.runtime.replaceStoppedComputer("b-x", "op-projects", async () => {})).rejects.toThrow(/project work/);
    expect(h.vm.deleteRetainingHome).not.toHaveBeenCalled();
  });
  it("permits operator force recovery of a stopped computer while retaining its exact home", async () => {
    const docs = { ...vmDoc(), "gateways/b-x": { ownerUid: "UidA", gatewayClass: "builder", desiredStatus: "paused" }, "gateways/shared-1": { gatewayClass: "shared" }, "gateways/shared-1/assignments/UidA": { uid: "UidA", gatewayId: "shared-1", state: "serving", epoch: 1 }, "users/UidA": { provisioning: { projectStorage: { nativeBoot: true }, openclaw: { gatewayId: "shared-1" }, computerRecovery: { operationId: "op-force", gatewayId: "b-x", instanceId: "4242", sharedGatewayId: "shared-1", assignmentEpoch: 1 } } } };
    delete docs["glmGateways/b-x"].vmBootRecovery;
    const h = harness(docs, { describe: vi.fn(async () => ownedStopped), readFamilyImage: vi.fn(async () => accepted) }, undefined, { "b-x": "paused" });
    await expect(h.runtime.replaceStoppedComputer("b-x", "op-force", async () => {}, { forceOwnerUid: "UidA", expectedInstanceId: "4242" })).resolves.toMatchObject({ bootDeleted: true, force: true });
    expect(h.vm.retainHome).toHaveBeenCalledWith(COMPUTER, ownedStopped.zone, "UidA");
    expect(h.vm.deleteRetainingHome).toHaveBeenCalledWith(COMPUTER, ownedStopped.zone, "UidA", expect.objectContaining(home), "4242");
  });
  it("never force-replaces a running or foreign computer", async () => {
    for (const { observed, owner } of [
      { observed: { ...ownedStopped, status: "RUNNING" }, owner: "UidA" },
      { observed: { ...ownedStopped, instanceId: "foreign" }, owner: "UidA" },
      { observed: ownedStopped, owner: "another-owner" },
    ]) {
      const h = harness({ ...vmDoc(), "gateways/b-x": { ownerUid: "UidA", gatewayClass: "builder", desiredStatus: "paused" }, "users/UidA": { provisioning: { openclaw: { gatewayId: "shared-1" }, computerRecovery: { operationId: "op-force", gatewayId: "b-x", instanceId: "4242", sharedGatewayId: "shared-1", assignmentEpoch: 1 } } }, "gateways/shared-1": { gatewayClass: "shared" }, "gateways/shared-1/assignments/UidA": { uid: "UidA", gatewayId: "shared-1", state: "serving", epoch: 1 } }, { describe: vi.fn(async () => observed) }, undefined, { "b-x": "paused" });
      await expect(h.runtime.replaceStoppedComputer("b-x", "op-force", async () => {}, { forceOwnerUid: owner, expectedInstanceId: "4242" })).rejects.toThrow();
      expect(h.vm.deleteRetainingHome).not.toHaveBeenCalled();
    }
  });
  it("force-recovers the exact parked computer after its gateway root was deleted", async () => {
    const parked = { instanceName: COMPUTER, zone: ownedStopped.zone, instanceId: "4242", gatewayId: "b-x", parkedAt: 1000,
      checkpoint: { outcome: "stale", requestedAt: null, completedAt: null }, vmSpec: spec };
    const docs: Docs = { "users/UidA": { provisioning: { computer: parked, homeDisk: home, openclaw: { gatewayId: "shared-1" }, computerRecovery: { operationId: "op-force", gatewayId: "b-x", instanceId: "4242", sharedGatewayId: "shared-1", assignmentEpoch: 1 } } }, "gateways/shared-1": { gatewayClass: "shared" }, "gateways/shared-1/assignments/UidA": { uid: "UidA", gatewayId: "shared-1", state: "serving", epoch: 1 } };
    const h = harness(docs, { describe: vi.fn(async () => ownedStopped), readFamilyImage: vi.fn(async () => accepted) }, undefined, { "b-x": null });
    await expect(h.runtime.replaceStoppedComputer("b-x", "op-force", async () => {}, { forceOwnerUid: "UidA", expectedInstanceId: "4242" })).resolves.toMatchObject({ bootDeleted: true });
    expect(h.vm.deleteRetainingHome).toHaveBeenCalledWith(COMPUTER, ownedStopped.zone, "UidA", expect.objectContaining(home), "4242");
    expect(readPath(h.docs["users/UidA"], "provisioning.computer")).toBeUndefined();
    expect(readPath(h.docs["users/UidA"], "provisioning.computerRecovery")).toBeUndefined();
  });
  it("retains the recovery fence on lost delete acknowledgement and finishes the same operation", async () => {
    let deleted = false;
    const parked = { instanceName: COMPUTER, zone: ownedStopped.zone, instanceId: "4242", gatewayId: "b-x", parkedAt: 1000, checkpoint: { outcome: "stale", requestedAt: null, completedAt: null }, vmSpec: spec };
    const docs: Docs = { "users/UidA": { provisioning: { computer: parked, homeDisk: home, openclaw: { gatewayId: "shared-1" }, computerRecovery: { operationId: "op-force", gatewayId: "b-x", instanceId: "4242", sharedGatewayId: "shared-1", assignmentEpoch: 1 } } }, "gateways/shared-1": { gatewayClass: "shared" }, "gateways/shared-1/assignments/UidA": { uid: "UidA", gatewayId: "shared-1", state: "serving", epoch: 1 } };
    const h = harness(docs, { describe: vi.fn(async () => deleted ? null : ownedStopped), deleteRetainingHome: vi.fn(async () => { deleted = true; throw new Error("delete acknowledgement lost"); }), readFamilyImage: vi.fn(async () => accepted), readImage: vi.fn(async () => accepted) }, undefined, { "b-x": null });
    const run = () => h.runtime.replaceStoppedComputer("b-x", "op-force", async () => {}, { forceOwnerUid: "UidA", expectedInstanceId: "4242" });
    await expect(run()).rejects.toThrow("delete acknowledgement lost");
    expect(readPath(h.docs["users/UidA"], "provisioning.computerRecovery.operationId")).toBe("op-force");
    await expect(run()).resolves.toMatchObject({ bootDeleted: true, resumeRequired: true });
    expect(h.vm.deleteRetainingHome).toHaveBeenCalledTimes(1);
    expect(readPath(h.docs["users/UidA"], "provisioning.computerRecovery")).toBeUndefined();
  });
  it("keeps the boot if the Shared assignment changes before force deletion", async () => {
    const parked = { instanceName: COMPUTER, zone: ownedStopped.zone, instanceId: "4242", gatewayId: "b-x", parkedAt: 1000, checkpoint: { outcome: "stale", requestedAt: null, completedAt: null }, vmSpec: spec };
    const docs: Docs = { "users/UidA": { provisioning: { computer: parked, homeDisk: home, openclaw: { gatewayId: "shared-1" }, computerRecovery: { operationId: "op-force", gatewayId: "b-x", instanceId: "4242", sharedGatewayId: "shared-1", assignmentEpoch: 1 } } }, "gateways/shared-1": { gatewayClass: "shared" }, "gateways/shared-1/assignments/UidA": { uid: "UidA", gatewayId: "shared-1", state: "serving", epoch: 1 } };
    const h = harness(docs, { describe: vi.fn(async () => ownedStopped), readFamilyImage: vi.fn(async () => accepted) }, undefined, { "b-x": null });
    let checks = 0;
    await expect(h.runtime.replaceStoppedComputer("b-x", "op-force", async () => { if (++checks === 2) (h.docs["users/UidA"].provisioning as { openclaw: { gatewayId: string } }).openclaw.gatewayId = "other"; }, { forceOwnerUid: "UidA", expectedInstanceId: "4242" })).rejects.toThrow(/fence/);
    expect(h.vm.deleteRetainingHome).not.toHaveBeenCalled();
  });
  it("keeps the boot if the parked computer identity changes before force deletion", async () => {
    const parked = { instanceName: COMPUTER, zone: ownedStopped.zone, instanceId: "4242", gatewayId: "b-x", parkedAt: 1000, checkpoint: { outcome: "stale", requestedAt: null, completedAt: null }, vmSpec: spec };
    const docs: Docs = { "users/UidA": { provisioning: { computer: parked, homeDisk: home, openclaw: { gatewayId: "shared-1" }, computerRecovery: { operationId: "op-force", gatewayId: "b-x", instanceId: "4242", sharedGatewayId: "shared-1", assignmentEpoch: 1 } } }, "gateways/shared-1": { gatewayClass: "shared" }, "gateways/shared-1/assignments/UidA": { uid: "UidA", gatewayId: "shared-1", state: "serving", epoch: 1 } };
    const h = harness(docs, { describe: vi.fn(async () => ownedStopped), readFamilyImage: vi.fn(async () => accepted) }, undefined, { "b-x": null });
    let checks = 0;
    await expect(h.runtime.replaceStoppedComputer("b-x", "op-force", async () => { if (++checks === 3) (h.docs["users/UidA"].provisioning as { computer: { instanceId: string } }).computer.instanceId = "other"; }, { forceOwnerUid: "UidA", expectedInstanceId: "4242" })).rejects.toThrow(/fence/);
    expect(h.vm.deleteRetainingHome).not.toHaveBeenCalled();
  });
  it("does not clear a different runtime that appears after force deletion", async () => {
    const docs = { ...vmDoc(), "gateways/b-x": { ownerUid: "UidA", gatewayClass: "builder", desiredStatus: "paused" }, "gateways/shared-1": { gatewayClass: "shared" }, "gateways/shared-1/assignments/UidA": { uid: "UidA", gatewayId: "shared-1", state: "serving", epoch: 1 }, "users/UidA": { provisioning: { openclaw: { gatewayId: "shared-1" }, computerRecovery: { operationId: "op-force", gatewayId: "b-x", instanceId: "4242", sharedGatewayId: "shared-1", assignmentEpoch: 1 } } } };
    const h = harness(docs, { describe: vi.fn(async () => ownedStopped), readFamilyImage: vi.fn(async () => accepted) }, undefined, { "b-x": "paused" });
    h.vm.deleteRetainingHome = vi.fn(async () => { h.docs["glmGateways/b-x"].vm = { instanceId: "new-instance" }; });
    await expect(h.runtime.replaceStoppedComputer("b-x", "op-force", async () => {}, { forceOwnerUid: "UidA", expectedInstanceId: "4242" })).rejects.toThrow("runtime identity changed");
    expect(readPath(h.docs["glmGateways/b-x"], "vm.instanceId")).toBe("new-instance");
    expect(readPath(h.docs["users/UidA"], "provisioning.computerRecovery.operationId")).toBe("op-force");
  });
  it.each(["class", "status"])("does not clear a runtime after its gateway root changes %s following force deletion", async change => {
    const docs = { ...vmDoc(), "gateways/b-x": { ownerUid: "UidA", gatewayClass: "builder", desiredStatus: "paused" }, "gateways/shared-1": { gatewayClass: "shared" }, "gateways/shared-1/assignments/UidA": { uid: "UidA", gatewayId: "shared-1", state: "serving", epoch: 1 }, "users/UidA": { provisioning: { openclaw: { gatewayId: "shared-1" }, computerRecovery: { operationId: "op-force", gatewayId: "b-x", instanceId: "4242", sharedGatewayId: "shared-1", assignmentEpoch: 1 } } } };
    const h = harness(docs, { describe: vi.fn(async () => ownedStopped), readFamilyImage: vi.fn(async () => accepted) }, undefined, { "b-x": "paused" });
    h.vm.deleteRetainingHome = vi.fn(async () => { if (change === "class") h.docs["gateways/b-x"].gatewayClass = "shared"; else h.docs["gateways/b-x"].desiredStatus = "running"; });
    await expect(h.runtime.replaceStoppedComputer("b-x", "op-force", async () => {}, { forceOwnerUid: "UidA", expectedInstanceId: "4242" })).rejects.toThrow("gateway identity changed");
    expect(readPath(h.docs["glmGateways/b-x"], "vm.instanceId")).toBe("4242");
    expect(readPath(h.docs["users/UidA"], "provisioning.computerRecovery.operationId")).toBe("op-force");
  });
  it("does not stop a suspended computer when its existing gateway root belongs to another owner", async () => {
    const docs = { ...vmDoc(), "gateways/b-x": { ownerUid: "Other", gatewayClass: "builder", desiredStatus: "paused" }, "gateways/shared-1": { gatewayClass: "shared" }, "gateways/shared-1/assignments/UidA": { uid: "UidA", gatewayId: "shared-1", state: "serving", epoch: 1 }, "users/UidA": { provisioning: { openclaw: { gatewayId: "shared-1" }, computerRecovery: { operationId: "op-force", gatewayId: "b-x", instanceId: "4242", sharedGatewayId: "shared-1", assignmentEpoch: 1 } } } };
    const h = harness(docs, { describe: vi.fn(async () => ({ ...ownedStopped, status: "SUSPENDED" })) }, undefined, { "b-x": "paused" });
    await expect(h.runtime.replaceStoppedComputer("b-x", "op-force", async () => {}, { forceOwnerUid: "UidA", expectedInstanceId: "4242" })).rejects.toThrow("gateway owner changed");
    expect(h.vm.stop).not.toHaveBeenCalled();
    expect(h.vm.deleteRetainingHome).not.toHaveBeenCalled();
  });
  it.each([2, 3])("keeps the boot when its gateway root changes owners at authority check %s", async changeAt => {
    const docs = { ...vmDoc(), "gateways/b-x": { ownerUid: "UidA", gatewayClass: "builder", desiredStatus: "paused" }, "gateways/shared-1": { gatewayClass: "shared" }, "gateways/shared-1/assignments/UidA": { uid: "UidA", gatewayId: "shared-1", state: "serving", epoch: 1 }, "users/UidA": { provisioning: { openclaw: { gatewayId: "shared-1" }, computerRecovery: { operationId: "op-force", gatewayId: "b-x", instanceId: "4242", sharedGatewayId: "shared-1", assignmentEpoch: 1 } } } };
    const h = harness(docs, { describe: vi.fn(async () => ownedStopped), readFamilyImage: vi.fn(async () => accepted) }, undefined, { "b-x": "paused" });
    let checks = 0;
    await expect(h.runtime.replaceStoppedComputer("b-x", "op-force", async () => { if (++checks === changeAt) h.docs["gateways/b-x"].ownerUid = "Other"; }, { forceOwnerUid: "UidA", expectedInstanceId: "4242" })).rejects.toThrow("gateway owner changed");
    expect(h.vm.deleteRetainingHome).not.toHaveBeenCalled();
  });
  it.each(["missing", "status", "class"])("keeps the computer when its root is %s", async scenario => {
    const root = { ownerUid: "UidA", gatewayClass: scenario === "class" ? "shared" : "builder", desiredStatus: scenario === "status" ? "running" : "paused" };
    const docs: Docs = { ...vmDoc(), "gateways/shared-1": { gatewayClass: "shared" }, "gateways/shared-1/assignments/UidA": { uid: "UidA", gatewayId: "shared-1", state: "serving", epoch: 1 }, "users/UidA": { provisioning: { openclaw: { gatewayId: "shared-1" }, computerRecovery: { operationId: "op-force", gatewayId: "b-x", instanceId: "4242", sharedGatewayId: "shared-1", assignmentEpoch: 1 } } } };
    if (scenario !== "missing") docs["gateways/b-x"] = root;
    const h = harness(docs, { describe: vi.fn(async () => ownedStopped) }, undefined, { "b-x": "paused" });
    await expect(h.runtime.replaceStoppedComputer("b-x", "op-force", async () => {}, { forceOwnerUid: "UidA", expectedInstanceId: "4242" })).rejects.toThrow(/gateway/);
    expect(h.vm.stop).not.toHaveBeenCalled();
    expect(h.vm.deleteRetainingHome).not.toHaveBeenCalled();
  });
  it("recreates a lost boot with the same larger detached home and an admitted pinned image", async () => {
    const h = harness({ "glmGateways/b-x": { runtime: "gce-vm" }, "users/UidA": { provisioning: { homeDisk: home } } }, {
      describe: vi.fn(async () => null), readFamilyImage: vi.fn(async () => accepted), readImage: vi.fn(async () => accepted),
    });
    await h.runtime.upsertInstance(upsertOpts);
    expect(h.vm.create).toHaveBeenCalledWith(expect.objectContaining({ retainedHome: expect.objectContaining(home), image: expect.objectContaining(accepted), zones: [home.zone], imageProject: home.projectId }));
    expect(h.vm.list).not.toHaveBeenCalled();
    expect(h.vm.deleteRetainedHome).not.toHaveBeenCalled();
    expect(readPath(h.docs["users/UidA"], "provisioning.homeDisk.bootImage")).toMatchObject({ homeId: home.id, id: accepted.id });
  });
  it("keeps the selected image across a failed creation and changed family head", async () => {
    const create = vi.fn().mockRejectedValueOnce(new Error("capacity exhausted")).mockResolvedValue({ description: running, provisioningModel: "SPOT", alreadyExisted: false });
    const family = vi.fn().mockResolvedValueOnce(accepted).mockResolvedValue({ ...accepted, id: "333" });
    const h = harness({ "glmGateways/b-x": { runtime: "gce-vm" }, "users/UidA": { provisioning: { homeDisk: home } } }, { describe: vi.fn(async () => null), create, readFamilyImage: family, readImage: vi.fn(async () => accepted) });
    await expect(h.runtime.upsertInstance(upsertOpts)).rejects.toThrow("capacity exhausted");
    await h.runtime.upsertInstance(upsertOpts);
    expect(family).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[1][0].image.id).toBe(accepted.id);
  });
  it("replaces only the boot of the same paused, stopped computer and defers creation to resume", async () => {
    const h = harness(vmDoc(), { describe: vi.fn(async () => ownedStopped), readFamilyImage: vi.fn(async () => accepted) }, undefined, { "b-x": "paused" });
    const authority = vi.fn(async () => {});
    await h.runtime.replaceStoppedComputer("b-x", "op-one", authority);
    expect(h.vm.retainHome).toHaveBeenCalledWith(COMPUTER, ownedStopped.zone, "UidA");
    expect(h.vm.deleteRetainingHome).toHaveBeenCalledWith(COMPUTER, ownedStopped.zone, "UidA", expect.objectContaining(home), "4242");
    expect(h.vm.create).not.toHaveBeenCalled();
    expect(h.vm.deleteRetainedHome).not.toHaveBeenCalled();
    expect(readPath(h.docs["users/UidA"], "provisioning.homeDisk.id")).toBe(home.id);
    expect(readPath(h.docs["users/UidA"], "provisioning.homeDisk.bootImage.previous")).toEqual(CURRENT_IMAGE);
    expect(h.docs["glmGateways/b-x"].vm).toBeNull();
    expect(authority).toHaveBeenCalledTimes(2);
  });
  it("stops a suspended paused computer before replacing its boot", async () => {
    let current: GatewayVmDescription = { ...ownedStopped, status: "SUSPENDED" };
    const h = harness(vmDoc(), { describe: vi.fn(async () => current), stop: vi.fn(async () => { current = ownedStopped; }), readFamilyImage: vi.fn(async () => accepted) }, undefined, { "b-x": "paused" });
    await h.runtime.replaceStoppedComputer("b-x", "op-suspended", async () => {});
    expect(h.vm.stop).toHaveBeenCalledOnce();
    expect(h.vm.stop.mock.invocationCallOrder[0]).toBeLessThan(h.vm.deleteRetainingHome.mock.invocationCallOrder[0]);
    expect(h.log).toHaveBeenCalledWith(expect.stringMatching(/b-x: stopped suspended octogee-computer-test-uida to replace its boot/));
  });
  it("replaces after completed retirement using the owner's retained receipt without recreating runtime", async () => {
    const h = harness({ ...vmDoc(), "gateways/b-x": { ownerUid: "UidA" } }, { describe: vi.fn(async () => ownedStopped), readFamilyImage: vi.fn(async () => accepted) }, undefined, { "b-x": "retired" });
    await h.runtime.removeInstance({ namespace: "octogee-test", gatewayId: "b-x" });
    expect(readPath(h.docs["users/UidA"], "provisioning.computer.bootRecovery")).toEqual(receipt);
    delete h.docs["glmGateways/b-x"];
    await expect(h.runtime.replaceStoppedComputer("b-x", "op-retired", async () => {})).resolves.toMatchObject({ bootDeleted: true });
    expect(h.docs["glmGateways/b-x"]).toBeUndefined();
    expect(h.vm.deleteRetainingHome).toHaveBeenCalledTimes(1);
    expect(readPath(h.docs["users/UidA"], "provisioning.computer")).toBeUndefined();
  });
  it("retains the latest failed admission report rather than copying earlier success across stop", async () => {
    const docs = { ...vmDoc(), "gateways/b-x": { ownerUid: "UidA" } };
    let stoppedNow = false;
    const h = harness(docs, { describe: vi.fn(async () => stoppedNow ? ownedStopped : { ...ownedStopped, status: "RUNNING" }),
      suspend: vi.fn(async () => { stoppedNow = true; docs["glmGateways/b-x"].vmBootRecovery = { ...receipt, ready: false, observedAt: 1001 }; }) }, undefined, { "b-x": "retired" });
    await h.runtime.removeInstance({ namespace: "octogee-test", gatewayId: "b-x" });
    expect(readPath(h.docs["users/UidA"], "provisioning.computer.bootRecovery.ready")).toBe(false);
    delete h.docs["glmGateways/b-x"];
    await expect(h.runtime.replaceStoppedComputer("b-x", "op-retired", async () => {})).rejects.toThrow(/native admission/);
    expect(h.vm.deleteRetainingHome).not.toHaveBeenCalled();
  });
  it.each(["missing", "foreign", "unready"])("retired replacement preserves both disks for unusable owner-anchored evidence: %s", async fault => {
    const h = harness({ ...vmDoc(), "gateways/b-x": { ownerUid: "UidA" } }, { describe: vi.fn(async () => ownedStopped) }, undefined, { "b-x": "retired" });
    await h.runtime.removeInstance({ namespace: "octogee-test", gatewayId: "b-x" });
    delete h.docs["glmGateways/b-x"];
    const computer = readPath(h.docs["users/UidA"], "provisioning.computer") as Record<string, unknown>;
    computer.bootRecovery = fault === "missing" ? undefined : { ...receipt, instanceId: fault === "foreign" ? "other" : receipt.instanceId, ready: fault !== "unready" };
    await expect(h.runtime.replaceStoppedComputer("b-x", "op-retired", async () => {})).rejects.toThrow();
    expect(h.vm.deleteRetainingHome).not.toHaveBeenCalled();
  });
  it("preserves the actual stopped timestamp across later paused-intent reconciliation", async () => {
    const h = harness(vmDoc(), { describe: vi.fn(async () => ownedStopped), readFamilyImage: vi.fn(async () => accepted) }, undefined, { "b-x": "paused" });
    await h.runtime.upsertInstance({ ...upsertOpts, replicas: 0 });
    const stoppedAt = readPath(h.docs["glmGateways/b-x"], "vm.updatedAt");
    h.clock.now += 300000;
    h.docs["glmGateways/b-x"].deploymentIntentFingerprint = "changed-while-paused";
    await h.runtime.upsertInstance({ ...upsertOpts, replicas: 0 });
    expect(readPath(h.docs["glmGateways/b-x"], "vm.updatedAt")).toBe(stoppedAt);
    await expect(h.runtime.replaceStoppedComputer("b-x", "op-later", async () => {})).resolves.toMatchObject({ bootDeleted: true });
  });
  it("refuses the old stopped receipt after an intervening native restart", async () => {
    const h = harness(vmDoc(), { describe: vi.fn(async () => ({ ...ownedStopped, lastStartedAt: 200000 })) }, undefined, { "b-x": "paused" });
    h.clock.now = 300000;
    await h.runtime.upsertInstance({ ...upsertOpts, replicas: 0 });
    await expect(h.runtime.replaceStoppedComputer("b-x", "op-restarted", async () => {})).rejects.toThrow(/stale/);
    expect(h.vm.deleteRetainingHome).not.toHaveBeenCalled();
  });
  it.each(["RUNNING", "STOPPING", "owner-changed", "instance-changed"])("never deletes an unsafe replacement source: %s", async scenario => {
    let describes = 0;
    const description = scenario === "owner-changed" ? { ...ownedStopped, metadata: { ...ownedStopped.metadata, "octogee-owner-uid": "Other" } }
      : scenario === "instance-changed" ? ownedStopped : { ...ownedStopped, status: scenario };
    const h = harness(vmDoc(), { describe: vi.fn(async () => ++describes > 1 && scenario === "instance-changed" ? { ...ownedStopped, instanceId: "999" } : description), readFamilyImage: vi.fn(async () => accepted) }, undefined, { "b-x": "paused" });
    await expect(h.runtime.replaceStoppedComputer("b-x", "op-one", async () => {})).rejects.toThrow();
    expect(h.vm.deleteRetainingHome).not.toHaveBeenCalled();
  });
  it("recovers a lost delete acknowledgement from the same operation and detached home without another delete", async () => {
    let deleted = false;
    const docs = { ...vmDoc(), "gateways/b-x": { ownerUid: "UidA" } };
    const deletion = vi.fn(async () => { deleted = true; throw new Error("delete acknowledgement lost"); });
    const h = harness(docs, { describe: vi.fn(async () => deleted ? null : ownedStopped), deleteRetainingHome: deletion, readFamilyImage: vi.fn(async () => accepted), readImage: vi.fn(async () => accepted) }, undefined, { "b-x": "paused" });
    await expect(h.runtime.replaceStoppedComputer("b-x", "op-one", async () => {})).rejects.toThrow("acknowledgement lost");
    await expect(h.runtime.replaceStoppedComputer("b-x", "op-one", async () => {})).resolves.toMatchObject({ bootDeleted: true, resumeRequired: true });
    await expect(h.runtime.replaceStoppedComputer("b-x", "op-one", async () => {})).resolves.toMatchObject({ bootDeleted: true });
    expect(deletion).toHaveBeenCalledTimes(1);
    expect(h.vm.verifyDetachedHome).toHaveBeenCalledTimes(2);
    expect(h.vm.readFamilyImage).toHaveBeenCalledTimes(1);
  });
  it.each(["missing", "not-ready", "two-points", "wrong-instance", "stale", "no-headroom"])("keeps the old boot before predictable recovery admission failure: %s", async fault => {
    const docs = vmDoc();
    docs["glmGateways/b-x"].vmBootRecovery = fault === "missing" ? undefined : { ...receipt,
      ready: fault !== "not-ready", retainedPoints: fault === "two-points" ? 2 : 1,
      instanceId: fault === "wrong-instance" ? "999" : "4242", observedAt: fault === "stale" ? -100000 : 1000,
      freeBytes: fault === "no-headroom" ? 100 : receipt.freeBytes };
    const h = harness(docs, { describe: vi.fn(async () => ownedStopped) }, undefined, { "b-x": "paused" });
    await expect(h.runtime.replaceStoppedComputer("b-x", "op-one", async () => {})).rejects.toThrow(/recovery|native admission/);
    expect(h.vm.deleteRetainingHome).not.toHaveBeenCalled();
    expect(h.vm.retainHome).not.toHaveBeenCalled();
    expect(h.vm.readFamilyImage).not.toHaveBeenCalled();
  });
  it("never reuses an old operation pin to delete a different source computer", async () => {
    const h = harness({ ...vmDoc(), "users/UidA": { provisioning: { openclaw: { gatewayId: "b-x" }, homeDisk: { ...home, bootImage: { ...accepted, project: home.projectId, homeId: home.id, operationId: "op-one", previous: CURRENT_IMAGE, sourceComputer: { name: COMPUTER, zone: home.zone, instanceId: "1111", gatewayId: "b-x" } } } } } }, { describe: vi.fn(async () => ownedStopped), readImage: vi.fn(async () => accepted) }, undefined, { "b-x": "paused" });
    await expect(h.runtime.replaceStoppedComputer("b-x", "op-one", async () => {})).rejects.toThrow("operation source changed");
    expect(h.vm.deleteRetainingHome).not.toHaveBeenCalled();
  });
  it("refuses a changed pinned image before trying retained-home creation", async () => {
    const h = harness({ "glmGateways/b-x": { runtime: "gce-vm" }, "users/UidA": { provisioning: { homeDisk: { ...home, bootImage: { ...accepted, project: home.projectId, homeId: home.id, previous: null, operationId: null } } } } }, { describe: vi.fn(async () => null), readImage: vi.fn(async () => ({ ...accepted, id: "333" })) });
    await expect(h.runtime.upsertInstance(upsertOpts)).rejects.toThrow("pinned retained boot image");
    expect(h.vm.create).not.toHaveBeenCalled();
  });
  it("keeps both disks when desired status becomes running before deletion", async () => {
    const statuses: Record<string, string> = { "b-x": "paused" };
    const h = harness(vmDoc(), { describe: vi.fn(async () => ownedStopped), readFamilyImage: vi.fn(async () => accepted) }, undefined, statuses);
    let checks = 0;
    await expect(h.runtime.replaceStoppedComputer("b-x", "op-one", async () => { if (++checks === 2) statuses["b-x"] = "running"; })).rejects.toThrow(/paused|retired/);
    expect(h.vm.deleteRetainingHome).not.toHaveBeenCalled();
  });
});
