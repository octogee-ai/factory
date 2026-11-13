import { describe, expect, it, vi } from "vitest";

const nightly = { metadata: { name: "nightly" }, spec: { suspend: false } };

async function freshModules() {
  vi.resetModules();
  return {
    writers: await import("../lib/platform-migration-writers.js"),
    quiescence: await import("../lib/platform-migration-writer-quiescence.js"),
  };
}

describe("platform migration writers", () => {
  it("declares no scheduled Function or CronJob writer until the composition root installs them", async () => {
    const { writers, quiescence } = await freshModules();
    expect(writers.platformMigrationWriters()).toEqual({ scheduledFunctions: [], cronJobs: [] });
    expect(quiescence.platformMigrationScheduledWriterNames("us-west1")).toEqual([]);
    expect(() => quiescence.selectPlatformMigrationCronJobs([nightly])).toThrow("unknown active Kubernetes CronJob: nightly");
  });

  it("quiesces the writers the composition root installs", async () => {
    const { writers, quiescence } = await freshModules();
    writers.installPlatformMigrationWriters({ scheduledFunctions: ["sweepSessions"], cronJobs: ["nightly"] });
    expect(quiescence.platformMigrationScheduledWriterNames("us-west1")).toEqual(["firebase-schedule-sweepSessions-us-west1"]);
    expect(quiescence.selectPlatformMigrationCronJobs([nightly])).toEqual([{ name: "nightly", suspended: false }]);
  });
});
