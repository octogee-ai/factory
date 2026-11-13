#!/usr/bin/env tsx
import { readFile, mkdir, writeFile, appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { connectLoadClient, testTokens } from "../lib/gateway-load-client.js";
import { createLoadSampler } from "../lib/gateway-load-sampler.js";
import { parseLoadPlan, runLoadPlan, summarizeMeasurements, MAX_LOAD_RUN_MS, TEST_API_ORIGIN, type LoadMeasurement } from "../lib/gateway-load-test.js";

let phase = "plan validation";

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    plan: { type: "string" }, out: { type: "string" }, execute: { type: "boolean", default: false },
    "coach-turns": { type: "boolean", default: false },
  } });
  if (!values.plan) throw new Error("Usage: gateway-load-test.ts --plan=<json> [--out=<new-directory> --execute --coach-turns]");
  const plan = parseLoadPlan(JSON.parse(await readFile(values.plan, "utf8")));
  const turnCount = plan.defaultAgentConcurrency.reduce((a, b) => a + b, 0);
  console.log(JSON.stringify({ origin: TEST_API_ORIGIN, gatewayId: plan.gatewayId, targets: plan.targets.length,
    readConcurrency: plan.readConcurrency, readRounds: plan.readRounds, defaultAgentConcurrency: plan.defaultAgentConcurrency,
    defaultAgentTurns: turnCount, maxDefaultAgentTurns: plan.maxDefaultAgentTurns, execute: values.execute }));
  if (!values.execute) return;
  if (turnCount && !values["coach-turns"]) throw new Error("Agent stages post real TEST messages and incur model usage; add --coach-turns to execute them");
  if (!values.out) throw new Error("Execution requires --out=<new-directory>");
  phase = "TEST credential validation";
  const tokens = testTokens(plan.targets, process.env);
  const out = resolve(values.out);
  await mkdir(out, { mode: 0o700 });
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), MAX_LOAD_RUN_MS);
  const interrupt = () => controller.abort();
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  const rows: LoadMeasurement[] = [];
  const samples: Awaited<ReturnType<ReturnType<typeof createLoadSampler>>>[] = [];
  const sampler = createLoadSampler(plan.gatewayId);
  let telemetryFailure = false;
  let success = false;
  let loop: Promise<void> | undefined;
  try {
    phase = "Medium pod and telemetry preflight";
    const sample = async () => {
      const value = await sampler(); samples.push(value);
      await appendFile(resolve(out, "resources.jsonl"), `${JSON.stringify(value)}\n`, { mode: 0o600 });
      if (value.violations.length) throw new Error("Resource abort threshold exceeded");
    };
    await sample();
    loop = (async () => {
      while (!controller.signal.aborted) {
        try { await sleep(10_000, undefined, { signal: controller.signal }); }
        catch {
          if (controller.signal.aborted) return;
          throw new Error("Sampling delay failed");
        }
        try { await sample(); }
        catch { telemetryFailure = true; controller.abort(); return; }
      }
    })();
    phase = "staged load and resource sampling";
    await runLoadPlan(plan, {
      connect: (target, signal) => connectLoadClient({ target, gatewayId: plan.gatewayId, token: tokens.get(target.name)!, signal }),
      emit: (row) => { rows.push(row); console.log(JSON.stringify(row)); },
      sleep: async (ms, signal) => { await sleep(ms, undefined, { signal }); }, signal: controller.signal,
    });
    controller.abort(); await loop;
    if (telemetryFailure) throw new Error("Resource sampling failed");
    await sample();
    success = true;
  } finally {
    controller.abort(); clearTimeout(deadline); await loop;
    process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
    await writeFile(resolve(out, "requests.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n", { mode: 0o600 });
    await writeFile(resolve(out, "summary.json"), JSON.stringify({ success, telemetryFailure,
      completedAt: new Date().toISOString(), plannedDefaultAgentTurns: turnCount, measurements: summarizeMeasurements(rows),
      resourceSamples: samples.length }, null, 2) + "\n", { mode: 0o600 });
  }
}

void main().catch(() => {
  console.error(`Gateway load test failed during ${phase}. Check the plan, credentials, failed operation and resource samples; response bodies and credentials are not logged.`);
  process.exitCode = 1;
});
