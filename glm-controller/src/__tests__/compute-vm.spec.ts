import { describe, it, expect, vi } from "vitest";
import {
  ComputeOperationError,
  createGatewayVmClient,
  instanceInsertBody,
  type ComputeRequest,
  type CreateGatewayVmInput,
} from "../lib/compute-vm";

const BASE = "https://compute.googleapis.com/compute/v1/projects/octogee-test";

const input: CreateGatewayVmInput = {
  instanceName: "octogee-gw-b-mama-3-abc-hobby",
  zone: "us-west1-b",
  machineType: "n2-standard-4",
  imageFamily: "octogee-computer",
  diskSizeGb: 40,
  provisioningModel: "SPOT",
  serviceAccountEmail: "octogee-gw-b-mama-3-abc-hobby@octogee-test.iam.gserviceaccount.com",
  subnetwork: "regions/us-west1/subnetworks/octogee-gateways",
  labels: { "octogee-gateway-id": "b-mama-3-abc-hobby", purpose: "octogee-computer" },
  metadata: { "gateway-id": "b-mama-3-abc-hobby", "octogee-environment": "test" },
};

type Call = { url: string; method: string; body?: unknown };

function fakeCompute(script: (call: Call, calls: Call[]) => { status: number; data?: unknown } | Error) {
  const calls: Call[] = [];
  const request: ComputeRequest = vi.fn(async (call: Call) => {
    calls.push(call);
    const out = script(call, calls);
    if (out instanceof Error) throw out;
    return out;
  });
  return { request, calls };
}

function http(status: number): Error {
  return Object.assign(new Error(`http ${status}`), { response: { status } });
}

function clientWith(request: ComputeRequest) {
  const log = vi.fn();
  let clock = 0;
  const client = createGatewayVmClient({
    request,
    projectId: "octogee-test",
    log,
    wait: async () => { clock += 1_000; },
    now: () => clock,
    operationTimeoutMs: 10_000,
    pollIntervalMs: 1_000,
  });
  return { client, log };
}

const instance = (overrides: Record<string, unknown> = {}) => ({
  status: 200,
  data: {
    id: "1234567890",
    name: input.instanceName,
    status: "RUNNING",
    networkInterfaces: [{ networkIP: "10.138.0.9" }],
    scheduling: { provisioningModel: "SPOT" },
    ...overrides,
  },
});

describe("instanceInsertBody", () => {
  it("renders a Spot VM from the image family with no external IP and the gateway identity", () => {
    const body = instanceInsertBody("octogee-test", input, "SPOT") as Record<string, any>;
    expect(body.name).toBe(input.instanceName);
    expect(body.machineType).toBe("zones/us-west1-b/machineTypes/n2-standard-4");
    expect(body.disks[0].initializeParams.sourceImage).toBe("projects/octogee-test/global/images/family/octogee-computer");
    expect(body.disks[0].initializeParams.diskSizeGb).toBe("40");
    expect(body.disks[0].autoDelete).toBe(true);
    expect(body.networkInterfaces).toEqual([{ subnetwork: input.subnetwork }]);
    expect(body.serviceAccounts[0].email).toBe(input.serviceAccountEmail);
    expect(body.scheduling).toEqual({
      provisioningModel: "SPOT",
      instanceTerminationAction: "STOP",
      automaticRestart: false,
      onHostMaintenance: "TERMINATE",
    });
    expect(body.labels).toEqual(input.labels);
    expect(body.metadata.items).toEqual([
      { key: "gateway-id", value: "b-mama-3-abc-hobby" },
      { key: "octogee-environment", value: "test" },
    ]);
  });

  it("renders on-demand scheduling for STANDARD", () => {
    const body = instanceInsertBody("octogee-test", input, "STANDARD") as Record<string, any>;
    expect(body.scheduling).toEqual({ provisioningModel: "STANDARD", automaticRestart: true, onHostMaintenance: "MIGRATE" });
  });
});

describe("createGatewayVmClient.create", () => {
  it("inserts, waits for the zone operation, and describes the instance", async () => {
    const { request, calls } = fakeCompute((call) => {
      if (call.method === "POST" && call.url === `${BASE}/zones/us-west1-b/instances`) {
        return { status: 200, data: { name: "op-1", status: "RUNNING" } };
      }
      if (call.url === `${BASE}/zones/us-west1-b/operations/op-1`) {
        return { status: 200, data: { name: "op-1", status: calls.length >= 3 ? "DONE" : "RUNNING" } };
      }
      if (call.method === "GET" && call.url === `${BASE}/zones/us-west1-b/instances/${input.instanceName}`) {
        return instance();
      }
      return new Error(`unexpected ${call.method} ${call.url}`);
    });
    const { client } = clientWith(request);

    const result = await client.create(input);

    expect(result.alreadyExisted).toBe(false);
    expect(result.fellBackToStandard).toBe(false);
    expect(result.provisioningModel).toBe("SPOT");
    expect(result.description).toEqual({
      name: input.instanceName,
      zone: "us-west1-b",
      status: "RUNNING",
      instanceId: "1234567890",
      internalIp: "10.138.0.9",
      provisioningModel: "SPOT",
    });
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("falls back to on-demand when the zone has no Spot capacity", async () => {
    const posts: unknown[] = [];
    const { request } = fakeCompute((call) => {
      if (call.method === "POST" && call.url.endsWith("/instances")) {
        posts.push(call.body);
        return { status: 200, data: { name: `op-${posts.length}`, status: "RUNNING" } };
      }
      if (call.url.endsWith("/operations/op-1")) {
        return {
          status: 200,
          data: { name: "op-1", status: "DONE", error: { errors: [{ code: "ZONE_RESOURCE_POOL_EXHAUSTED", message: "no spot" }] } },
        };
      }
      if (call.url.endsWith("/operations/op-2")) return { status: 200, data: { name: "op-2", status: "DONE" } };
      if (call.method === "GET" && call.url.endsWith(`/instances/${input.instanceName}`)) {
        return instance({ scheduling: { provisioningModel: "STANDARD" } });
      }
      return new Error(`unexpected ${call.method} ${call.url}`);
    });
    const { client, log } = clientWith(request);

    const result = await client.create(input);

    expect(posts).toHaveLength(2);
    expect((posts[0] as any).scheduling.provisioningModel).toBe("SPOT");
    expect((posts[1] as any).scheduling.provisioningModel).toBe("STANDARD");
    expect(result.fellBackToStandard).toBe(true);
    expect(result.provisioningModel).toBe("STANDARD");
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/spot capacity exhausted .* retrying on-demand/));
  });

  it("does not fall back for an on-demand request that fails, and surfaces the code", async () => {
    const { request, calls } = fakeCompute((call) => {
      if (call.method === "POST") return { status: 200, data: { name: "op-1", status: "RUNNING" } };
      if (call.url.endsWith("/operations/op-1")) {
        return { status: 200, data: { name: "op-1", status: "DONE", error: { errors: [{ code: "QUOTA_EXCEEDED", message: "cpus" }] } } };
      }
      return new Error(`unexpected ${call.method} ${call.url}`);
    });
    const { client } = clientWith(request);

    await expect(client.create({ ...input, provisioningModel: "STANDARD" })).rejects.toBeInstanceOf(ComputeOperationError);
    await expect(client.create({ ...input, provisioningModel: "STANDARD" })).rejects.toThrow(/QUOTA_EXCEEDED: cpus/);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(2);
  });

  it("reuses an existing instance when insert returns 409", async () => {
    const { request, calls } = fakeCompute((call) => {
      if (call.method === "POST") return http(409);
      if (call.method === "GET" && call.url.endsWith(`/instances/${input.instanceName}`)) return instance({ status: "TERMINATED" });
      return new Error(`unexpected ${call.method} ${call.url}`);
    });
    const { client, log } = clientWith(request);

    const result = await client.create(input);

    expect(result.alreadyExisted).toBe(true);
    expect(result.description.status).toBe("TERMINATED");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/already exists \(TERMINATED\)/));
  });

  it("fails loudly when the operation never finishes", async () => {
    const { request } = fakeCompute((call) => {
      if (call.method === "POST") return { status: 200, data: { name: "op-1", status: "RUNNING" } };
      if (call.url.endsWith("/operations/op-1")) return { status: 200, data: { name: "op-1", status: "RUNNING" } };
      return new Error(`unexpected ${call.method} ${call.url}`);
    });
    const { client } = clientWith(request);

    await expect(client.create(input)).rejects.toThrow(/did not finish within 10000ms/);
  });
});

describe("createGatewayVmClient lifecycle", () => {
  it("describe returns null for a missing instance", async () => {
    const { request } = fakeCompute(() => http(404));
    const { client } = clientWith(request);
    expect(await client.describe("octogee-gw-nope", "us-west1-b")).toBeNull();
  });

  it("stop and start post the lifecycle verb and wait for the operation", async () => {
    const { request, calls } = fakeCompute((call) => {
      if (call.method === "POST") return { status: 200, data: { name: `op-${call.url.split("/").pop()}`, status: "DONE" } };
      return new Error(`unexpected ${call.method} ${call.url}`);
    });
    const { client } = clientWith(request);

    await client.stop(input.instanceName, "us-west1-b");
    await client.start(input.instanceName, "us-west1-b");

    expect(calls.map((c) => c.url)).toEqual([
      `${BASE}/zones/us-west1-b/instances/${input.instanceName}/stop`,
      `${BASE}/zones/us-west1-b/instances/${input.instanceName}/start`,
    ]);
  });

  it("delete is idempotent on 404 and reports whether anything was deleted", async () => {
    const present = fakeCompute((call) => {
      if (call.method === "DELETE") return { status: 200, data: { name: "op-del", status: "DONE" } };
      return new Error(`unexpected ${call.method} ${call.url}`);
    });
    const absent = fakeCompute(() => http(404));

    expect(await clientWith(present.request).client.delete(input.instanceName, "us-west1-b")).toBe(true);
    expect(await clientWith(absent.request).client.delete(input.instanceName, "us-west1-b")).toBe(false);
    expect(present.calls[0]).toMatchObject({ method: "DELETE", url: `${BASE}/zones/us-west1-b/instances/${input.instanceName}` });
  });

  it("propagates non-404 failures from every verb", async () => {
    const { request } = fakeCompute(() => http(403));
    const { client } = clientWith(request);
    await expect(client.describe("x", "us-west1-b")).rejects.toThrow(/http 403/);
    await expect(client.delete("x", "us-west1-b")).rejects.toThrow(/http 403/);
    await expect(client.stop("x", "us-west1-b")).rejects.toThrow(/http 403/);
  });
});
