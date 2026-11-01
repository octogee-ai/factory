import { describe, expect, it, vi } from "vitest";
import { hasCoachReply, parseLoadPlan, performCoachTurn, runLoadPlan, summarizeMeasurements, type LoadClient, type LoadMeasurement, LoadHttpError } from "../lib/gateway-load-test.js";
import { createSharedPoolSampler, parseCgroup, slotObservation, stableMediumPod } from "../lib/gateway-load-sampler.js";
import { testToken, testTokens } from "../lib/gateway-load-client.js";

const target = (name = "alice") => ({ name, workspaceSlug: name, tokenEnv: `OCTOGEE_LOAD_TOKEN_${name.toUpperCase()}`,
  channelId: name[0].repeat(26) });
const input = { gatewayId: "shared-0", targets: [target(), target("bob")], readConcurrency: [1, 2] };

describe("TEST gateway load boundaries", () => {
  it("rejects production overrides, duplicate identities, and invalid concurrency", () => {
    expect(() => parseLoadPlan({ ...input, apiOrigin: "https://api.octogee.com" })).toThrow("cannot be overridden");
    expect(() => parseLoadPlan({ ...input, gatewayId: "builder-1" })).toThrow("shared");
    expect(() => parseLoadPlan({ ...input, targets: [target(), target()] })).toThrow("distinct");
    expect(() => parseLoadPlan({ ...input, readConcurrency: [3] })).toThrow("integer");
    expect(() => parseLoadPlan({ ...input, readConcurrency: [0] })).toThrow("integer");
  });

  it("accepts numbered and minted shared slot IDs and nothing else", () => {
    expect(parseLoadPlan({ ...input, gatewayId: "shared-1d4ef9d5a9da" }).gatewayId).toBe("shared-1d4ef9d5a9da");
    expect(parseLoadPlan({ ...input, gatewayId: "shared-0" }).gatewayId).toBe("shared-0");
    for (const gatewayId of ["shared-1D4EF9D5A9DA", "shared-1d4ef9d5a9", "shared-", "builder-1d4ef9d5a9da"]) {
      expect(() => parseLoadPlan({ ...input, gatewayId })).toThrow("shared");
    }
  });

  it("bounds reconnect rounds", () => {
    expect(() => parseLoadPlan({ ...input, readRounds: 6 })).toThrow("readRounds");
  });

  it("requires an explicit total turn budget, rather than a per-stage budget", () => {
    expect(() => parseLoadPlan({ ...input, coachConcurrency: [1, 2], maxCoachTurns: 2 })).toThrow("exceed");
    expect(parseLoadPlan({ ...input, coachConcurrency: [1, 2], maxCoachTurns: 3 }).maxCoachTurns).toBe(3);
  });

  it("rejects different environment variables for the same Firebase identity", () => {
    const token = (sub: string) => `header.${Buffer.from(JSON.stringify({ sub, aud: "octogee-test",
      iss: "https://securetoken.google.com/octogee-test", exp: Date.now() / 1_000 + 3600 })).toString("base64url")}.signature`;
    const env = { OCTOGEE_LOAD_TOKEN_ALICE: token("alice"), OCTOGEE_LOAD_TOKEN_BOB: token("alice") };
    expect(() => testTokens(input.targets, env)).toThrow("distinct Firebase");
    env.OCTOGEE_LOAD_TOKEN_BOB = token("bob");
    expect(testTokens(input.targets, env).size).toBe(2);
  });

  it("requires tokens to outlive the full run deadline and setup margin", () => {
    const token = (minutes: number) => `header.${Buffer.from(JSON.stringify({ sub: "alice", aud: "octogee-test",
      iss: "https://securetoken.google.com/octogee-test", exp: Date.now() / 1_000 + minutes * 60 })).toString("base64url")}.signature`;
    for (const minutes of [3, 30, 34]) {
      expect(() => testToken(target(), { OCTOGEE_LOAD_TOKEN_ALICE: token(minutes) })).toThrow("fresh");
    }
    expect(testToken(target(), { OCTOGEE_LOAD_TOKEN_ALICE: token(36) }).uid).toBe("alice");
  });

  it("accepts TEST tokens only", () => {
    const token = (aud: string, exp = Date.now() / 1_000 + 3600) => `header.${Buffer.from(JSON.stringify({ aud, sub: "alice",
      iss: `https://securetoken.google.com/${aud}`, exp })).toString("base64url")}.signature`;
    expect(testToken(target(), { OCTOGEE_LOAD_TOKEN_ALICE: token("octogee-test") }).token).toContain("header.");
    expect(() => testToken(target(), { OCTOGEE_LOAD_TOKEN_ALICE: token("octogee") })).toThrow("octogee-test");
    expect(() => testToken(target(), { OCTOGEE_LOAD_TOKEN_ALICE: token("octogee-test", 0) })).toThrow("fresh");

  });
});

describe("staged gateway exercises", () => {
  it("reconnects each read target and waits for a correlated assistant reply after send acknowledgement", async () => {
    const rows: LoadMeasurement[] = [];
    const send = vi.fn();
    const waits: number[] = [];
    const clients: LoadClient[] = [];
    let time = 0;
    const plan = parseLoadPlan({ ...input, readRounds: 1, coachConcurrency: [1, 2], maxCoachTurns: 3 });
    await runLoadPlan(plan, {
      now: () => time, signal: new AbortController().signal, emit: (r) => rows.push(r),
      sleep: async (ms) => { waits.push(ms); time += ms; },
      connect: async () => {
        let marker = "", reads = 0;
        const client = { close: vi.fn(), send: async (message: string, id: string) => {
          send(message, id); marker = message.match(/OCTOGEE_LOAD_[a-f0-9-]+/)![0];
        }, read: async () => {
          reads++;
          return { messages: marker && reads > 1 ? [{ role: "assistant", content: [{ type: "text", text: marker }] }]
            : [{ role: "user", content: marker }] };
        } };
        clients.push(client); return client;
      },
    });
    expect(waits.filter((ms) => ms === 65_000)).toHaveLength(3);
    expect(send).toHaveBeenCalledTimes(3);
    expect(new Set(send.mock.calls.map((c) => c[1])).size).toBe(3);
    expect(rows.filter((r) => r.operation === "reconnect")).toHaveLength(3);
    expect(rows.filter((r) => r.operation === "coach_complete")).toHaveLength(3);
    expect(rows.filter((r) => r.operation === "coach_complete").every((r) => r.durationMs >= 2_000)).toBe(true);
    expect(clients.every((c) => vi.mocked(c.close).mock.calls.length > 0)).toBe(true);
    expect(rows.every((r) => r.ok)).toBe(true);
  });

  it("polls history at the configured interval until the exact nonce reply arrives", async () => {
    let time = 0, marker = "";
    const waits: number[] = [];
    const client: LoadClient = { close: vi.fn(), send: async (message) => { marker = message.match(/OCTOGEE_LOAD_[a-f0-9-]+/)![0]; },
      read: async () => ({ messages: time >= 9_000 ? [{ role: "assistant", content: marker }] : [] }) };
    await performCoachTurn(client, { timeoutMs: 60_000, pollMs: 3_000, signal: new AbortController().signal, now: () => time,
      sleep: async (ms) => { waits.push(ms); time += ms; } });
    expect(waits).toEqual([3_000, 3_000, 3_000]);
    await expect(performCoachTurn(client, { timeoutMs: 5_000, pollMs: 3_000, signal: new AbortController().signal, now: () => time,
      sleep: async (ms) => { time += ms; }, send: async () => { marker = "never"; } })).rejects.toThrow("deadline");
  });

  it("does not count echoed user messages or unrelated assistant replies as completion", () => {
    expect(hasCoachReply({ messages: [{ role: "user", content: "marker" }, { role: "assistant", content: "old" }] }, "marker")).toBe(false);
    expect(hasCoachReply({ messages: [{ role: "assistant", content: "User asked for marker" }] }, "marker")).toBe(false);
    expect(() => hasCoachReply({}, "marker")).toThrow("history");
  });

  it("stops subsequent stages after a timeout and never resends a coach turn", async () => {
    let time = 0;
    const client = { read: vi.fn(async () => ({ messages: [] })), send: vi.fn(async () => {}), close: vi.fn() };
    const connect = vi.fn(async () => client);
    const rows: LoadMeasurement[] = [];
    await expect(runLoadPlan(parseLoadPlan({ ...input, readConcurrency: [], coachConcurrency: [1, 2], maxCoachTurns: 3, turnTimeoutMs: 1_000 }), {
      connect, signal: new AbortController().signal, emit: (r) => rows.push(r), now: () => time,
      sleep: async (ms) => { time += ms; },
    })).rejects.toThrow("deadline");
    expect(connect).toHaveBeenCalledOnce();
    expect(client.send).toHaveBeenCalledOnce();
    expect(client.close).toHaveBeenCalled();
    expect(rows.find((r) => r.operation === "coach_complete")?.ok).toBe(false);
  });

  it("records HTTP failures separately from cancelled peers without exposing error bodies", async () => {
    const rows: LoadMeasurement[] = [];
    await expect(runLoadPlan(parseLoadPlan({ ...input, readConcurrency: [1] }), {
      connect: async () => { throw new LoadHttpError(429); }, signal: new AbortController().signal,
      emit: (row) => rows.push(row), sleep: vi.fn(),
    })).rejects.toThrow("Load HTTP 429");
    expect(rows[0]).toMatchObject({ ok: false, failure: { code: "http", httpStatus: 429 } });
  });

  it("honors cancellation before any connection or message", async () => {
    const controller = new AbortController(); controller.abort();
    const connect = vi.fn();
    await expect(runLoadPlan(parseLoadPlan(input), { connect, signal: controller.signal, emit: vi.fn(), sleep: vi.fn() })).rejects.toThrow();
    expect(connect).not.toHaveBeenCalled();
  });

  it("keeps failed requests in the reported latency and failure totals", () => {
    const rows = [10, 20, 100].map((durationMs) => ({ at: "now", stage: "reads-1", target: "alice", operation: "read" as const, durationMs, ok: durationMs < 100 }));
    expect(summarizeMeasurements(rows)[0]).toMatchObject({ count: 3, failures: 1, p50Ms: 20, p95Ms: 100, maxMs: 100 });
  });
});

describe("Medium resource preflight", () => {
  const pod = () => ({ metadata: { name: "pod", uid: "id", labels: { tier: "m" } }, spec: { nodeName: "node",
    containers: [{ name: "gateway", image: "image", resources: { requests: { cpu: "2", memory: "8Gi" }, limits: { cpu: "2", memory: "8Gi" } } }],
  }, status: { containerStatuses: [{ name: "gateway", ready: true, restartCount: 0 }] } });
  it("refuses a surge, unready gateway, or resource drift", () => {
    expect(stableMediumPod([pod()]).metadata.uid).toBe("id");
    expect(() => stableMediumPod([pod(), pod()])).toThrow("surge");
    const unready = pod(); unready.status.containerStatuses[0].ready = false;
    expect(() => stableMediumPod([unready])).toThrow("Ready");
    const large = pod(); large.spec.containers[0].resources.limits.memory = "16Gi";
    expect(() => stableMediumPod([large])).toThrow("2CPU/8GiB");
  });
  it("parses pressure separately from CPU and memory counters and fails closed on missing telemetry", () => {
    const raw = "FILE cpu.stat\nusage_usec 200\nnr_periods 10\nnr_throttled 2\nFILE memory.current\n1024\nFILE memory.stat\ninactive_file 100\nFILE memory.events\noom_kill 0\nFILE cpu.pressure\nsome avg10=0.10 avg60=0.20 total=500\n";
    expect(parseCgroup(raw)).toMatchObject({ "cpu.pressure": { "some.avg60": 0.2 }, "memory.current": { value: 1024 } });
    expect(() => parseCgroup("FILE cpu.stat\nusage_usec 1")).toThrow();
  });
});

describe("shared pool sampler", () => {
  const cgroup = (oom = 0) => `FILE cpu.stat\nusage_usec 200\nnr_periods 10\nnr_throttled 2\nFILE memory.current\n1024\nFILE memory.stat\ninactive_file 100\nFILE memory.events\noom_kill ${oom}\n`;
  const pod = (gatewayId: string, over: { ready?: boolean; uid?: string; name?: string; runtimeClassName?: string; restartCount?: number; lastTerminated?: string } = {}) => ({
    metadata: { name: over.name ?? `${gatewayId}-pod`, uid: over.uid ?? `${gatewayId}-uid`, labels: { tier: "m", "gateway-id": gatewayId, app: "octogee-gateway" } },
    spec: { nodeName: "node-a", ...(over.runtimeClassName ? { runtimeClassName: over.runtimeClassName } : {}),
      containers: [{ name: "gateway", image: "image", resources: { requests: { cpu: "2", memory: "8Gi" }, limits: { cpu: "2", memory: "8Gi" } } }] },
    status: { containerStatuses: [{ name: "gateway", ready: over.ready ?? true, restartCount: over.restartCount ?? 0,
      ...(over.lastTerminated ? { lastState: { terminated: { reason: over.lastTerminated } } } : {}) }] },
  });
  const fakeKubectl = (state: { pods: unknown[]; oom: Record<string, number>; podUsage?: Record<string, { name: string; usage: { cpu: string; memory: string } }[]> }) => {
    const calls: string[][] = [];
    const kubectl = async (...args: string[]) => {
      calls.push(args);
      if (args[0] === "get" && args[1] === "pods") return JSON.stringify({ items: state.pods });
      if (args[0] === "get" && args[1] === "--raw" && args[2].includes("/pods/")) {
        return JSON.stringify({ containers: state.podUsage?.[args[2].split("/").at(-1)!] ?? [] });
      }
      if (args[0] === "get" && args[1] === "--raw") return JSON.stringify({ usage: { cpu: "1", memory: "1Gi" }, timestamp: "t" });
      if (args[0] === "exec" && args.at(-1)!.includes("df")) return "fs";
      if (args[0] === "exec") return cgroup(state.oom[args[1]] ?? 0);
      throw new Error(`unexpected kubectl ${args.join(" ")}`);
    };
    return { kubectl, calls };
  };

  it("samples every Ready shared-N slot, lists starting slots without exec, and ignores builder gateways", async () => {
    const { kubectl, calls } = fakeKubectl({ pods: [pod("shared-0"), pod("shared-1", { ready: false }), pod("builder-7")], oom: {} });
    const sample = await createSharedPoolSampler(kubectl)();
    expect(sample.slots.map((s) => s.slot)).toEqual(["shared-0"]);
    expect(sample.starting).toEqual([{ slot: "shared-1", pod: "shared-1-pod" }]);
    expect(sample.violations).toEqual([]);
    expect(calls.filter((c) => c[0] === "exec").map((c) => c[1])).toEqual(["shared-0-pod", "shared-0-pod"]);
  });

  it("samples minted shared slots alongside numbered ones", async () => {
    const { kubectl } = fakeKubectl({ pods: [pod("shared-7bf0dde2d0a4"), pod("shared-1d4ef9d5a9da"), pod("qa-octogee-s-6e7df6e1")], oom: {} });
    expect((await createSharedPoolSampler(kubectl)()).slots.map((s) => s.slot)).toEqual(["shared-1d4ef9d5a9da", "shared-7bf0dde2d0a4"]);
  });

  it("flags OOM kills and pod replacement per slot, and forgets a slot that scales away", async () => {
    const state = { pods: [pod("shared-0"), pod("shared-1")], oom: {} as Record<string, number> };
    const { kubectl } = fakeKubectl(state);
    const sampler = createSharedPoolSampler(kubectl);
    expect((await sampler()).violations).toEqual([]);
    state.oom["shared-1-pod"] = 1;
    state.pods = [pod("shared-0", { uid: "new" }), pod("shared-1")];
    expect((await sampler()).violations).toEqual(["shared-0:pod-replaced", "shared-1:oom-kill"]);
    state.pods = [pod("shared-0", { uid: "new" })];
    expect((await sampler()).violations).toEqual(["shared-0:pod-replaced"]);
    state.pods = [pod("shared-0", { uid: "new" }), pod("shared-1", { uid: "again" })];
    expect((await sampler()).violations).toEqual(["shared-0:pod-replaced"]);
  });

  it("keeps a slot's baseline while its pod is unready so a replacement surfaces when it returns", async () => {
    const state = { pods: [pod("shared-1")], oom: {} };
    const { kubectl } = fakeKubectl(state);
    const sampler = createSharedPoolSampler(kubectl);
    expect((await sampler()).violations).toEqual([]);
    state.pods = [pod("shared-1", { uid: "replacement", ready: false })];
    expect(await sampler()).toMatchObject({ slots: [], starting: [{ slot: "shared-1" }], violations: [] });
    state.pods = [pod("shared-1", { uid: "replacement" })];
    expect((await sampler()).violations).toEqual(["shared-1:pod-replaced"]);
  });

  it("samples a gVisor slot from the metrics API without reading its emulated cgroups", async () => {
    const { kubectl, calls } = fakeKubectl({
      pods: [pod("shared-0", { runtimeClassName: "gvisor" })],
      oom: {},
      podUsage: { "shared-0-pod": [{ name: "gateway", usage: { cpu: "500000000n", memory: "2097152Ki" } }, { name: "gateway-edge", usage: { cpu: "50m", memory: "200Mi" } }] },
    });
    const sample = await createSharedPoolSampler(kubectl)();
    expect(sample.slots[0]).toMatchObject({
      telemetry: "metrics-api",
      cpuCores: 0.5,
      workingSetBytes: 2 * 1024 ** 3,
      memoryRatio: 0.25,
      chargedBytes: null,
      throttledPeriodRatio: null,
      cgroup: null,
    });
    expect(sample.violations).toEqual([]);
    expect(calls.filter((c) => c[0] === "exec").every((c) => c.at(-1)!.includes("df"))).toBe(true);
  });

  it("flags an OOM-killed gVisor gateway from its container status", async () => {
    const usage = [{ name: "gateway", usage: { cpu: "1", memory: "1Gi" } }];
    const state = { pods: [pod("shared-0", { runtimeClassName: "gvisor" })], oom: {}, podUsage: { "shared-0-pod": usage } };
    const { kubectl } = fakeKubectl(state);
    const sampler = createSharedPoolSampler(kubectl);
    expect((await sampler()).violations).toEqual([]);
    state.pods = [pod("shared-0", { runtimeClassName: "gvisor", restartCount: 1, lastTerminated: "OOMKilled" })];
    expect((await sampler()).violations).toEqual(["shared-0:container-restart", "shared-0:oom-kill"]);
  });

  it("keeps sidecar OOMs out of gateway telemetry while still flagging the restart", async () => {
    const sandbox = pod("shared-0", { runtimeClassName: "gvisor" });
    sandbox.spec.containers.push({ ...sandbox.spec.containers[0], name: "gateway-edge" });
    sandbox.status.containerStatuses.push({ name: "gateway-edge", ready: true, restartCount: 0 });
    const state = { pods: [sandbox], oom: {}, podUsage: { "shared-0-pod": [{ name: "gateway", usage: { cpu: "1", memory: "1Gi" } }] } };
    const { kubectl } = fakeKubectl(state);
    const sampler = createSharedPoolSampler(kubectl);
    expect((await sampler()).violations).toEqual([]);
    sandbox.status.containerStatuses[1].restartCount = 1;
    sandbox.status.containerStatuses[1].lastState = { terminated: { reason: "OOMKilled" } };
    expect((await sampler()).violations).toEqual(["shared-0:container-restart"]);
  });

  it("fails closed when the metrics API has no gateway usage for a gVisor slot", async () => {
    const { kubectl } = fakeKubectl({ pods: [pod("shared-0", { runtimeClassName: "gvisor" })], oom: {}, podUsage: {} });
    await expect(createSharedPoolSampler(kubectl)()).rejects.toThrow("gateway usage");
  });

  it("keeps reading cgroups on the standard runtime", async () => {
    const { kubectl } = fakeKubectl({ pods: [pod("shared-0")], oom: {} });
    expect((await createSharedPoolSampler(kubectl)()).slots[0]).toMatchObject({ telemetry: "cgroup", chargedBytes: 1024 });
  });

  it("reduces a sample to the serving and starting slot names", async () => {
    const { kubectl } = fakeKubectl({ pods: [pod("shared-2"), pod("shared-0"), pod("shared-1", { ready: false })], oom: {} });
    expect(slotObservation(await createSharedPoolSampler(kubectl)())).toMatchObject({ serving: ["shared-0", "shared-2"], starting: ["shared-1"] });
  });
});
