import { afterEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { awaitRun, dispatchWorkflow, findRunningRun, githubApi } from "../ci/actions-dispatch.mjs";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

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

const ghFailure = (stderr: string) => Object.assign(new Error("Command failed: gh api"), { status: 1, stderr });

it.each([
  "gh: Server Error (HTTP 502)", "gh: Service Unavailable (HTTP 503)", "gh: API rate limit exceeded (HTTP 429)",
  'Get "https://api.github.com/repos/x": dial tcp 140.82.112.6:443: i/o timeout',
  'Get "https://api.github.com/repos/x": read tcp 10.1.0.4:5000->140.82.112.6:443: read: connection reset by peer',
  "net/http: TLS handshake timeout",
])("retries a GitHub read that failed with %s", async stderr => {
  vi.useFakeTimers();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const exec = vi.fn().mockImplementationOnce(() => { throw ghFailure(stderr); }).mockReturnValueOnce('{"id":1}');
  const result = githubApi("GET", "repos/octogee-ai/octogee/actions/runs/1", undefined, { exec });
  await vi.runAllTimersAsync();
  await expect(result).resolves.toEqual({ id: 1 });
  expect(exec).toHaveBeenCalledTimes(2);
  expect(String(warn.mock.calls[0][0])).toMatch(/gh api GET repos\/octogee-ai\/octogee\/actions\/runs\/1: attempt 1 of 6 failed/);
});

it("throws the original GitHub failure after the bound", async () => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const original = ghFailure("gh: Bad Gateway (HTTP 502)");
  const exec = vi.fn(() => { throw original; });
  const result = githubApi("GET", "repos/octogee-ai/octogee/actions/runs/1", undefined, { exec }).catch(error => error);
  await vi.runAllTimersAsync();
  const error = await result;
  expect(error.message).toMatch(/failed after 6 attempts: HTTP 502/);
  expect(error.cause).toBe(original);
  expect(exec).toHaveBeenCalledTimes(6);
});

it.each(["gh: Not Found (HTTP 404)", "gh: Resource not accessible by integration (HTTP 403)"])("does not retry a GitHub read that failed with %s", async stderr => {
  const original = ghFailure(stderr);
  const exec = vi.fn(() => { throw original; });
  await expect(githubApi("GET", "repos/octogee-ai/octogee/actions/runs/1", undefined, { exec })).rejects.toBe(original);
  expect(exec).toHaveBeenCalledOnce();
});

it("never repeats a workflow dispatch", async () => {
  const original = ghFailure("gh: Server Error (HTTP 502)");
  const exec = vi.fn(() => { throw original; });
  await expect(githubApi("POST", "repos/octogee-ai/octogee/actions/workflows/build-main.yml/dispatches", { ref: "main" }, { exec })).rejects.toBe(original);
  expect(exec).toHaveBeenCalledOnce();
});

it("prints the run, its status, the running job and the elapsed wait once a minute", async () => {
  vi.useFakeTimers();
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  let finish = () => {};
  const watch = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const request = vi.fn(async (_method: string, endpoint: string) => endpoint.endsWith("/jobs?per_page=100")
    ? { jobs: [{ name: "Images", status: "completed", conclusion: "success" }, { name: "Desktop", status: "in_progress", conclusion: null }] }
    : { id: 11, name: "Build main", html_url: url(11), status: "in_progress", conclusion: null });
  const waiting = awaitRun(11, { request, watch });
  await vi.advanceTimersByTimeAsync(59_999);
  expect(log).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(log).toHaveBeenLastCalledWith(`Waiting on Build main run 11 ${url(11)}: in_progress, running Desktop, waited 1m`);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(log).toHaveBeenLastCalledWith(`Waiting on Build main run 11 ${url(11)}: in_progress, running Desktop, waited 2m`);
  expect(log).toHaveBeenCalledTimes(2);
  request.mockResolvedValue({ jobs: [{ name: "Images", status: "completed", conclusion: "success" }] } as never);
  request.mockResolvedValueOnce({ id: 11, name: "Build main", html_url: url(11), status: "completed", conclusion: "success" } as never);
  finish();
  await expect(waiting).resolves.toMatchObject({ conclusion: "success" });
  await vi.advanceTimersByTimeAsync(180_000);
  expect(log).toHaveBeenCalledTimes(2);
});

it("keeps waiting and says so when a heartbeat cannot read the run", async () => {
  vi.useFakeTimers();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  let finish = () => {};
  const request = vi.fn(async () => { throw new Error("gh exited 1"); });
  const waiting = awaitRun(12, { request, watch: () => new Promise<void>(resolve => { finish = resolve; }) });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(warn).toHaveBeenCalledWith("Waiting on run 12: status unavailable (gh exited 1), waited 1m");
  request.mockImplementation(github() as never);
  finish();
  await expect(waiting).resolves.toMatchObject({ id: 12 });
});

it("names the run it dispatched", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const request = github({ runs: [{ id: 13, html_url: url(13), display_title: "Build main [request-123]" }] });
  await dispatchWorkflow("build-main.yml", {}, { request, watch: async () => {}, id: () => "request-123" });
  expect(log).toHaveBeenCalledWith(`Dispatched Build main run 13 ${url(13)} (request request-123)`);
});
