import { describe, expect, it, vi } from "vitest";
import { assertCustomerHasNoScheduledJobs, migrateCustomerScheduler, setCustomerChannelsRunning } from "../lib/customer-channel-quiesce.js";

function runtime() {
  return {
    configGet: vi.fn(async () => ({ config: { channels: { mattermost: { accounts: {
      "alice-coach": {}, "alice-proj-app": {}, "alice2-coach": {}, "bob-coach": {},
    } } } } })),
    channelsStop: vi.fn(async () => ({ stopped: true })),
    channelsStart: vi.fn(async () => ({ started: true })),
  };
}

describe("customer migration channel admission", () => {
  it("stops only the migrating customer's coach and project accounts", async () => {
    const rpc = runtime();
    await setCustomerChannelsRunning(rpc as never, "alice", false);
    expect(rpc.channelsStop.mock.calls).toEqual([
      [{ channel: "mattermost", accountId: "alice-coach" }],
      [{ channel: "mattermost", accountId: "alice-proj-app" }],
    ]);
    expect(rpc.channelsStart).not.toHaveBeenCalled();
  });
  it("resumes the same accounts after rollback", async () => {
    const rpc = runtime();
    await setCustomerChannelsRunning(rpc as never, "alice", true);
    expect(rpc.channelsStart).toHaveBeenCalledTimes(2);
    expect(rpc.channelsStop).not.toHaveBeenCalled();
  });
  it("fails the migration when an account cannot stop", async () => {
    const rpc = runtime();
    rpc.channelsStop.mockRejectedValueOnce(new Error("stop failed"));
    await expect(setCustomerChannelsRunning(rpc as never, "alice", false)).rejects.toThrow("stop failed");
  });
});

describe("scheduled migration eligibility", () => {
  it("checks local and rostered customer agents without blocking on another customer's jobs", async () => {
    const rpc = { configGet: vi.fn(async () => ({ config: { agents: { entries: {
      "octogee-alice-coach": {}, "octogee-alice-proj-app-coach": {}, "octogee-bob-coach": {},
    } } } })), cronJobCount: vi.fn(async () => 0) };
    await assertCustomerHasNoScheduledJobs(rpc as never, "alice", ["octogee-alice-coach"]);
    expect(rpc.cronJobCount.mock.calls).toEqual([["octogee-alice-coach"], ["octogee-alice-proj-app-coach"]]);
  });
  it("fails closed if the scheduler cannot be inspected", async () => {
    const rpc = { configGet: vi.fn(async () => ({ config: {} })), cronJobCount: vi.fn(async () => { throw new Error("scheduler unavailable"); }) };
    await expect(assertCustomerHasNoScheduledJobs(rpc as never, "alice", ["octogee-alice-coach"]))
      .rejects.toThrow("scheduler unavailable");
  });
});


describe("scheduled migration handoff scope", () => {
  it("holds the exact union of local and roster agents for one builder", async () => {
    const rpc = {
      configGet: vi.fn(async () => ({ config: { agents: { entries: {
        "octogee-alice-coach": {}, "octogee-alice-proj-app-coach": {}, "octogee-alice2-coach": {},
      } } } })),
      schedulerMigration: vi.fn(async (request) => ({ ...request, drained: true })),
    };
    await migrateCustomerScheduler(rpc as never, "alice", ["octogee-alice-coach"], { operationId: "handoff-1", phase: "hold" });
    expect(rpc.schedulerMigration).toHaveBeenCalledWith({ operationId: "handoff-1", phase: "hold", agentIds: ["octogee-alice-coach", "octogee-alice-proj-app-coach"] });
  });
  it("recovers later phases using the durable runtime scope without loading a removed roster", async () => {
    const rpc = { configGet: vi.fn(), schedulerMigration: vi.fn(async (request) => ({ ...request, drained: true })) };
    await migrateCustomerScheduler(rpc as never, "alice", [], { operationId: "handoff-1", phase: "retire" });
    expect(rpc.configGet).not.toHaveBeenCalled();
    expect(rpc.schedulerMigration).toHaveBeenCalledWith({ operationId: "handoff-1", phase: "retire" });
  });
  it("refuses an empty hold scope", async () => {
    const rpc = { configGet: vi.fn(async () => ({ config: {} })), schedulerMigration: vi.fn() };
    await expect(migrateCustomerScheduler(rpc as never, "alice", [], { operationId: "handoff-1", phase: "hold" })).rejects.toThrow("no customer agents");
    expect(rpc.schedulerMigration).not.toHaveBeenCalled();
  });
});


it("resumes a fence a failed earlier attempt left held before holding for the new one", async () => {
  const rpc = {
    configGet: vi.fn(async () => ({ config: {} })),
    schedulerMigration: vi.fn()
      .mockRejectedValueOnce(new Error('/scheduler/shared-0: 500 {"error":"scheduler migration failed","message":"Cron agent octogee-alice-coach is held for migration mig-placement-190929cbf8f86906bee813bffa1a4157:scheduler:1"}'))
      .mockResolvedValueOnce({ operationId: "mig-placement-190929cbf8f86906bee813bffa1a4157:scheduler:1", phase: "resume", agentIds: ["octogee-alice-coach"], drained: true })
      .mockResolvedValueOnce({ operationId: "handoff-2", phase: "hold", agentIds: ["octogee-alice-coach"], drained: true }),
  };
  await expect(migrateCustomerScheduler(rpc as never, "alice", ["octogee-alice-coach"], { operationId: "handoff-2", phase: "hold" })).resolves.toMatchObject({ drained: true, operationId: "handoff-2" });
  expect(rpc.schedulerMigration.mock.calls.map(([request]) => request)).toEqual([
    { operationId: "handoff-2", phase: "hold", agentIds: ["octogee-alice-coach"] },
    { operationId: "mig-placement-190929cbf8f86906bee813bffa1a4157:scheduler:1", phase: "resume", agentIds: ["octogee-alice-coach"] },
    { operationId: "handoff-2", phase: "hold", agentIds: ["octogee-alice-coach"] },
  ]);
});

it("does not take over a fence the kernel refuses to resume, such as a staged handoff", async () => {
  const rpc = {
    configGet: vi.fn(async () => ({ config: {} })),
    schedulerMigration: vi.fn()
      .mockRejectedValueOnce(new Error("Cron agent octogee-alice-coach is held for migration other-op:scheduler:1"))
      .mockRejectedValueOnce(new Error("Cannot resume staged cron migration")),
  };
  await expect(migrateCustomerScheduler(rpc as never, "alice", ["octogee-alice-coach"], { operationId: "handoff-2", phase: "hold" }))
    .rejects.toThrow(/held for migration other-op:scheduler:1.*Cannot resume staged/su);
  expect(rpc.schedulerMigration).toHaveBeenCalledTimes(2);
});

it("keeps the old /scheduler contract for an older controller: hold drains before it answers", async () => {
  const rpc = {
    configGet: vi.fn(async () => ({ config: {} })),
    schedulerMigration: vi.fn()
      .mockResolvedValueOnce({ operationId: "handoff-1", phase: "hold", agentIds: ["octogee-alice-coach"], drained: false })
      .mockResolvedValueOnce({ operationId: "handoff-1", phase: "hold", agentIds: ["octogee-alice-coach"], drained: true }),
  };
  await expect(migrateCustomerScheduler(rpc as never, "alice", ["octogee-alice-coach"], { operationId: "handoff-1", phase: "hold" })).resolves.toMatchObject({ drained: true });
  expect(rpc.schedulerMigration).toHaveBeenCalledTimes(2);
  expect(rpc.schedulerMigration.mock.calls[0]).toEqual(rpc.schedulerMigration.mock.calls[1]);
});
