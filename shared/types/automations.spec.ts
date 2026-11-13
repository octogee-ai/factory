import { describe, expect, it } from "vitest";

import {
  hasAutomationReadClientDeadline,
} from "./automations.js";

describe("automation request deadlines", () => {
  it("only classifies known idempotent reads for a retryable browser deadline", () => {
    expect([
      "cron.list",
      "cron.runs",
      "automations.context",
      "cron.get",
      "cron.status",
    ].every(hasAutomationReadClientDeadline)).toBe(true);
    expect([
      "cron.add",
      "cron.update",
      "cron.run",
      "heartbeat.get",
      "heartbeat.update",
      "cron.remove",
      "future.write",
    ].some(hasAutomationReadClientDeadline)).toBe(false);
  });
});
