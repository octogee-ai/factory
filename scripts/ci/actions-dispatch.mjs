import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const repository = "octogee-ai/octogee";
const names = { "build-main.yml": "Build main", "deploy.yml": "Deploy platform", "ship-test.yml": "Ship TEST" };
const api = async (method, endpoint, body) => {
  const args = ["api", "--method", method, endpoint];
  if (body) args.push("--input", "-");
  const output = execFileSync("gh", args, {
    encoding: "utf8", ...(body ? { input: JSON.stringify(body) } : {}),
  }).trim();
  return output ? JSON.parse(output) : undefined;
};

export async function dispatchWorkflow(workflow, inputs, {
  request = api,
  watch = run => execFileSync("gh", ["run", "watch", String(run), "--repo", repository, "--exit-status"], { stdio: "inherit" }),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now, id = randomUUID,
} = {}) {
  if (!names[workflow]) throw new Error(`Unknown workflow: ${workflow}`);
  const requestId = id();
  const endpoint = `repos/${repository}/actions/workflows/${workflow}`;
  await request("POST", `${endpoint}/dispatches`, { ref: "main", inputs: { ...inputs, request_id: requestId } });
  const deadline = now() + 120_000;
  const title = `${names[workflow]} [${requestId}]`;
  while (now() < deadline) {
    const result = await request("GET", `${endpoint}/runs?event=workflow_dispatch&branch=main&per_page=100`);
    const run = result.workflow_runs.find(run => run.display_title === title);
    if (run) {
      await watch(run.id);
      const result = await request("GET", `repos/${repository}/actions/runs/${run.id}/jobs?per_page=100`);
      if (!result.jobs.length || result.jobs.some(job => job.conclusion !== "success")) {
        throw new Error(`Workflow ${run.id} did not execute every required job; check CI_ACTIONS_ENABLED and the run logs`);
      }
      return run.id;
    }
    await sleep(3000);
  }
  throw new Error(`Dispatched ${workflow} request ${requestId} did not appear; inspect Actions before retrying`);
}
