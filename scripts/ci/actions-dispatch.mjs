import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const githubExecutable = () => execFileSync("/usr/bin/which", ["gh"], { encoding: "utf8" }).trim();

const repository = "octogee-ai/octogee";
const names = { "build-main.yml": "Build main", "deploy.yml": "Deploy platform", "ship-test.yml": "Ship TEST" };
const api = async (method, endpoint, body) => {
  const args = ["api", "--method", method, endpoint];
  if (body) args.push("--input", "-");
  const output = execFileSync(githubExecutable(), args, {
    encoding: "utf8", maxBuffer: 16 * 1024 * 1024, ...(body ? { input: JSON.stringify(body) } : {}),
  }).trim();
  return output ? JSON.parse(output) : undefined;
};
const watchRun = run => execFileSync(githubExecutable(), ["run", "watch", String(run), "--repo", repository], { stdio: "inherit" });

export async function awaitRun(id, { request = api, watch = watchRun } = {}) {
  try { await watch(id); }
  catch (error) { console.error(`Watching run ${id} failed: ${error.message}; reading its conclusion`); }
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
