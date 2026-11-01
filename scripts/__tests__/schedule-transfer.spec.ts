import { describe, expect, it, vi } from "vitest";
import type { ScheduleRecord } from "../../shared/types/fleet-controller.js";
import { createScheduleTransfer, removeSchedules, restoreSchedules, snapshotSchedules } from "../lib/schedule-transfer.js";

type Job = Record<string, unknown>;

const ALICE = "octogee-alice-coach";
const ALICE_PROJECT = "octogee-alice-proj-orbit-coach";
const ALICE_AGENTS = new Set([ALICE, ALICE_PROJECT]);

function listedJob(id: string, overrides: Job = {}): Job {
  return {
    id,
    name: `Brief ${id}`,
    agentId: ALICE,
    effectiveAgentId: ALICE,
    sessionKey: `agent:${ALICE}:main`,
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 2,
    configRevision: `rev-${id}`,
    schedule: { kind: "cron", expr: "0 8 * * 1-5", tz: "America/Chicago" },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "Morning brief", toolsAllow: ["message"] },
    delivery: { mode: "announce", channel: "mattermost", accountId: "alice-coach", to: "channel:abc" },
    owner: { agentId: ALICE, accountId: "alice-coach", sessionKey: `agent:${ALICE}:mattermost:channel:abc` },
    scheduledToolPolicy: { version: 1, mode: "account", ownerSessionKey: `agent:${ALICE}:mattermost:channel:abc`, ownerAccountId: "alice-coach" },
    state: { nextRunAtMs: 10, lastRunStatus: "ok" },
    nextRunAtMs: 10,
    lastRunAtMs: 5,
    lastRunStatus: "ok",
    ...overrides,
  };
}

function fakeGateway(initial: Job[], options: {
  pageSize?: number;
  failRemove?: (id: string) => boolean;
  failAdd?: (job: Job) => boolean;
  scratch?: Record<string, string>;
  failScratch?: "get" | "set";
} = {}) {
  const store = initial.map((job) => ({ ...job }));
  const scratch = new Map(Object.entries(options.scratch ?? {}));
  let nextId = 1;
  const call = vi.fn(async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    if (method === "cron.list") {
      const offset = params.offset as number;
      const limit = Math.min(params.limit as number, options.pageSize ?? 200);
      const jobs = store.slice(offset, offset + limit);
      const next = offset + jobs.length;
      const hasMore = next < store.length;
      return { jobs, total: store.length, offset, limit, hasMore, nextOffset: hasMore ? next : null };
    }
    if (method === "cron.scratch.get") {
      if (options.failScratch === "get") throw new Error("scratch read failed");
      const content = scratch.get(String(params.id));
      return { scratch: content === undefined ? null : { content, revision: 1 } };
    }
    if (method === "cron.scratch.set") {
      if (options.failScratch === "set") return { ok: false, reason: "revision-conflict" };
      scratch.set(String(params.id), String(params.content));
      return { ok: true };
    }
    if (method === "cron.update") {
      const job = store.find(job => job.id === params.id)!;
      Object.assign(job, params.patch);
      return job;
    }
    if (method === "cron.remove") {
      const id = params.id as string;
      if (options.failRemove?.(id)) throw new Error(`remove ${id} refused`);
      const index = store.findIndex((job) => job.id === id);
      if (index === -1) return { ok: true, removed: false };
      scratch.delete(id);
      store.splice(index, 1);
      return { ok: true, removed: true };
    }
    if (method === "cron.add") {
      if (options.failAdd?.(params)) throw new Error(`add ${String(params.name)} refused`);
      const existing = store.find(job => job.agentId === params.agentId && job.declarationKey === params.declarationKey);
      if (existing) return { created: false, job: structuredClone(existing) };
      const job = { ...params, id: `new-${nextId++}`, effectiveAgentId: params.agentId, state: {} };
      store.push(job);
      return { created: true, job: structuredClone(job) };
    }
    throw new Error(`unexpected ${method}`);
  });
  return { call, store, scratch };
}

describe("schedule snapshot", () => {
  it("records only the customer's agents' jobs and leaves every other job running", async () => {
    const gateway = fakeGateway([
      listedJob("a1"),
      listedJob("p1", { agentId: ALICE_PROJECT, effectiveAgentId: ALICE_PROJECT }),
      listedJob("b1", { agentId: "octogee-bob-coach", effectiveAgentId: "octogee-bob-coach" }),
      listedJob("main1", { agentId: undefined, effectiveAgentId: "main" }),
    ]);

    const result = await snapshotSchedules(gateway.call, ALICE_AGENTS, vi.fn());

    expect(result.records.map((record) => [record.sourceJobId, record.agentId])).toEqual([["a1", ALICE], ["p1", ALICE_PROJECT]]);
    expect(gateway.store.map((job) => [job.id, job.enabled])).toEqual([["a1", false], ["p1", false], ["b1", true], ["main1", true]]);
  });

  it("fences each job before reading its scratch, records its own enabled state, and removes nothing", async () => {
    const gateway = fakeGateway([listedJob("a1"), listedJob("off", { enabled: false })], { scratch: { a1: "checkpoint" } });

    const result = await snapshotSchedules(gateway.call, ALICE_AGENTS, vi.fn());

    expect(result.records.map(record => [record.sourceJobId, record.job.enabled, record.scratch])).toEqual([["a1", true, "checkpoint"], ["off", false, null]]);
    const calls = gateway.call.mock.calls.map(([method, params]) => `${method}:${String(params.id ?? "")}`);
    expect(calls.indexOf("cron.update:a1")).toBeLessThan(calls.indexOf("cron.scratch.get:a1"));
    expect(calls).not.toContain("cron.update:off");
    expect(calls.some(call => call.startsWith("cron.remove"))).toBe(false);
    expect(gateway.store.map(job => job.enabled)).toEqual([false, false]);
  });

  it("waits for a run that started before the fence to finish before reading scratch", async () => {
    const gateway = fakeGateway([listedJob("a1", { runningAtMs: 5 })], { scratch: { a1: "before" } });
    let lists = 0;
    const call = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "cron.list" && ++lists === 3) {
        delete gateway.store[0].runningAtMs;
        gateway.scratch.set("a1", "after");
      }
      return gateway.call(method, params);
    });

    const [record] = (await snapshotSchedules(call, ALICE_AGENTS, vi.fn(), { waitMs: 1_000, pollMs: 0 })).records;

    expect(record.scratch).toBe("after");
  });

  it("reads scratch anyway and says so when a run outlasts the wait", async () => {
    const log = vi.fn();
    const gateway = fakeGateway([listedJob("a1", { runningAtMs: 5 })], { scratch: { a1: "mid-run" } });

    const [record] = (await snapshotSchedules(gateway.call, ALICE_AGENTS, log, { waitMs: 0, pollMs: 0 })).records;

    expect(record.scratch).toBe("mid-run");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("a1 still running"));
  });

  it("keeps only cron.add fields, pins the agent, and stays Firestore-safe", async () => {
    const gateway = fakeGateway([listedJob("a1", { description: undefined, pacing: { min: "1h" } })]);

    const [record] = (await snapshotSchedules(gateway.call, ALICE_AGENTS, vi.fn())).records;

    expect(record).toEqual({
      sourceJobId: "a1",
      scratch: null,
      agentId: ALICE,
      job: {
        name: "Brief a1",
        agentId: ALICE,
        sessionKey: `agent:${ALICE}:main`,
        enabled: true,
        schedule: { kind: "cron", expr: "0 8 * * 1-5", tz: "America/Chicago" },
        pacing: { min: "1h" },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "Morning brief", toolsAllow: ["message"] },
        delivery: { mode: "announce", channel: "mattermost", accountId: "alice-coach", to: "channel:abc" },
        owner: { agentId: ALICE, accountId: "alice-coach", sessionKey: `agent:${ALICE}:mattermost:channel:abc` },
        scheduledToolPolicy: { version: 1, mode: "account", ownerSessionKey: `agent:${ALICE}:mattermost:channel:abc`, ownerAccountId: "alice-coach" },
      },
    });
    expect(Object.hasOwn(record.job, "description")).toBe(false);
  });

  it("carries the job's account-scoped tool policy and authenticated creator so restore keeps its authority", async () => {
    const scheduledToolPolicy = { version: 1, mode: "account", ownerSessionKey: `agent:${ALICE}:mattermost:channel:abc`, ownerAccountId: "alice-coach" };
    const toolsAllowProvenance = { version: 1, source: "authenticated-requester",
      channelRequester: { version: 1, channel: "mattermost", accountId: "alice-coach", senderId: "mm-alice" } };
    const gateway = fakeGateway([listedJob("a1", { scheduledToolPolicy, toolsAllowProvenance })]);

    const [record] = (await snapshotSchedules(gateway.call, ALICE_AGENTS, vi.fn())).records;

    expect(record.job).toMatchObject({ scheduledToolPolicy, toolsAllowProvenance });
  });

  it("pins a default-agent job to the customer agent that runs it", async () => {
    const gateway = fakeGateway([listedJob("d1", { agentId: undefined, effectiveAgentId: ALICE })]);

    const [record] = (await snapshotSchedules(gateway.call, ALICE_AGENTS, vi.fn())).records;

    expect(record.agentId).toBe(ALICE);
    expect(record.job.agentId).toBe(ALICE);
  });

  it("carries the coach monitor with its own declaration key, since only first provisioning creates it", async () => {
    const key = `octogee:coach-monitor:${ALICE}`;
    const source = fakeGateway([listedJob("monitor", { name: `Proactive check (${ALICE})`, declarationKey: key })]);
    const { records, skipped } = await snapshotSchedules(source.call, ALICE_AGENTS, vi.fn());
    const target = fakeGateway([]);

    await expect(restoreSchedules(target.call, ALICE_AGENTS, records, vi.fn())).resolves.toEqual({ created: 1, existing: 0, failed: [] });
    await expect(restoreSchedules(target.call, ALICE_AGENTS, records, vi.fn())).resolves.toEqual({ created: 0, existing: 1, failed: [] });

    expect(skipped).toEqual([]);
    expect(target.store.map(job => [job.agentId, job.declarationKey])).toEqual([[ALICE, key]]);
  });

  it("carries an owner automation with its key and authenticated creator", async () => {
    const key = `octogee:owner-automation:${ALICE}:weekday-brief`;
    const ownerSessionKey = `agent:${ALICE}:mattermost:group:abc`;
    const toolsAllowProvenance = { version: 1, source: "authenticated-requester",
      callerOrigin: { kind: "external", channel: "mattermost" },
      channelRequester: { version: 1, channel: "mattermost", accountId: "alice-coach", senderId: "mm-alice" } };
    const source = fakeGateway([listedJob("brief", {
      declarationKey: key,
      scheduledToolPolicy: { version: 1, mode: "account", ownerSessionKey, ownerAccountId: "alice-coach" },
      toolsAllowProvenance,
    })]);
    const { records, skipped } = await snapshotSchedules(source.call, ALICE_AGENTS, vi.fn());
    const target = fakeGateway([]);

    await expect(restoreSchedules(target.call, ALICE_AGENTS, records, vi.fn())).resolves.toEqual({ created: 1, existing: 0, failed: [] });

    expect(skipped).toEqual([]);
    expect(target.call).toHaveBeenCalledWith("cron.add", expect.objectContaining({ declarationKey: key, toolsAllowProvenance }));
  });

  it("skips jobs that cannot move safely and leaves them running", async () => {
    const unsafe = [
      listedJob("declared", { declarationKey: "memory-core:memory-dreaming-promotion" }),
      listedJob("plugin", { payloadSource: { kind: "pluginCommand", pluginId: "p", command: "c" } }),
      listedJob("stream", { schedule: { kind: "stream", command: ["tail", "-f", "log"] }, streamExecutionHost: "gateway" }),
      listedJob("on-exit", { schedule: { kind: "on-exit", command: "make build" } }),
      listedJob("command", { payload: { kind: "command", argv: ["ls"] } }),
      listedJob("script", { payload: { kind: "script", script: "echo hi" } }),
      listedJob("dormant", { payload: { kind: "systemEvent", text: "check" } }),
    ];
    const gateway = fakeGateway([...unsafe, listedJob("a1")]);

    const result = await snapshotSchedules(gateway.call, ALICE_AGENTS, vi.fn());

    expect(result.records.map((record) => record.sourceJobId)).toEqual(["a1"]);
    expect(result.skipped.map((skip) => skip.jobId)).toEqual(unsafe.map((job) => job.id));
    expect(result.skipped.every((skip) => skip.name.startsWith("Brief ") && skip.reason.length > 0)).toBe(true);
    expect(gateway.store.filter(job => job.enabled).map((job) => job.id)).toEqual(unsafe.map((job) => job.id));
  });

  it("reads every page before fencing anything", async () => {
    const gateway = fakeGateway(["a1", "a2", "a3", "a4", "a5"].map((id) => listedJob(id)), { pageSize: 2 });

    const result = await snapshotSchedules(gateway.call, ALICE_AGENTS, vi.fn());

    expect(result.records).toHaveLength(5);
    const methods = gateway.call.mock.calls.map(([method]) => method);
    expect(methods.indexOf("cron.update")).toBe(3);
  });

  it("fails when cron.list does not answer with a page of jobs", async () => {
    const call = vi.fn(async () => ({ total: 1 }));

    await expect(snapshotSchedules(call, ALICE_AGENTS, vi.fn())).rejects.toThrow("cron.list");
  });
});

describe("schedule restore", () => {
  async function snapshotOf(jobs: Job[]): Promise<ScheduleRecord[]> {
    return (await snapshotSchedules(fakeGateway(jobs).call, ALICE_AGENTS, vi.fn())).records;
  }

  it("creates each missing job with plain cron.add", async () => {
    const records = await snapshotOf([listedJob("a1"), listedJob("p1", { agentId: ALICE_PROJECT, effectiveAgentId: ALICE_PROJECT })]);
    const target = fakeGateway([]);

    await expect(restoreSchedules(target.call, ALICE_AGENTS, records, vi.fn())).resolves.toEqual({ created: 2, existing: 0, failed: [] });
    expect(target.call).toHaveBeenCalledWith("cron.add", { ...records[0].job, declarationKey: expect.stringMatching(/^octogee:transfer:/) });
    expect(target.store.map((job) => [job.agentId, job.name])).toEqual([[ALICE, "Brief a1"], [ALICE_PROJECT, "Brief p1"]]);
  });

  it("does not merge distinct jobs with the same agent, name and schedule", async () => {
    const records = await snapshotOf([listedJob("a1"), listedJob("a2", {
      name: "Brief a1", payload: { kind: "agentTurn", message: "A different brief", toolsAllow: ["message"] },
    })]);
    const target = fakeGateway([listedJob("unrelated", { name: "Brief a1" })]);
    await expect(restoreSchedules(target.call, ALICE_AGENTS, records, vi.fn())).resolves.toEqual({ created: 2, existing: 0, failed: [] });
    expect(target.store).toHaveLength(3);
  });

  it("recognizes a source job left behind when rolling back", async () => {
    const [record] = await snapshotOf([listedJob("a1")]);
    const source = fakeGateway([listedJob("a1")]);
    await expect(restoreSchedules(source.call, ALICE_AGENTS, [record], vi.fn())).resolves.toEqual({ created: 0, existing: 1, failed: [] });
  });

  it.each(["", "Last checked invoice 42"])("moves scratch before enabling the recreated job: %j", async content => {
    const source = fakeGateway([listedJob("a1")], { scratch: { a1: content } });
    const { records } = await snapshotSchedules(source.call, ALICE_AGENTS, vi.fn());
    const target = fakeGateway([]);
    expect(records[0].scratch).toBe(content);
    await restoreSchedules(target.call, ALICE_AGENTS, records, vi.fn());
    expect(target.scratch.get("new-1")).toBe(content);
    expect(target.call.mock.calls.map(([method]) => method)).toEqual(["cron.list", "cron.add", "cron.scratch.set", "cron.update"]);
    expect(target.call).toHaveBeenCalledWith("cron.add", expect.objectContaining({ enabled: false }));
    expect(target.store[0].enabled).toBe(true);
  });

  it("lifts the fence and leaves a job running on the source when its scratch cannot be read", async () => {
    const source = fakeGateway([listedJob("a1")], { failScratch: "get" });
    expect(await snapshotSchedules(source.call, ALICE_AGENTS, vi.fn())).toMatchObject({
      records: [], skipped: [{ jobId: "a1", reason: "scratch read failed" }],
    });
    expect(source.store.map(job => [job.id, job.enabled])).toEqual([["a1", true]]);
  });

  it("re-enables a fenced source job when rolling back instead of recreating it", async () => {
    const source = fakeGateway([listedJob("a1")]);
    const { records } = await snapshotSchedules(source.call, ALICE_AGENTS, vi.fn());

    await expect(restoreSchedules(source.call, ALICE_AGENTS, records, vi.fn())).resolves.toEqual({ created: 0, existing: 1, failed: [] });
    expect(source.store.map(job => [job.id, job.enabled])).toEqual([["a1", true]]);
    expect(source.call.mock.calls.some(([method]) => method === "cron.add")).toBe(false);
  });

  it("sends cron.add only the fields it accepts, whatever the stored record carries", async () => {
    const [record] = await snapshotOf([listedJob("a1")]);
    const stored = { ...record, job: { ...record.job, id: "a1", state: { runningAtMs: 1 }, createdAtMs: 1, configRevision: "rev" } };
    const target = fakeGateway([]);

    await restoreSchedules(target.call, ALICE_AGENTS, [stored], vi.fn());

    const added = target.call.mock.calls.find(([method]) => method === "cron.add")![1];
    expect(added).toEqual({ ...record.job, declarationKey: expect.stringMatching(/^octogee:transfer:/) });
  });

  it("reports scratch failure and leaves that job disabled while restoring the rest", async () => {
    const records = await snapshotOf([listedJob("a1"), listedJob("a2")]);
    records[0].scratch = "checkpoint";
    const target = fakeGateway([], { failScratch: "set" });
    expect(await restoreSchedules(target.call, ALICE_AGENTS, records, vi.fn())).toMatchObject({ created: 1, failed: [{ name: "Brief a1" }] });
    expect(target.store.map(job => job.enabled)).toEqual([false, true]);
    expect(await restoreSchedules(target.call, ALICE_AGENTS, records, vi.fn())).toMatchObject({
      created: 0, existing: 1, failed: [{ name: "Brief a1" }],
    });
  });

  it("keeps disabled jobs disabled after restoring scratch", async () => {
    const records = await snapshotOf([listedJob("a1", { enabled: false })]);
    records[0].scratch = "checkpoint";
    const target = fakeGateway([]);
    await restoreSchedules(target.call, ALICE_AGENTS, records, vi.fn());
    expect(target.store[0].enabled).toBe(false);
    expect(target.call.mock.calls.some(([method]) => method === "cron.update")).toBe(false);
  });

  it("preserves transfer identity and scratch through a second move", async () => {
    const records = await snapshotOf([listedJob("a1")]);
    records[0].scratch = "checkpoint";
    const middle = fakeGateway([]);
    await restoreSchedules(middle.call, ALICE_AGENTS, records, vi.fn());
    const key = middle.store[0].declarationKey;
    const moved = await snapshotSchedules(middle.call, ALICE_AGENTS, vi.fn());
    const target = fakeGateway([]);
    await restoreSchedules(target.call, ALICE_AGENTS, moved.records, vi.fn());
    expect(moved.skipped).toEqual([]);
    expect(target.store[0].declarationKey).toBe(key);
    expect(target.scratch.get("new-1")).toBe("checkpoint");
  });

  it("treats the same name on another schedule or agent as a different job", async () => {
    const [record] = await snapshotOf([listedJob("a1")]);
    const target = fakeGateway([
      listedJob("other-time", { name: "Brief a1", schedule: { kind: "cron", expr: "0 9 * * 1-5", tz: "America/Chicago" } }),
      listedJob("other-agent", { name: "Brief a1", agentId: ALICE_PROJECT, effectiveAgentId: ALICE_PROJECT }),
    ]);

    await expect(restoreSchedules(target.call, ALICE_AGENTS, [record], vi.fn())).resolves.toMatchObject({ created: 1, existing: 0 });
  });

  it("collects per-record failures and keeps restoring the rest", async () => {
    const log = vi.fn();
    const records = await snapshotOf([listedJob("a1"), listedJob("a2"), listedJob("a3")]);
    const target = fakeGateway([], { failAdd: (job) => job.name === "Brief a2" });

    await expect(restoreSchedules(target.call, ALICE_AGENTS, records, log)).resolves.toEqual({
      created: 2,
      existing: 0,
      failed: [{ name: "Brief a2", error: "add Brief a2 refused" }],
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("add Brief a2 refused"));
  });

  it("refuses a record for an agent the customer does not own here", async () => {
    const [record] = await snapshotOf([listedJob("a1")]);
    const forged = { ...record, agentId: "octogee-bob-coach", job: { ...record.job, agentId: "octogee-bob-coach" } };
    const target = fakeGateway([]);

    const result = await restoreSchedules(target.call, ALICE_AGENTS, [forged], vi.fn());

    expect(result).toMatchObject({ created: 0, existing: 0, failed: [{ name: "Brief a1" }] });
    expect(target.store).toEqual([]);
  });

  it("runs the job as the record's agent even if the job body names another", async () => {
    const [record] = await snapshotOf([listedJob("a1")]);
    const target = fakeGateway([]);

    await restoreSchedules(target.call, ALICE_AGENTS, [{ ...record, job: { ...record.job, agentId: "octogee-bob-coach" } }], vi.fn());

    expect(target.store.map((job) => job.agentId)).toEqual([ALICE]);
  });

  it("is idempotent: a second restore creates nothing", async () => {
    const records = await snapshotOf([listedJob("a1"), listedJob("a2")]);
    const target = fakeGateway([]);

    await restoreSchedules(target.call, ALICE_AGENTS, records, vi.fn());
    await expect(restoreSchedules(target.call, ALICE_AGENTS, records, vi.fn())).resolves.toEqual({ created: 0, existing: 2, failed: [] });
    expect(target.store).toHaveLength(2);
  });

  it("does not create a duplicate when the same record arrives twice in one restore", async () => {
    const [record] = await snapshotOf([listedJob("a1")]);
    record.scratch = "checkpoint";
    const target = fakeGateway([]);

    await expect(restoreSchedules(target.call, ALICE_AGENTS, [record, record], vi.fn())).resolves.toEqual({ created: 1, existing: 1, failed: [] });
  });
});

describe("schedule remove", () => {
  it("removes only this customer's jobs and counts a job already gone as removed", async () => {
    const gateway = fakeGateway([listedJob("a1"), listedJob("b1", { agentId: "octogee-bob-coach", effectiveAgentId: "octogee-bob-coach" })]);

    const result = await removeSchedules(gateway.call, ALICE_AGENTS, ["a1", "b1", "gone"], vi.fn());

    expect(result).toEqual({ removed: 2, failed: [{ jobId: "b1", error: "not this customer's job" }] });
    expect(gateway.store.map(job => job.id)).toEqual(["b1"]);
  });

  it("reports a job it could not remove and keeps going", async () => {
    const log = vi.fn();
    const gateway = fakeGateway([listedJob("a1"), listedJob("a2")], { failRemove: (id) => id === "a1" });

    const result = await removeSchedules(gateway.call, ALICE_AGENTS, ["a1", "a2"], log);

    expect(result).toEqual({ removed: 1, failed: [{ jobId: "a1", error: "remove a1 refused" }] });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("remove a1 refused"));
  });
});

describe("schedule transfer wiring", () => {
  function deps(jobs: Job[], config: unknown = { agents: { entries: { [ALICE]: {}, [ALICE_PROJECT]: {}, "octogee-bob-coach": {} } } }) {
    const gateway = fakeGateway(jobs);
    const close = vi.fn();
    return {
      gateway,
      close,
      deps: {
        readConfig: vi.fn(async () => config),
        localAgentIds: vi.fn(() => [ALICE]),
        connect: vi.fn(async () => ({ request: gateway.call, close })),
        log: vi.fn(),
      },
    };
  }

  it("snapshots the customer's local and rostered agents and answers with the transfer envelope", async () => {
    const { gateway, close, deps: transferDeps } = deps([
      listedJob("a1"),
      listedJob("p1", { agentId: ALICE_PROJECT, effectiveAgentId: ALICE_PROJECT }),
      listedJob("b1", { agentId: "octogee-bob-coach", effectiveAgentId: "octogee-bob-coach" }),
    ]);

    const result = await createScheduleTransfer(transferDeps)({ migrationId: "m1", slug: "alice", op: "snapshot" });

    expect(result).toMatchObject({ migrationId: "m1", slug: "alice", op: "snapshot", skipped: [] });
    expect(transferDeps.localAgentIds).toHaveBeenCalledWith("alice");
    expect(gateway.store.filter(job => job.enabled).map((job) => job.id)).toEqual(["b1"]);
    expect(close).toHaveBeenCalledOnce();

    await expect(createScheduleTransfer(transferDeps)({ migrationId: "m1", slug: "alice", op: "remove", jobIds: ["a1", "p1"] }))
      .resolves.toEqual({ migrationId: "m1", slug: "alice", op: "remove", removed: 2, failed: [] });
    expect(gateway.store.map((job) => job.id)).toEqual(["b1"]);
  });

  it("restores into the envelope and closes the gateway connection even when the gateway fails", async () => {
    const { close, deps: transferDeps } = deps([]);
    const records = (await snapshotSchedules(fakeGateway([listedJob("a1")]).call, ALICE_AGENTS, vi.fn())).records;

    await expect(createScheduleTransfer(transferDeps)({ migrationId: "m1", slug: "alice", op: "restore", records }))
      .resolves.toEqual({ migrationId: "m1", slug: "alice", op: "restore", created: 1, existing: 0, failed: [] });

    transferDeps.connect.mockResolvedValueOnce({ request: vi.fn(async () => { throw new Error("gateway down"); }), close });
    await expect(createScheduleTransfer(transferDeps)({ migrationId: "m1", slug: "alice", op: "snapshot" })).rejects.toThrow("gateway down");
    expect(close).toHaveBeenCalledTimes(2);
  });
});
