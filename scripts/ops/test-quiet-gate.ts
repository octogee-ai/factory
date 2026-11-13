#!/usr/bin/env tsx
import { execFile } from "node:child_process";
import { parseArgs } from "node:util";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { testKubectl } from "../lib/gateway-load-sampler.js";
import { busyReasons, quietSince, readSharedQuietSlots, type QuietSample } from "../lib/gateway-load-quiet.js";

const execute = promisify(execFile);
const REPO = "octogee-ai/octogee";
const DEPLOY_WORKFLOWS = ["ship-test.yml", "deploy.yml"];
const ACTIVE_RUN_STATUSES = new Set(["queued", "in_progress", "waiting", "requested", "pending"]);

async function deploysRunning(): Promise<number> {
  let running = 0;
  for (const workflow of DEPLOY_WORKFLOWS) {
    const { stdout } = await execute("gh", ["run", "list", "--repo", REPO, "--workflow", workflow, "--limit", "20", "--json", "status"], { timeout: 30_000 });
    running += (JSON.parse(stdout) as { status: string }[]).filter((run) => ACTIVE_RUN_STATUSES.has(run.status)).length;
  }
  return running;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    "max-cores": { type: "string", default: "0.35" },
    minutes: { type: "string", default: "10" },
    "timeout-minutes": { type: "string", default: "180" },
    "interval-seconds": { type: "string", default: "30" },
  } });
  const maxCores = Number(values["max-cores"]);
  const windowMs = Number(values.minutes) * 60_000;
  const deadline = Date.now() + Number(values["timeout-minutes"]) * 60_000;
  const intervalMs = Number(values["interval-seconds"]) * 1_000;
  if (![maxCores, windowMs, intervalMs].every((n) => Number.isFinite(n) && n > 0) || intervalMs < 10_000) {
    throw new Error("Usage: test-quiet-gate.ts [--max-cores=0.35] [--minutes=10] [--timeout-minutes=180] [--interval-seconds=30 (min 10)]");
  }
  let since: number | null = null;
  while (Date.now() < deadline) {
    let reasons: string[];
    try {
      const sample: QuietSample = { at: Date.now(), deploysRunning: await deploysRunning(), slots: await readSharedQuietSlots(testKubectl()) };
      reasons = busyReasons(sample, maxCores);
      since = quietSince(since, sample, maxCores);
      console.log(JSON.stringify({ at: new Date(sample.at).toISOString(), slots: sample.slots, deploysRunning: sample.deploysRunning, reasons,
        quietForSeconds: since === null ? 0 : Math.round((sample.at - since) / 1_000) }));
    } catch (error) {
      since = null;
      reasons = [`sampling failed: ${error instanceof Error ? error.message : String(error)}`];
      console.error(JSON.stringify({ at: new Date().toISOString(), reasons }));
    }
    if (since !== null && Date.now() - since >= windowMs) {
      console.log(`TEST quiet for ${values.minutes} minutes`);
      return;
    }
    await sleep(intervalMs);
  }
  throw new Error(`TEST did not stay quiet for ${values.minutes} minutes before the ${values["timeout-minutes"]}-minute timeout`);
}

void main().catch((error) => {
  console.error(`Quiet gate failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
