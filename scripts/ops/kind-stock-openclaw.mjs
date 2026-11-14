#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { coachRoundTrip, kindDependencies, parseArgs, pinModel, placeOnSharedGateway, waitForUserMount } from "./kind-agent-round-trip.mjs";
import {
  POD_PROFILE,
  POD_SIZING_PROFILE,
  gatewayDiagnostics,
  isolatedDependencies,
  redactSecrets,
  waitForMigration,
  waitForWorkspaceIdentities,
} from "./kind-isolated-gateway.mjs";

const LEDGER_SQL = `SELECT event::text FROM platform.model_broker_usage_events
WHERE owner_key = :'owner' AND created_at >= :'since'::bigint ORDER BY created_at;
`;

export const STEPS = [
  { id: "placed", title: "A user is provisioned and mounted on a new shared gateway" },
  { id: "reply", title: "The user's agent replies on the shared gateway through the LLM broker" },
  { id: "migrate", title: "`user migrate --to-isolated` starts a migration to a new isolated gateway" },
  { id: "identities", title: "The isolated gateway marks its workspace identities ready" },
  { id: "mounted", title: "The user is mounted on the isolated gateway" },
  { id: "migrated", title: "The migration operation succeeds" },
];

export function parseStockArgs(argv) {
  const report = argv.find(arg => arg.startsWith("--report="));
  const options = parseArgs(argv.filter(arg => arg !== report));
  const file = report?.slice("--report=".length);
  if (report !== undefined && !file) throw new Error("--report needs a value");
  return { ...options, report: file ? resolve(file) : null };
}

export async function runSteps(steps, actions, log) {
  const results = [];
  let failed = false;
  for (const step of steps) {
    if (failed) {
      results.push({ ...step, status: "skipped" });
      continue;
    }
    const started = Date.now();
    try {
      const note = await actions[step.id]();
      results.push({ ...step, status: "passed", seconds: Math.round((Date.now() - started) / 1000), ...(note ? { note } : {}) });
    } catch (error) {
      failed = true;
      const detail = redactSecrets(error instanceof Error ? error.message : String(error));
      log(`${step.title}: failed: ${detail}`);
      results.push({ ...step, status: "failed", seconds: Math.round((Date.now() - started) / 1000), detail: detail.split("\n")[0] });
    }
  }
  return results;
}

export function stockActions(deps, options) {
  const state = { user: null, gatewayId: null, operationId: null };
  return {
    state,
    actions: {
      placed: async () => {
        pinModel(deps, options);
        state.user = await placeOnSharedGateway(deps, options);
        return `${options.user} on ${options.gateway}`;
      },
      reply: async () => {
        const { evidence } = await coachRoundTrip(deps, options,
          { sql: LEDGER_SQL, variables: { owner: state.user.id }, caller: "the user" });
        return `${evidence.calls} call(s) to ${evidence.provider}/${evidence.model}, ${evidence.totalTokens} tokens, $${evidence.costUsd.toFixed(6)}`;
      },
      migrate: async () => {
        deps.setSizingProfile(POD_SIZING_PROFILE, POD_PROFILE);
        const given = deps.fleet(["user", "migrate", options.user, `--to-isolated=${POD_SIZING_PROFILE}`, "--apply"]).response;
        if (typeof given?.gatewayId !== "string" || given.gatewayId === "") throw new Error("user migrate answered without a gateway id");
        if (typeof given?.operationId !== "string" || given.operationId === "") throw new Error("user migrate answered without an operation id");
        state.gatewayId = given.gatewayId;
        state.operationId = given.operationId;
        return `${state.gatewayId}, operation ${state.operationId}`;
      },
      identities: () => waitForWorkspaceIdentities(deps, state.gatewayId),
      mounted: () => waitForUserMount(deps, options, state.gatewayId),
      migrated: () => waitForMigration(deps, state.operationId, state.gatewayId),
    },
  };
}

export async function run(deps, options) {
  const { state, actions } = stockActions(deps, options);
  const results = await runSteps(STEPS, actions, deps.log);
  if (state.gatewayId && results.some(result => result.status === "failed")) {
    deps.log(gatewayDiagnostics(deps, state.gatewayId));
  }
  return results;
}

async function main() {
  const options = parseStockArgs(process.argv.slice(2));
  const base = await kindDependencies(options);
  let results;
  try {
    const deps = { ...isolatedDependencies(base, options), log: line => console.log(`[stock-openclaw] ${line}`) };
    results = await run(deps, options);
  } finally {
    base.close();
  }
  for (const result of results) console.log(`[stock-openclaw] ${result.status}: ${result.title}`);
  if (options.report) writeFileSync(options.report, JSON.stringify({ steps: results }, null, 2) + "\n");
  if (results.some(result => result.status !== "passed")) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`[stock-openclaw] ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
    process.exit(1);
  });
}
