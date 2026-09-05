import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { FieldValue, type Firestore } from "firebase-admin/firestore";
import type { GatewayVmSpec, HelmInstancesMap } from "@octogee/shared/types/glm";
import type { GatewayVmClient, GatewayVmDescription } from "../lib/compute-vm";
import type { HelmRunner } from "../helm-runner";
import {
  createRuntimeDispatchingHelmRunner,
  createVmGatewayRuntime,
  parseGatewayVmSpec,
  resolveBuilderRuntimePolicy,
  stampGatewayRuntime,
  vmRoutesFromDocs,
} from "../vm-gateway-runtime";
import { builderComputerInstanceInput } from "../vm-computer-lifecycle";
import { reconcileVmWarmPool } from "../vm-warm-pool";

const renderedYaml = "kind: Deployment\n";
const renderedJson = readFileSync(new URL("./fixtures/vm-runtime-render.json", import.meta.url), "utf8");
const concatenated = (JSON.parse(renderedJson) as unknown[]).map((item) => JSON.stringify(item)).join("\n");

const spec: GatewayVmSpec = {
  zone: "us-west1-b", machineType: "n2-standard-4", imageFamily: "octogee-computer", diskSizeGb: 40,
  provisioningModel: "SPOT", serviceAccountEmail: "octogee-computer-test@octogee.iam.gserviceaccount.com",
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

function fakeDb(docs: Docs) {
  const writes: Array<{ path: string; data: unknown; merge: boolean }> = [];
  const deletes: string[] = [];
  const docRef = (path: string) => ({
    id: path.split("/").at(-1)!,
    get: async () => ({ exists: docs[path] !== undefined, data: () => docs[path] }),
    set: async (data: Record<string, unknown>, opts?: { merge?: boolean }) => {
      writes.push({ path, data, merge: opts?.merge === true });
      docs[path] = opts?.merge ? mergeInto({ ...(docs[path] ?? {}) }, data) : mergeInto({}, data);
    },
    delete: async () => { deletes.push(path); delete docs[path]; },
  });
  const db = {
    doc: docRef,
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
const POOL_LABELS = { "octogee-pool": "warm", "octogee-environment": "test" };
const running: GatewayVmDescription = {
  name: COMPUTER, zone: "us-west1-b", status: "RUNNING", instanceId: "4242", internalIp: "172.20.0.9", provisioningModel: "SPOT", gatewayId: "b-x",
  labels: { ...OWNER_LABELS, "octogee-gateway-id": "b-x" }, labelFingerprint: "lf-gw", metadata: { "gateway-id": "b-x", "gateway-image": "us-docker.pkg.dev/octogee/octogee/gateway:main.abc123", "octogee-api-url": "http://172.20.7.7:3001" }, metadataFingerprint: "mf-gw", creationTimestamp: null,
};
const stopped: GatewayVmDescription = { ...running, status: "TERMINATED", internalIp: null };
const recorded = { instanceName: COMPUTER, zone: "us-west1-b", instanceId: "4242", internalIp: "172.20.0.9", status: "RUNNING", provisioningModel: "SPOT", stopReason: null, updatedAt: 1 };

function warmMember(name: string, overrides: Partial<GatewayVmDescription> = {}): GatewayVmDescription {
  return {
    name, zone: "us-west1-b", status: "RUNNING", instanceId: `id-${name}`, internalIp: `10.9.0.${name.length}`, provisioningModel: "SPOT", gatewayId: null,
    labels: { ...POOL_LABELS, purpose: "octogee-computer" }, labelFingerprint: `lf-${name}`,
    metadata: { "octogee-environment": "test" }, metadataFingerprint: `mf-${name}`, creationTimestamp: "2026-09-05T10:00:00Z",
    ...overrides,
  };
}

function boundMember(member: GatewayVmDescription, gatewayId: string, image = "us-docker.pkg.dev/octogee/octogee/gateway:main.abc123"): GatewayVmDescription {
  const { "octogee-pool": _pool, ...labels } = member.labels;
  return {
    ...member,
    gatewayId,
    labels: { ...labels, ...OWNER_LABELS, "octogee-gateway-id": gatewayId },
    metadata: { ...member.metadata, "gateway-id": gatewayId, "octogee-owner-uid": "UidA", "octogee-environment": "test", "gateway-image": image, "octogee-api-url": "http://172.20.7.7:3001" },
  };
}

function harness(
  docs: Docs,
  vmOverrides: Partial<GatewayVmClient> = {},
  bridge = "172.20.7.7",
  desiredStatus: Record<string, string> = {},
  extra: { clock?: { now: number }; onWait?: (ms: number, waits: number) => void; homeCheckpointTimeoutMs?: number; applyFails?: boolean } = {},
) {
  const { db, writes, deletes } = fakeDb(docs);
  const clock = extra.clock ?? { now: 1_000 };
  const waits: number[] = [];
  const vm: GatewayVmClient = {
    create: vi.fn(async () => ({ description: running, provisioningModel: "SPOT", fellBackToStandard: false, alreadyExisted: false })),
    describe: vi.fn(async () => running),
    find: vi.fn(async () => null),
    findByLabels: vi.fn(async () => null),
    list: vi.fn(async () => []),
    bind: vi.fn(async () => {}),
    setMetadata: vi.fn(async () => "applied" as const),
    setLabels: vi.fn(async () => "applied" as const),
    stop: vi.fn(async () => {}),
    start: vi.fn(async () => ({ fellBackToStandard: false })),
    delete: vi.fn(async () => true),
    ...vmOverrides,
  };
  const log = vi.fn();
  const helmCalls: string[][] = [];
  const kubectlCalls: Array<{ args: string[]; stdin?: string }> = [];
  const runtime = createVmGatewayRuntime({
    db, namespace: "octogee-test", environment: "test",
    runHelm: async (args) => { helmCalls.push(args); return { stdout: renderedYaml, stderr: "", code: 0 }; },
    runKubectl: async (args, opts) => {
      kubectlCalls.push({ args, stdin: opts?.stdin });
      if (args[0] === "create") return { stdout: concatenated, stderr: "", code: 0 };
      if (args[0] === "get" && args[1] === "svc") return { stdout: bridge, stderr: "", code: 0 };
      if (args[0] === "get" && args[1] === "secret") return { stdout: Buffer.from(`${args[2]}-value`).toString("base64"), stderr: "", code: 0 };
      if (args[0] === "apply" && extra.applyFails) return { stdout: "", stderr: "configmaps is forbidden", code: 1 };
      return { stdout: "", stderr: "", code: 0 };
    },
    vm, vmSpec: spec, bridgeServiceName: "octogee-vm-bridge",
    hostAliasNames: ["octogee-api.octogee-test.svc.cluster.local", "mattermost.octogee-test.svc.cluster.local"],
    kubernetes: { apiHost: "172.20.16.18", apiPort: "443", caCert: "CA" },
    routesConfigMap: "octogee-vm-routes",
    ensureAuthSecret: vi.fn(async () => {}),
    readDesiredStatus: async (gatewayId) => desiredStatus[gatewayId] ?? "running",
    wait: async (ms) => { waits.push(ms); clock.now += ms; extra.onWait?.(ms, waits.length); },
    homeCheckpointTimeoutMs: extra.homeCheckpointTimeoutMs ?? 60_000,
    homeCheckpointPollMs: 10_000,
    now: () => clock.now, log,
  });
  const routesPublished = () => kubectlCalls.filter((c) => c.args[0] === "apply").map((c) => JSON.parse(JSON.parse(c.stdin!).data["routes.json"]) as Record<string, string>);
  return { runtime, db, docs, writes, deletes, vm, log, helmCalls, kubectlCalls, routesPublished, clock, waits };
}

const upsertOpts = {
  namespace: "octogee-test", gatewayId: "b-x", imageRepository: "us-docker.pkg.dev/octogee/octogee/gateway", imageTag: "main.abc123",
  chartPath: "/chart", ownerUid: "UidA", builderSlug: "mama", gatewayClass: "builder" as const, profile: "builder" as const,
  imageProfile: "builder" as const, chartFingerprint: "cf", deploymentIntentFingerprint: "dif",
};

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
      },
    });
    expect(builderComputerInstanceInput({ ...source, spec: { ...spec, imageProject: "octogee-images" } }).imageProject).toBe("octogee-images");
  });

  it("sets every metadata attribute the octo-gateway-agent unit reads at boot, on a cold create, a warm-pool claim, and a rebind", async () => {
    const unit = readFileSync(new URL("../../../infra/desktop/image/rootfs/usr/local/bin/octo-gateway-agent", import.meta.url), "utf8");
    const readByAgent = [...new Set([...unit.matchAll(/\$\(attr ([a-z-]+)\)/g)].map((m) => m[1]))];
    expect(readByAgent).toEqual(["gateway-id", "gateway-image", "octogee-api-url"]);
    const gatewayDoc = { "glmGateways/b-x": { docKind: "runtime", gatewayId: "b-x", runtime: "gce-vm" } };

    const created = harness({ ...gatewayDoc });
    await created.runtime.upsertInstance(upsertOpts);
    const member = warmMember("octogee-pool-aa11bb22");
    const claimed = harness({ ...gatewayDoc }, {
      list: vi.fn(async () => [member]),
      describe: vi.fn(async (name: string) => (name === member.name ? boundMember(member, "b-x") : null)),
    });
    await claimed.runtime.upsertInstance(upsertOpts);
    const parkedElsewhere = { ...stopped, gatewayId: "b-old" };
    const rebound = harness({ ...gatewayDoc }, {
      findByLabels: vi.fn(async () => parkedElsewhere),
      describe: vi.fn(async () => running).mockResolvedValueOnce(parkedElsewhere),
    });
    await rebound.runtime.upsertInstance(upsertOpts);

    const paths = {
      create: created.vm.create.mock.calls[0][0].metadata,
      claim: claimed.vm.setMetadata.mock.calls[0][2].items,
      bind: rebound.vm.bind.mock.calls[0][2].metadata,
    };
    expect(claimed.vm.create).not.toHaveBeenCalled();
    expect(rebound.vm.create).not.toHaveBeenCalled();
    for (const [path, metadata] of Object.entries(paths)) {
      for (const key of readByAgent) expect(metadata[key], `${path} ${key}`).toMatch(/\S/);
      expect(metadata).toEqual(paths.create);
    }
  });
});

describe("createVmGatewayRuntime.upsertInstance", () => {
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

    await h.runtime.upsertInstance(upsertOpts);

    expect(h.helmCalls[0].slice(0, 3)).toEqual(["template", "octogee-gw-b-x", "/chart"]);
    expect(h.helmCalls[0]).not.toContain("--wait");
    const bundle = h.docs["glmGateways/b-x/vm/runtime"] as Record<string, unknown>;
    expect(bundle.gatewayId).toBe("b-x");
    expect((bundle.containers as Array<{ name: string; env: Record<string, string> }>)[0].env.OPENCLAW_GATEWAY_TOKEN).toBe("gateway-auth-token-b-x-value");
    expect(bundle.hostAliases).toEqual({
      "octogee-api.octogee-test.svc.cluster.local": "172.20.7.7",
      "mattermost.octogee-test.svc.cluster.local": "172.20.7.7",
    });
    const glm = h.docs["glmGateways/b-x"];
    expect(glm.vmInstance).toMatchObject({ enabled: true, gatewayId: "b-x", image: { repository: upsertOpts.imageRepository, tag: "main.abc123" }, chartFingerprint: "cf", ownerUid: "UidA" });
    expect(JSON.stringify(glm.vmInstance)).not.toContain("undefined");
    expect(h.vm.findByLabels).toHaveBeenCalledWith(OWNER_LABELS);
    expect(h.vm.find).not.toHaveBeenCalled();
    expect(h.vm.list).toHaveBeenCalledWith({ zone: "us-west1-b", labels: POOL_LABELS });
    expect(h.vm.create).toHaveBeenCalledWith(expect.objectContaining({
      instanceName: COMPUTER, zone: "us-west1-b", provisioningModel: "SPOT",
      labels: expect.objectContaining({ "octogee-gateway-id": "b-x", "octogee-owner-uid": "uida" }),
      metadata: { "gateway-id": "b-x", "octogee-owner-uid": "UidA", "octogee-environment": "test", "gateway-image": `${upsertOpts.imageRepository}:main.abc123`, "octogee-api-url": "http://172.20.7.7:3001" },
    }));
    expect(glm.vm).toEqual({ ...recorded, origin: "cold", updatedAt: 1_000 });
    const apply = h.kubectlCalls.find((c) => c.args[0] === "apply");
    expect(JSON.parse(apply!.stdin!)).toMatchObject({ kind: "ConfigMap", metadata: { name: "octogee-vm-routes" }, data: { "routes.json": JSON.stringify({ "b-x": "172.20.0.9" }) } });
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

    await expect(h.runtime.upsertInstance(upsertOpts)).rejects.toThrow(/ZONE_RESOURCE_POOL_EXHAUSTED/);
    expect(h.docs["glmGateways/b-x/vm/runtime"]).toBeDefined();
    expect(h.docs["glmGateways/b-x"].vmInstance).toBeUndefined();
    expect(h.docs["glmGateways/b-x"].vm).toBeUndefined();
    expect(await h.runtime.readDeployedInstance({ namespace: "octogee-test", gatewayId: "b-x" })).toBeNull();

    await h.runtime.upsertInstance(upsertOpts);
    expect(create).toHaveBeenCalledTimes(2);
    expect(h.docs["glmGateways/b-x"].vmInstance).toMatchObject({ gatewayId: "b-x", deploymentIntentFingerprint: "dif" });
    expect(h.docs["glmGateways/b-x"].vm).toEqual({ ...recorded, origin: "cold", updatedAt: 1_000 });

    const routesFail = harness({ "glmGateways/b-x": { ...gatewayDoc } }, {}, "172.20.7.7", {}, { applyFails: true });
    await expect(routesFail.runtime.upsertInstance(upsertOpts)).rejects.toThrow(/configmaps is forbidden/);
    expect(routesFail.docs["glmGateways/b-x"].vm).toEqual({ ...recorded, origin: "cold", updatedAt: 1_000 });
    expect(routesFail.docs["glmGateways/b-x"].vmInstance).toBeUndefined();
  });

  it("pauses by stopping the Builder's running computer instead of claiming or starting one, and records the paused deployment", async () => {
    const paused = { ...upsertOpts, replicas: 0 };
    let current = running;
    const withComputer = harness({ "glmGateways/b-x": { docKind: "runtime", gatewayId: "b-x", runtime: "gce-vm", vm: { ...recorded } } }, {
      describe: vi.fn(async () => current),
      stop: vi.fn(async () => { current = stopped; }),
      start: vi.fn(async () => { current = running; return { fellBackToStandard: false }; }),
    });
    await withComputer.runtime.upsertInstance(paused);
    expect(withComputer.vm.stop).toHaveBeenCalledWith(COMPUTER, "us-west1-b");
    expect(withComputer.vm.start).not.toHaveBeenCalled();
    expect(withComputer.vm.create).not.toHaveBeenCalled();
    expect(withComputer.vm.findByLabels).not.toHaveBeenCalled();
    expect(withComputer.vm.list).not.toHaveBeenCalled();
    expect(withComputer.docs["glmGateways/b-x"].vm).toEqual({ ...recorded, status: "TERMINATED", internalIp: null, stopReason: "operator", updatedAt: 1_000 });
    expect(withComputer.docs["glmGateways/b-x"].vmInstance).toMatchObject({ gatewayId: "b-x", replicas: 0 });
    expect(withComputer.docs["glmGateways/b-x/vm/runtime"]).toBeDefined();
    expect(withComputer.routesPublished().at(-1)).toEqual({});
    expect(withComputer.log).toHaveBeenCalledWith(expect.stringMatching(/b-x: stopped octogee-computer-test-uida for operator -> TERMINATED/));

    await withComputer.runtime.recoverUnreachable("b-x");
    expect(withComputer.vm.start).not.toHaveBeenCalled();

    await withComputer.runtime.upsertInstance({ ...upsertOpts, replicas: 1 });
    expect(withComputer.vm.start).toHaveBeenCalledWith(COMPUTER, "us-west1-b");
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
    expect(vanished.docs["glmGateways/b-x"].vm).toBeNull();
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

  it("claims a warm-pool member as the Builder's first computer: metadata under its fingerprint, then the Builder's labels, no reboot", async () => {
    const member = warmMember("octogee-pool-aa11bb22");
    const bound = boundMember(member, "b-x");
    const h = harness({ "glmGateways/b-x": { docKind: "runtime", gatewayId: "b-x", runtime: "gce-vm" } }, {
      list: vi.fn(async () => [member]),
      describe: vi.fn(async (name: string) => (name === member.name ? bound : null)),
    });

    await h.runtime.upsertInstance(upsertOpts);

    expect(h.vm.findByLabels).toHaveBeenCalledWith(OWNER_LABELS);
    expect(h.vm.create).not.toHaveBeenCalled();
    expect(h.vm.setMetadata).toHaveBeenCalledWith(member.name, "us-west1-b", {
      fingerprint: "mf-octogee-pool-aa11bb22",
      items: { "octogee-environment": "test", "gateway-id": "b-x", "octogee-owner-uid": "UidA", "gateway-image": `${upsertOpts.imageRepository}:main.abc123`, "octogee-api-url": "http://172.20.7.7:3001" },
    });
    expect(h.vm.setLabels).toHaveBeenCalledWith(member.name, "us-west1-b", {
      fingerprint: "lf-octogee-pool-aa11bb22",
      labels: { "octogee-environment": "test", purpose: "octogee-computer", "octogee-gateway-id": "b-x", "octogee-owner-uid": "uida" },
    });
    expect(h.vm.setMetadata.mock.invocationCallOrder[0]).toBeLessThan(h.vm.setLabels.mock.invocationCallOrder[0]);
    expect(h.vm.bind).not.toHaveBeenCalled();
    expect(h.vm.stop).not.toHaveBeenCalled();
    expect(h.vm.start).not.toHaveBeenCalled();
    expect(h.docs["glmGateways/b-x"].vm).toEqual({
      ...recorded, instanceName: member.name, instanceId: "id-octogee-pool-aa11bb22", internalIp: member.internalIp, origin: "warm-pool", updatedAt: 1_000,
    });
    expect(h.routesPublished().at(-1)).toEqual({ "b-x": member.internalIp });
    expect(h.log).toHaveBeenCalledWith(expect.stringMatching(/b-x: claimed warm-pool member octogee-pool-aa11bb22 as UidA's computer/));
  });

  it("skips members that lost the metadata race or are not running, then falls back to a cold create named for the Builder", async () => {
    const lost = warmMember("octogee-pool-lost");
    const parked = warmMember("octogee-pool-stopped", { status: "TERMINATED" });
    const second = warmMember("octogee-pool-second");
    const raced = harness({ "glmGateways/b-x": { docKind: "runtime", gatewayId: "b-x", runtime: "gce-vm" } }, {
      list: vi.fn(async () => [parked, lost, second]),
      setMetadata: vi.fn(async (name: string) => (name === lost.name ? "conflict" as const : "applied" as const)),
      describe: vi.fn(async (name: string) => (name === second.name ? boundMember(second, "b-x") : null)),
    });
    await raced.runtime.upsertInstance(upsertOpts);
    expect(raced.vm.setMetadata).toHaveBeenCalledTimes(2);
    expect(raced.vm.setMetadata).not.toHaveBeenCalledWith(parked.name, expect.anything(), expect.anything());
    expect(raced.vm.setLabels).toHaveBeenCalledTimes(1);
    expect(raced.vm.create).not.toHaveBeenCalled();
    expect(raced.docs["glmGateways/b-x"].vm).toMatchObject({ instanceName: second.name, origin: "warm-pool", stopReason: null });

    const exhausted = harness({ "glmGateways/b-x": { docKind: "runtime", gatewayId: "b-x", runtime: "gce-vm" } }, {
      list: vi.fn(async () => [lost]),
      setMetadata: vi.fn(async () => "conflict" as const),
    });
    await exhausted.runtime.upsertInstance(upsertOpts);
    expect(exhausted.vm.setLabels).not.toHaveBeenCalled();
    expect(exhausted.vm.create).toHaveBeenCalledWith(expect.objectContaining({ instanceName: COMPUTER, labels: { ...OWNER_LABELS, "octogee-gateway-id": "b-x" } }));
    expect(exhausted.docs["glmGateways/b-x"].vm).toEqual({ ...recorded, origin: "cold", updatedAt: 1_000 });
  });

  it("finishes an interrupted claim and refuses one whose relabel loses its fingerprint race", async () => {
    const mine = warmMember("octogee-pool-mine", { gatewayId: "b-x", metadata: { "octogee-environment": "test", "gateway-id": "b-x", "gateway-image": "old", "octogee-api-url": "http://172.20.7.7:3001" } });
    const other = warmMember("octogee-pool-other");
    const h = harness({ "glmGateways/b-x": { docKind: "runtime", gatewayId: "b-x", runtime: "gce-vm" } }, {
      list: vi.fn(async () => [other, mine]),
      describe: vi.fn(async (name: string) => (name === mine.name ? boundMember(mine, "b-x", "old") : null)),
    });
    await h.runtime.upsertInstance(upsertOpts);
    expect(h.vm.setMetadata).not.toHaveBeenCalled();
    expect(h.vm.setLabels).toHaveBeenCalledWith(mine.name, "us-west1-b", expect.objectContaining({ labels: expect.objectContaining({ "octogee-gateway-id": "b-x", "octogee-owner-uid": "uida" }) }));
    expect(h.vm.create).not.toHaveBeenCalled();
    expect(h.docs["glmGateways/b-x"].vm).toMatchObject({ instanceName: mine.name, origin: "warm-pool" });

    const halfClaimed = harness({ "glmGateways/b-x": { docKind: "runtime", gatewayId: "b-x", runtime: "gce-vm" } }, {
      list: vi.fn(async () => [warmMember("octogee-pool-aa11bb22")]),
      setLabels: vi.fn(async () => "conflict" as const),
    });
    await expect(halfClaimed.runtime.upsertInstance(upsertOpts)).rejects.toThrow(/relabel.*octogee-pool-aa11bb22/);
    expect(halfClaimed.docs["glmGateways/b-x"].vm).toBeUndefined();
  });

  it("adopts a member whose claim was interrupted before its relabel: one pool tick finishes the labels, the Builder's next gateway finds it by owner label and rebinds it, no second VM", async () => {
    const interrupted = warmMember("octogee-pool-half", {
      gatewayId: "b-old",
      metadata: { "octogee-environment": "test", "gateway-id": "b-old", "octogee-owner-uid": "UidA", "gateway-image": "old", "octogee-api-url": "http://172.20.7.7:3001" },
    });
    let current = interrupted;
    const h = harness({ "glmGateways/b-x": { docKind: "runtime", gatewayId: "b-x", runtime: "gce-vm" } }, {
      list: vi.fn(async (input: { labels: Record<string, string> }) => (current.labels["octogee-pool"] === input.labels["octogee-pool"] ? [current] : [])),
      setLabels: vi.fn(async (_name: string, _zone: string, input: { labels: Record<string, string> }) => { current = { ...current, labels: input.labels }; return "applied" as const; }),
      findByLabels: vi.fn(async (labels: Record<string, string>) => (Object.entries(labels).every(([k, v]) => current.labels[k] === v) ? current : null)),
      describe: vi.fn(async (name: string) => (name === current.name ? current : null)),
      stop: vi.fn(async () => { current = { ...current, status: "TERMINATED", internalIp: null }; }),
      bind: vi.fn(async (_name: string, _zone: string, input: { labels: Record<string, string>; metadata: Record<string, string> }) => {
        current = { ...current, gatewayId: input.metadata["gateway-id"], labels: input.labels, metadata: { ...current.metadata, ...input.metadata } };
      }),
      start: vi.fn(async () => { current = { ...current, status: "RUNNING", internalIp: "10.9.0.77" }; return { fellBackToStandard: false }; }),
    });
    const poolLog = vi.fn();

    await reconcileVmWarmPool({ vm: h.vm, vmSpec: spec, environment: "test", config: { size: 0, maxAgeMs: 6 * 60 * 60_000 }, now: () => 1_000, log: poolLog });

    expect(h.vm.setLabels).toHaveBeenCalledWith("octogee-pool-half", "us-west1-b", {
      fingerprint: "lf-octogee-pool-half",
      labels: { "octogee-environment": "test", purpose: "octogee-computer", "octogee-owner-uid": "uida", "octogee-gateway-id": "b-old" },
    });
    expect(h.vm.delete).not.toHaveBeenCalled();
    expect(poolLog).toHaveBeenCalledWith(expect.stringMatching(/octogee-pool-half: finished UidA's interrupted claim/));

    await h.runtime.upsertInstance(upsertOpts);

    expect(h.vm.findByLabels).toHaveBeenCalledWith(OWNER_LABELS);
    expect(h.vm.create).not.toHaveBeenCalled();
    expect(h.vm.setMetadata).not.toHaveBeenCalled();
    expect(h.vm.setLabels).toHaveBeenCalledTimes(1);
    expect(h.vm.stop).toHaveBeenCalledWith("octogee-pool-half", "us-west1-b");
    expect(h.vm.bind).toHaveBeenCalledWith("octogee-pool-half", "us-west1-b", {
      labels: { ...OWNER_LABELS, "octogee-gateway-id": "b-x" },
      metadata: { "gateway-id": "b-x", "octogee-owner-uid": "UidA", "octogee-environment": "test", "gateway-image": `${upsertOpts.imageRepository}:main.abc123`, "octogee-api-url": "http://172.20.7.7:3001" },
    });
    expect(h.vm.start).toHaveBeenCalledWith("octogee-pool-half", "us-west1-b");
    expect(h.docs["glmGateways/b-x"].vm).toMatchObject({ instanceName: "octogee-pool-half", instanceId: "id-octogee-pool-half", status: "RUNNING", internalIp: "10.9.0.77", stopReason: null });
    expect(h.routesPublished().at(-1)).toEqual({ "b-x": "10.9.0.77" });
  });

  it("finds a Builder's idle-stopped pooled computer by its owner label on the next activation and rebinds it instead of claiming again", async () => {
    const parkedPooled = boundMember(warmMember("octogee-pool-aa11bb22", { status: "TERMINATED", internalIp: null }), "b-old", "old");
    const rebound = boundMember(warmMember("octogee-pool-aa11bb22", { status: "TERMINATED", internalIp: null }), "b-x");
    const backRunning = boundMember(warmMember("octogee-pool-aa11bb22"), "b-x");
    const h = harness({ "glmGateways/b-x": { docKind: "runtime", gatewayId: "b-x", runtime: "gce-vm" } }, {
      findByLabels: vi.fn(async () => parkedPooled),
      describe: vi.fn(async () => backRunning).mockResolvedValueOnce(rebound),
    });

    await h.runtime.upsertInstance(upsertOpts);

    expect(h.vm.list).not.toHaveBeenCalled();
    expect(h.vm.setMetadata).not.toHaveBeenCalled();
    expect(h.vm.create).not.toHaveBeenCalled();
    expect(h.vm.bind).toHaveBeenCalledWith("octogee-pool-aa11bb22", "us-west1-b", expect.objectContaining({ labels: { ...OWNER_LABELS, "octogee-gateway-id": "b-x" } }));
    expect(h.vm.start).toHaveBeenCalledWith("octogee-pool-aa11bb22", "us-west1-b");
    expect(h.docs["glmGateways/b-x"].vm).toMatchObject({ instanceName: "octogee-pool-aa11bb22", instanceId: "id-octogee-pool-aa11bb22", status: "RUNNING", stopReason: null });
    expect(h.docs["glmGateways/b-x"].vm).not.toHaveProperty("origin");
    expect(h.routesPublished().at(-1)).toEqual({ "b-x": backRunning.internalIp });
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
      metadata: { "gateway-id": "b-x", "octogee-owner-uid": "UidA", "octogee-environment": "test", "gateway-image": `${upsertOpts.imageRepository}:main.abc123`, "octogee-api-url": "http://172.20.7.7:3001" },
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
      describe: vi.fn(async () => running).mockResolvedValueOnce(stopped),
    });

    await h.runtime.upsertInstance(upsertOpts);

    expect(h.vm.stop).toHaveBeenCalledWith(COMPUTER, "us-west1-b");
    expect(h.vm.bind).toHaveBeenCalled();
    expect(h.vm.start).toHaveBeenCalledWith(COMPUTER, "us-west1-b");
    expect(h.vm.stop.mock.invocationCallOrder[0]).toBeLessThan(h.vm.bind.mock.invocationCallOrder[0]);
    expect(h.vm.bind.mock.invocationCallOrder[0]).toBeLessThan(h.vm.start.mock.invocationCallOrder[0]);
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
    await expect(ownerless.runtime.upsertInstance({ ...upsertOpts, ownerUid: undefined })).rejects.toThrow(/needs an owner/);
    expect(ownerless.vm.findByLabels).not.toHaveBeenCalled();
    expect(ownerless.vm.list).not.toHaveBeenCalled();

    const stopping = harness({ "glmGateways/b-x": { docKind: "runtime", gatewayId: "b-x", runtime: "gce-vm", vm: { ...recorded } } }, {
      describe: vi.fn(async () => ({ ...running, status: "STOPPING" })),
    });
    await expect(stopping.runtime.upsertInstance(upsertOpts)).rejects.toThrow(/still stopping/);
    expect(stopping.vm.start).not.toHaveBeenCalled();
  });
});

describe("createVmGatewayRuntime.removeInstance + reads", () => {
  const otherVm = { ...recorded, instanceName: "octogee-computer-test-uidb", instanceId: "4343", internalIp: "172.20.0.10" };

  it("stops the computer instead of deleting it, records the idle stop, and republishes routes without it", async () => {
    const h = harness({
      "glmGateways/b-x": { docKind: "runtime", gatewayId: "b-x", runtime: "gce-vm", vm: { ...recorded }, vmInstance: { enabled: true } },
      "glmGateways/b-x/vm/runtime": { version: "v" },
      "glmGateways/b-y": { docKind: "runtime", gatewayId: "b-y", runtime: "gce-vm", vm: otherVm, vmInstance: { enabled: true, gatewayId: "b-y" } },
    }, { describe: vi.fn(async () => stopped).mockResolvedValueOnce(running) });
    h.docs["glmGateways/b-x"].vmHome = { checkpointRequestedAt: 900, lastCheckpoint: { completedAt: 950 } };
    expect(Object.keys(await h.runtime.readDeployedInstances({ namespace: "octogee-test" }))).toEqual(["b-x", "b-y"]);

    await expect(h.runtime.removeInstance({ namespace: "octogee-test", gatewayId: "b-x" })).rejects.toThrow(/final home checkpoint/);
    expect(h.vm.stop).not.toHaveBeenCalled();
    expect(h.deletes).not.toContain("glmGateways/b-x/vm/runtime");
    expect(readPath(h.docs["glmGateways/b-x"], "vmHome")).toEqual({ checkpointRequestedAt: 1_000, parkRequestedAt: 1_000, lastCheckpoint: { completedAt: 950 } });
    h.vm.describe = vi.fn(async () => stopped).mockResolvedValueOnce(running);
    Object.assign(h.docs["glmGateways/b-x"].vmHome as object, { lastCheckpoint: { completedAt: 1_500 }, checkpointAcknowledgedAt: 1_000 });
    h.clock.now = 2_000;

    await h.runtime.removeInstance({ namespace: "octogee-test", gatewayId: "b-x" });

    expect(h.vm.stop).toHaveBeenCalledWith(COMPUTER, "us-west1-b");
    expect(h.vm.delete).not.toHaveBeenCalled();
    expect(h.deletes).toContain("glmGateways/b-x/vm/runtime");
    expect(h.docs["glmGateways/b-x"].vm).toEqual({
      ...recorded, status: "TERMINATED", internalIp: null, stopReason: "idle", updatedAt: 2_000,
      parkedCheckpoint: { outcome: "fresh", requestedAt: 1_000, completedAt: 1_500 },
    });
    expect(h.docs["glmGateways/b-x"].vmInstance).toBeUndefined();
    expect(h.routesPublished().at(-1)).toEqual({ "b-y": "172.20.0.10" });
    expect(h.log).toHaveBeenCalledWith(expect.stringMatching(/b-x: stopped octogee-computer-test-uida for idle -> TERMINATED.*fresh/));
    expect(await h.runtime.readDeployedInstance({ namespace: "octogee-test", gatewayId: "b-y" })).toMatchObject({ gatewayId: "b-y" });
    expect(await h.runtime.listPendingReleases({ namespace: "octogee-test" })).toEqual([]);
  });

  it("re-drives against an already stopped computer and leaves one that another gateway has since bound", async () => {
    const already = harness({ "glmGateways/b-x": { docKind: "runtime", gatewayId: "b-x", runtime: "gce-vm", vm: { ...recorded, origin: "warm-pool" } } }, {
      describe: vi.fn(async () => stopped),
    });
    await already.runtime.removeInstance({ namespace: "octogee-test", gatewayId: "b-x" });
    expect(already.vm.stop).not.toHaveBeenCalled();
    expect(already.waits).toEqual([]);
    expect(readPath(already.docs["glmGateways/b-x"], "vmHome")).toBeUndefined();
    expect(already.docs["glmGateways/b-x"].vm).toEqual({
      ...recorded, status: "TERMINATED", internalIp: null, stopReason: "idle", origin: "warm-pool", updatedAt: 1_000,
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

  const ownedDoc = { docKind: "runtime", gatewayId: "b-x", runtime: "gce-vm", ownerUid: "UidA", vm: { ...recorded }, vmInstance: { enabled: true } };
  const userDoc = { provisioning: { openclaw: { gatewayId: "b-x", slug: "mama" } }, tier: "builder" };

  it("records the parked computer on the Builder's provisioning record with the checkpoint outcome, keeping the rest of the record", async () => {
    const h = harness({ "glmGateways/b-x": { ...ownedDoc, vmHome: { checkpointRequestedAt: 1_000, checkpointAcknowledgedAt: 1_000, parkRequestedAt: 1_000, lastCheckpoint: { completedAt: 1_500 } } }, "users/UidA": { ...userDoc } }, {
      describe: vi.fn(async () => stopped).mockResolvedValueOnce(running),
    }, "172.20.7.7", {}, { clock: { now: 2_000 } });

    await h.runtime.removeInstance({ namespace: "octogee-test", gatewayId: "b-x" });

    expect(h.docs["users/UidA"]).toEqual({
      ...userDoc,
      provisioning: {
        ...userDoc.provisioning,
        computer: { instanceName: COMPUTER, zone: "us-west1-b", instanceId: "4242", gatewayId: "b-x", parkedAt: 2_000, checkpoint: { outcome: "fresh", requestedAt: 1_000, completedAt: 1_500 } },
      },
    });

    const ownerless = harness({ "glmGateways/b-x": { ...ownedDoc, ownerUid: undefined, vmHome: { checkpointRequestedAt: 1_000, checkpointAcknowledgedAt: 1_000, parkRequestedAt: 1_000, lastCheckpoint: { completedAt: 1_500 } } } }, {
      describe: vi.fn(async () => stopped).mockResolvedValueOnce(running),
    }, "172.20.7.7", {}, { clock: { now: 2_000 } });
    await ownerless.runtime.removeInstance({ namespace: "octogee-test", gatewayId: "b-x" });
    expect(ownerless.vm.stop).toHaveBeenCalled();
    expect(Object.keys(ownerless.docs).filter((path) => path.startsWith("users/"))).toEqual([]);
    expect(ownerless.log).toHaveBeenCalledWith(expect.stringMatching(/⚠ b-x: parked octogee-computer-test-uida without an owner; it is not replaceable while parked/));
  });

  it("parks stale once the final checkpoint bound passes without re-issuing the park's request, and logs the loss window", async () => {
    const h = harness({ "glmGateways/b-x": { ...ownedDoc, vmHome: { checkpointRequestedAt: 100_000, lastCheckpoint: { completedAt: 90_000 } } }, "users/UidA": { ...userDoc } }, {
      describe: vi.fn(async () => running),
    }, "172.20.7.7", {}, { clock: { now: 200_000 } });

    await expect(h.runtime.removeInstance({ namespace: "octogee-test", gatewayId: "b-x" })).rejects.toThrow(/final home checkpoint/);
    expect(readPath(h.docs["glmGateways/b-x"], "vmHome")).toEqual({ checkpointRequestedAt: 200_000, parkRequestedAt: 200_000, lastCheckpoint: { completedAt: 90_000 } });

    h.clock.now = 230_000;
    await expect(h.runtime.removeInstance({ namespace: "octogee-test", gatewayId: "b-x" })).rejects.toThrow(/final home checkpoint/);
    expect(readPath(h.docs["glmGateways/b-x"], "vmHome.checkpointRequestedAt")).toBe(200_000);
    expect(h.vm.stop).not.toHaveBeenCalled();

    h.clock.now = 260_000;
    h.vm.describe = vi.fn(async () => stopped).mockResolvedValueOnce(running);
    await h.runtime.removeInstance({ namespace: "octogee-test", gatewayId: "b-x" });

    expect(h.vm.stop).toHaveBeenCalledWith(COMPUTER, "us-west1-b");
    expect(h.waits).toEqual([]);
    expect(h.docs["glmGateways/b-x"].vm).toMatchObject({ stopReason: "idle", parkedCheckpoint: { outcome: "stale", requestedAt: 200_000, completedAt: 90_000 } });
    expect(readPath(h.docs["users/UidA"], "provisioning.computer")).toMatchObject({ parkedAt: 260_000, checkpoint: { outcome: "stale", requestedAt: 200_000, completedAt: 90_000 } });
    expect(h.log).toHaveBeenCalledWith(expect.stringMatching(/⚠ b-x: octogee-computer-test-uida did not complete its final home checkpoint within 60000ms; parking stale \(last checkpoint 90000\)/));
  });

  it("waits in place for the final checkpoint when retirement asks it to, with the replace action's poll, and parks stale at the bound", async () => {
    const h = harness({ "glmGateways/b-x": { ...ownedDoc }, "users/UidA": { ...userDoc } }, {
      describe: vi.fn(async () => stopped).mockResolvedValueOnce(running).mockResolvedValueOnce(running),
    }, "172.20.7.7", {}, {
      onWait: (_ms, waits) => { if (waits === 2) Object.assign(h.docs["glmGateways/b-x"].vmHome as object, { lastCheckpoint: { completedAt: 21_000 }, checkpointAcknowledgedAt: 1_000 }); },
    });

    await h.runtime.removeInstance({ namespace: "octogee-test", gatewayId: "b-x", awaitHomeCheckpoint: true });

    expect(h.waits).toEqual([10_000, 10_000]);
    expect(h.vm.stop).toHaveBeenCalledWith(COMPUTER, "us-west1-b");
    expect(h.docs["glmGateways/b-x"].vm).toMatchObject({ stopReason: "idle", updatedAt: 21_000, parkedCheckpoint: { outcome: "fresh", requestedAt: 1_000, completedAt: 21_000 } });
    expect(h.deletes).toContain("glmGateways/b-x/vm/runtime");

    const never = harness({ "glmGateways/b-x": { ...ownedDoc }, "users/UidA": { ...userDoc } }, {
      describe: vi.fn(async () => stopped).mockResolvedValueOnce(running),
    });
    await never.runtime.removeInstance({ namespace: "octogee-test", gatewayId: "b-x", awaitHomeCheckpoint: true });
    expect(never.waits).toEqual([10_000, 10_000, 10_000, 10_000, 10_000, 10_000]);
    expect(never.vm.stop).toHaveBeenCalledWith(COMPUTER, "us-west1-b");
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
    expect(h.docs["users/UidA"]).toEqual({ tier: "builder", provisioning: { openclaw: { gatewayId: "b-x" } } });

    const fresh = harness({ "glmGateways/b-x": { docKind: "runtime", gatewayId: "b-x", runtime: "gce-vm" }, "users/UidA": { tier: "builder" } }, {
      describe: vi.fn(async () => running), findByLabels: vi.fn(async () => parkedVm),
    });
    await fresh.runtime.upsertInstance(upsertOpts);
    expect(fresh.writes.filter((w) => w.path === "users/UidA")).toEqual([]);
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
});

describe("createVmGatewayRuntime.deleteComputer", () => {
  it("deletes the owner's computer wherever it is and reports absence", async () => {
    const h = harness({}, { findByLabels: vi.fn(async () => ({ ...stopped, name: "octogee-pool-aa11bb22", zone: "us-central1-a" })) });
    expect(await h.runtime.deleteComputer("UidA")).toBe(true);
    expect(h.vm.findByLabels).toHaveBeenCalledWith(OWNER_LABELS);
    expect(h.vm.delete).toHaveBeenCalledWith("octogee-pool-aa11bb22", "us-central1-a");

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
  it("parses the policy and spec from env, loudly", () => {
    expect(resolveBuilderRuntimePolicy({})).toBe("cluster");
    expect(resolveBuilderRuntimePolicy({ GATEWAY_BUILDER_RUNTIME: "gce-vm" })).toBe("gce-vm");
    expect(() => resolveBuilderRuntimePolicy({ GATEWAY_BUILDER_RUNTIME: "vm" })).toThrow(/must be one of/);
    expect(parseGatewayVmSpec(JSON.stringify(spec))).toEqual(spec);
    expect(() => parseGatewayVmSpec(undefined)).toThrow(/required/);
    expect(() => parseGatewayVmSpec(JSON.stringify({ ...spec, diskSizeGb: "40" }))).toThrow(/diskSizeGb/);
    expect(() => parseGatewayVmSpec(JSON.stringify({ ...spec, provisioningModel: "PREEMPTIBLE" }))).toThrow(/provisioningModel/);
  });

  const deployedCluster = {
    docKind: "runtime", gatewayId: "b-x", lifecycle: "serving",
    helm: { releaseName: "octogee-gw-b-x", deploymentName: "octogee-gateway-b-x", lastAppliedAt: 100 },
    heartbeat: { status: "ready", podName: "octogee-gateway-b-x-abc", startedAt: 110 },
    kubernetes: { status: "ready", totalPods: 1, readyPods: 1, observedAt: 120 },
  };

  it("preserves an unstamped deployed cluster Builder when computers become the new default", async () => {
    const { db, docs } = fakeDb({ "glmGateways/b-x": deployedCluster });
    expect(await stampGatewayRuntime({ db, gatewayId: "b-x", gatewayClass: "builder", policy: "gce-vm", vmSpec: spec, log: vi.fn() })).toBe("cluster");
    expect(docs["glmGateways/b-x"]).toEqual({ ...deployedCluster, runtime: "cluster" });
  });

  it("preserves the deployed cluster identity even when its pod is stopped or missing", async () => {
    const previous = { ...deployedCluster, kubernetes: { status: "missing", totalPods: 0, readyPods: 0, observedAt: 130 } };
    const { db, docs } = fakeDb({ "glmGateways/b-x": previous });
    expect(await stampGatewayRuntime({ db, gatewayId: "b-x", gatewayClass: "builder", policy: "gce-vm", vmSpec: spec, log: vi.fn() })).toBe("cluster");
    expect(docs["glmGateways/b-x"].runtime).toBe("cluster");
  });

  it("chooses the VM default only before a new Builder has a deployed identity", async () => {
    const { db, docs } = fakeDb({ "glmGateways/b-x": { docKind: "runtime", gatewayId: "b-x", lifecycle: "provisioning", helm: { lastAppliedAt: null }, heartbeat: { status: "unknown" } } });
    expect(await stampGatewayRuntime({ db, gatewayId: "b-x", gatewayClass: "builder", policy: "gce-vm", vmSpec: spec, log: vi.fn() })).toBe("gce-vm");
    expect(docs["glmGateways/b-x"].runtime).toBe("gce-vm");
  });

  it("preserves an explicit cluster stamp and accepts generic VM heartbeat names without mistaking them for pod evidence", async () => {
    const { db, writes } = fakeDb({
      "glmGateways/b-x": { ...deployedCluster, runtime: "cluster" },
      "glmGateways/b-vm": { runtime: "gce-vm", vm: recorded, heartbeat: { status: "ready", podName: "generic-vm-hostname" }, helm: { lastAppliedAt: 100, availableReplicas: 1 }, kubernetes: { status: "unknown", totalPods: 0 } },
    });
    expect(await stampGatewayRuntime({ db, gatewayId: "b-x", gatewayClass: "builder", policy: "gce-vm", vmSpec: spec, log: vi.fn() })).toBe("cluster");
    expect(await stampGatewayRuntime({ db, gatewayId: "b-vm", gatewayClass: "builder", policy: "cluster", vmSpec: null, log: vi.fn() })).toBe("gce-vm");
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
    await expect(stampGatewayRuntime({ db, gatewayId: "b-x", gatewayClass: "builder", policy: "gce-vm", vmSpec: spec, log: vi.fn() })).rejects.toThrow(/runtime|conflict|unstamped/);
    expect(writes).toEqual([]);
  });

  it("stamps a Builder gateway with the policy runtime once and never rewrites an existing runtime", async () => {
    const { db, docs, writes } = fakeDb({});
    const log = vi.fn();
    expect(await stampGatewayRuntime({ db, gatewayId: "b-x", gatewayClass: "builder", policy: "gce-vm", vmSpec: spec, log })).toBe("gce-vm");
    expect(docs["glmGateways/b-x"]).toEqual({ runtime: "gce-vm", vmSpec: spec });
    expect(await stampGatewayRuntime({ db, gatewayId: "b-x", gatewayClass: "builder", policy: "cluster", vmSpec: null, log })).toBe("gce-vm");
    expect(writes).toHaveLength(1);
    expect(await stampGatewayRuntime({ db, gatewayId: "shared-1", gatewayClass: "shared", policy: "gce-vm", vmSpec: spec, log })).toBe("cluster");
    expect(docs["glmGateways/shared-1"]).toEqual({ runtime: "cluster" });
    await expect(stampGatewayRuntime({ db, gatewayId: "b-z", gatewayClass: "builder", policy: "gce-vm", vmSpec: null, log })).rejects.toThrow(/needs a vmSpec/);
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
