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


it("holds admission while an already-running scheduled job drains", async () => {
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
