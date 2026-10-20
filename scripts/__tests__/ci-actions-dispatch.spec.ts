import { expect, it, vi } from "vitest";
import { dispatchWorkflow } from "../ci/actions-dispatch.mjs";

it("waits for the exact dispatched request rather than another run of the same SHA", async () => {
  const request = vi.fn()
    .mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce({ workflow_runs: [{ id: 1, display_title: "Build main [someone-else]" }] })
    .mockResolvedValueOnce({ workflow_runs: [{ id: 2, display_title: "Build main [request-123]" }] })
    .mockResolvedValueOnce({ jobs: [{ conclusion: "success" }] });
  const watch = vi.fn();
  const sleep = vi.fn();
  await dispatchWorkflow("build-main.yml", { source_sha: "a".repeat(40) }, {
    request, watch, sleep, id: () => "request-123", now: () => 0,
  });
  expect(request.mock.calls[0]).toEqual([
    "POST", "repos/octogee-ai/octogee/actions/workflows/build-main.yml/dispatches",
    { ref: "main", inputs: { source_sha: "a".repeat(40), request_id: "request-123" } },
  ]);
  expect(sleep).toHaveBeenCalledOnce();
  expect(watch).toHaveBeenCalledWith(2);
});

it("propagates failed workflow execution", async () => {
  const request = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce({
    workflow_runs: [{ id: 3, display_title: "Deploy platform [request-123]" }],
  });
  await expect(dispatchWorkflow("deploy.yml", {}, {
    request, watch: async () => { throw new Error("failed"); }, id: () => "request-123",
  })).rejects.toThrow("failed");
});

it("rejects unknown workflows before sending a request", async () => {
  const request = vi.fn();
  await expect(dispatchWorkflow("../untrusted.yml", {}, { request })).rejects.toThrow("Unknown workflow");
  expect(request).not.toHaveBeenCalled();
});

it("does not report a disabled or skipped workflow as completed work", async () => {
  const request = vi.fn().mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce({ workflow_runs: [{ id: 4, display_title: "Build main [request-123]" }] })
    .mockResolvedValueOnce({ jobs: [{ conclusion: "skipped" }] });
  await expect(dispatchWorkflow("build-main.yml", {}, {
    request, watch: async () => {}, id: () => "request-123",
  })).rejects.toThrow("did not execute every required job");
});

it("times out without attaching to an unrelated workflow", async () => {
  let time = 0;
  const watch = vi.fn();
  await expect(dispatchWorkflow("build-main.yml", {}, {
    request: async () => ({ workflow_runs: [] }), watch,
    now: () => time, sleep: async () => { time += 300_000; },
  })).rejects.toThrow("did not appear");
  expect(watch).not.toHaveBeenCalled();
});
