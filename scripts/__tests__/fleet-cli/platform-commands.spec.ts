import { describe, expect, it } from "vitest";
import { describeFleet, fleet, mutations } from "./harness.js";

describeFleet("platform reads", () => {
  it("lists journal operations, filtered by status and capped by --limit", async () => {
    const run = await fleet(["ops", "ls", "--status=running", "--limit=20"]);
    expect(run.exitCode).toBe(0);
    expect(mutations(run)).toEqual([]);
    expect(run.requests).toContainEqual({ method: "GET", path: "/api/admin/operations", query: { status: "running", limit: "20" } });
  });

  it("lists builds, filtered by service and capped by --limit", async () => {
    const run = await fleet(["builds", "ls", "--service=gateway", "--limit=5"]);
    expect(run.exitCode).toBe(0);
    expect(mutations(run)).toEqual([]);
    expect(run.requests).toContainEqual({ method: "GET", path: "/api/admin/builds", query: { service: "gateway", limit: "5" } });
  });

  it("shows the shared-gateway placement pool with read requests only", async () => {
    const run = await fleet(["pool", "show"]);
    expect(run.exitCode).toBe(0);
    expect(mutations(run)).toEqual([]);
    expect(run.requests).toContainEqual({ method: "GET", path: "/api/admin/placement" });
  });

  it("shows release convergence across the fleet with read requests only", async () => {
    const run = await fleet(["release", "status"]);
    expect(run.exitCode).toBe(0);
    expect(mutations(run)).toEqual([]);
  });

  it("refuses a non-numeric --limit and sends nothing", async () => {
    const run = await fleet(["ops", "ls", "--limit=all"]);
    expect(run.exitCode).not.toBe(0);
    expect(run.requests).toEqual([]);
  });
});

describe("platform commands still to specify", () => {
  it.todo("pool autoscaling sets the shared-gateway pool's minimum and maximum through one journaled request");
  it.todo("image publish --sha=<sha> publishes the tested VM image from that build's immutable manifest");
  it.todo("logs tails shared-gateway and VM-gateway logs together, filtered by --level, --service, --user and --migration");
  it.todo("audit decodes every platform-state record read-only and exits 1 when any record is malformed, duplicated, dangling or not a runtime record");
});
