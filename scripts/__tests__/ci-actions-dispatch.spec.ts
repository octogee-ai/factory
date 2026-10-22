import { expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { awaitRun, dispatchWorkflow, findRunningRun } from "../ci/actions-dispatch.mjs";

const url = (id: number) => `https://github.com/octogee-ai/octogee/actions/runs/${id}`;

it("finds the active build when GitHub's run metadata exceeds one MiB", () => {
  const directory = mkdtempSync(join(tmpdir(), "octogee-actions-response-"));
  const sha = "a".repeat(40);
  try {
    writeFileSync(join(directory, "gh"), `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({
      workflow_runs: [{ id: 9, status: "in_progress", display_title: "Build main ${sha} [4]" }],
      metadata: "x".repeat(2 * 1024 * 1024),
    }));\n`, { mode: 0o700 });
    const moduleUrl = new URL("../ci/actions-dispatch.mjs", import.meta.url).href;
    const output = execFileSync(process.execPath, ["--input-type=module", "-e",
      `import { findRunningRun } from ${JSON.stringify(moduleUrl)};
       console.log(await findRunningRun("build-main.yml", ${JSON.stringify(sha)}));`,
    ], { encoding: "utf8", env: { ...process.env, PATH: `${directory}:${process.env.PATH}` }, stdio: ["ignore", "pipe", "pipe"] });
    expect(output.trim()).toBe("9");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
function github({ runs = [] as Array<Record<string, unknown>>, conclusion = "success", jobs = [{ name: "build", conclusion: "success" }] } = {}) {
  return vi.fn(async (method: string, endpoint: string) => {
    if (method === "POST") return undefined;
    if (endpoint.endsWith("/jobs?per_page=100")) return { jobs };
    const run = /actions\/runs\/(\d+)$/.exec(endpoint);
    if (run) return { id: Number(run[1]), name: "Build main", html_url: url(Number(run[1])), conclusion };
    return { workflow_runs: runs };
  });
}

it("waits for the exact dispatched request rather than another run of the same SHA", async () => {
  const request = github();
  request
    .mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce({ workflow_runs: [{ id: 1, display_title: `Build main ${"a".repeat(40)} [someone-else]` }] })
    .mockResolvedValueOnce({ workflow_runs: [{ id: 2, display_title: `Build main ${"a".repeat(40)} [request-123]` }] });
  const watch = vi.fn();
  const sleep = vi.fn();
  await expect(dispatchWorkflow("build-main.yml", { source_sha: "a".repeat(40) }, {
    request, watch, sleep, id: () => "request-123", now: () => 0,
  })).resolves.toBe(2);
  expect(request.mock.calls[0]).toEqual([
    "POST", "repos/octogee-ai/octogee/actions/workflows/build-main.yml/dispatches",
    { ref: "main", inputs: { source_sha: "a".repeat(40), request_id: "request-123" } },
  ]);
  expect(sleep).toHaveBeenCalledOnce();
  expect(watch).toHaveBeenCalledWith(2);
});

it("names the run URL and conclusion when a dispatched workflow fails", async () => {
  const request = github({ runs: [{ id: 3, display_title: "Deploy platform [request-123]" }], conclusion: "failure", jobs: [{ name: "deploy", conclusion: "failure" }] });
  await expect(dispatchWorkflow("deploy.yml", {}, {
    request, watch: async () => {}, id: () => "request-123",
  })).rejects.toThrow(`Deploy platform run ${url(3)} concluded failure (deploy: failure)`);
});

it("reports a run whose jobs were skipped instead of treating it as completed work", async () => {
  const request = github({ runs: [{ id: 4, display_title: "Ship TEST [request-123]" }], jobs: [{ name: "build", conclusion: "success" }, { name: "deploy", conclusion: "skipped" }] });
  await expect(dispatchWorkflow("ship-test.yml", {}, {
    request, watch: async () => {}, id: () => "request-123",
  })).rejects.toThrow(`Ship TEST run ${url(4)} concluded skipped (deploy: skipped)`);
});

it("reports the conclusion even when the watcher exits nonzero", async () => {
  const request = github({ conclusion: "cancelled", jobs: [{ name: "build", conclusion: "cancelled" }] });
  await expect(awaitRun(5, { request, watch: async () => { throw new Error("exit 1"); } }))
    .resolves.toMatchObject({ id: 5, url: url(5), conclusion: "cancelled" });
});

it("rejects unknown workflows before sending a request", async () => {
  const request = vi.fn();
  await expect(dispatchWorkflow("../untrusted.yml", {}, { request })).rejects.toThrow("Unknown workflow");
  expect(request).not.toHaveBeenCalled();
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

it("prefers a running main build and waits for the selected SHA when pending", async () => {
  const sha = "a".repeat(40);
  const request = github({ runs: [
    { id: 6, status: "completed", display_title: `Build main ${sha} [1]` },
    { id: 7, status: "in_progress", display_title: `Build main ${"b".repeat(40)} [2]` },
    { id: 8, status: "pending", display_title: `Build main ${sha} [3]` },
    { id: 9, status: "in_progress", display_title: `Build main ${sha} [4]` },
  ] });
  await expect(findRunningRun("build-main.yml", sha, { request })).resolves.toBe(9);
  await expect(findRunningRun("build-main.yml", sha, { request: github({ runs: [{ id: 8, status: "pending", display_title: `Build main ${sha} [3]` }] }) })).resolves.toBe(8);
  expect(request).toHaveBeenCalledWith("GET", "repos/octogee-ai/octogee/actions/workflows/build-main.yml/runs?per_page=100");
  await expect(findRunningRun("build-main.yml", "c".repeat(40), { request })).resolves.toBeNull();
});


it.each(["pending", "queued", "waiting", "requested"])("reuses a %s build instead of dispatching a competing build", async status => {
  const sha = "d".repeat(40);
  await expect(findRunningRun("build-main.yml", sha, { request: github({ runs: [
    { id: 10, status, display_title: `Build main ${sha} [automatic]` },
  ] }) })).resolves.toBe(10);
});
