import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { retryTransient } from "./transient-retry.mjs";

const githubExecutable = () => execFileSync("/usr/bin/which", ["gh"], { encoding: "utf8" }).trim();

const repository = "octogee-ai/octogee";
const names = { "build-main.yml": "Build main", "deploy.yml": "Deploy platform", "ship-test.yml": "Ship TEST" };
const execGh = (args, input) => execFileSync(githubExecutable(), args, {
  encoding: "utf8", maxBuffer: 16 * 1024 * 1024, ...(input === undefined ? {} : { input }),
});
const GITHUB_TRANSIENT_STATUS = /\(HTTP (429|500|502|503|504)\)/;
const GITHUB_TRANSIENT_CONNECTION = /i\/o timeout|connection reset by peer|connection refused|TLS handshake timeout|unexpected EOF|network is unreachable|temporary failure in name resolution/i;

export function githubTransientFailure(error) {
  const stderr = String(error?.stderr ?? "");
  const status = GITHUB_TRANSIENT_STATUS.exec(stderr);
  if (status) return `HTTP ${status[1]}`;
  return GITHUB_TRANSIENT_CONNECTION.exec(stderr)?.[0] ?? null;
}

export async function githubApi(method, endpoint, body, { exec = execGh, ...retry } = {}) {
  const args = ["api", "--method", method, endpoint];
  if (body) args.push("--input", "-");
  const call = () => {
    const output = exec(args, body ? JSON.stringify(body) : undefined).trim();
    return output ? JSON.parse(output) : undefined;
  };
  if (method !== "GET") return call();
  return retryTransient(`gh api GET ${endpoint}`, call, { transientError: githubTransientFailure, ...retry });
}
const api = (method, endpoint, body) => githubApi(method, endpoint, body);
const watchRun = run => new Promise((resolve, reject) => {
  const child = spawn(githubExecutable(), ["run", "watch", String(run), "--repo", repository], { stdio: "inherit" });
  child.once("error", reject);
  child.once("close", (code, signal) => code === 0 ? resolve() : reject(new Error(`gh run watch exited with ${code ?? signal}`)));
});

async function reportWait(id, request, waited) {
  const minutes = `${Math.round(waited / 60_000)}m`;
  try {
    const run = await request("GET", `repos/${repository}/actions/runs/${id}`);
    const { jobs } = await request("GET", `repos/${repository}/actions/runs/${id}/jobs?per_page=100`);
    const job = jobs.find(job => job.status === "in_progress") ?? jobs.find(job => job.status !== "completed");
    const activity = job ? `running ${job.name}` : "no job running";
    console.log(`Waiting on ${run.name} run ${id} ${run.html_url}: ${run.status}, ${activity}, waited ${minutes}`);
  } catch (error) {
    console.warn(`Waiting on run ${id}: status unavailable (${error.message}), waited ${minutes}`);
  }
}

export async function awaitRun(id, { request = api, watch = watchRun, heartbeat = 60_000, now = Date.now } = {}) {
  const started = now();
  let reporting = false;
  const beat = setInterval(async () => {
    if (reporting) return;
    reporting = true;
    try { await reportWait(id, request, now() - started); } finally { reporting = false; }
  }, heartbeat);
  try { await watch(id); }
  catch (error) { console.error(`Watching run ${id} failed: ${error.message}; reading its conclusion`); }
  finally { clearInterval(beat); }
  const run = await request("GET", `repos/${repository}/actions/runs/${id}`);
  const { jobs } = await request("GET", `repos/${repository}/actions/runs/${id}/jobs?per_page=100`);
  const incomplete = jobs.filter(job => job.conclusion !== "success");
  return { id, url: run.html_url, conclusion: runConclusion(run, jobs, incomplete), name: run.name, jobs: incomplete.map(job => `${job.name}: ${job.conclusion}`) };
}

function runConclusion(run, jobs, incomplete) {
  if (run.conclusion !== "success") return run.conclusion ?? run.status;
  if (!jobs.length || incomplete.some(job => job.conclusion === "skipped")) return "skipped";
  return incomplete[0]?.conclusion ?? "success";
}

export async function findRunningRun(workflow, sha, { request = api } = {}) {
  if (!names[workflow]) throw new Error(`Unknown workflow: ${workflow}`);
  const result = await request("GET", `repos/${repository}/actions/workflows/${workflow}/runs?per_page=100`);
  const matching = result.workflow_runs.filter(run => run.display_title.startsWith(`${names[workflow]} ${sha} [`));
  const run = matching.find(run => run.status === "in_progress") ??
    matching.find(run => ["pending", "queued", "waiting", "requested"].includes(run.status));
  return run?.id ?? null;
}

export async function dispatchWorkflow(workflow, inputs, {
  request = api, watch = watchRun,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now, id = randomUUID,
} = {}) {
  if (!names[workflow]) throw new Error(`Unknown workflow: ${workflow}`);
  const requestId = id();
  const endpoint = `repos/${repository}/actions/workflows/${workflow}`;
  await request("POST", `${endpoint}/dispatches`, { ref: "main", inputs: { ...inputs, request_id: requestId } });
  const deadline = now() + 120_000;
  while (now() < deadline) {
    const result = await request("GET", `${endpoint}/runs?event=workflow_dispatch&branch=main&per_page=100`);
    const run = result.workflow_runs.find(run => run.display_title.startsWith(names[workflow]) && run.display_title.endsWith(` [${requestId}]`));
    if (run) {
      console.log(`Dispatched ${names[workflow]} run ${run.id} ${run.html_url} (request ${requestId})`);
      const finished = await awaitRun(run.id, { request, watch });
      if (finished.conclusion !== "success") {
        const jobs = finished.jobs.length ? ` (${finished.jobs.join(", ")})` : "";
        throw new Error(`${names[workflow]} run ${finished.url} concluded ${finished.conclusion}${jobs}`);
      }
      return run.id;
    }
    await sleep(3000);
  }
  throw new Error(`Dispatched ${workflow} request ${requestId} did not appear; inspect Actions before retrying`);
}
