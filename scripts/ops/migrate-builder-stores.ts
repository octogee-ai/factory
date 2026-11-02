#!/usr/bin/env tsx
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { createSurgeOpenClawProcessSupervisorClient } from "../lib/surge-openclaw-process-gate.js";
import { openclawStateRoot } from "../lib/openclaw-state-store.js";

export async function migrateBuilderStores(args = process.argv.slice(2), env = process.env): Promise<void> {
  const { values } = parseArgs({ args, options: { "expected-pod-uid": { type: "string" }, apply: { type: "boolean", default: false }, resume: { type: "boolean", default: false } } });
  if (!values.apply || !values["expected-pod-uid"] || env.GATEWAY_CLASS !== "builder") {
    throw new Error("Run on the retained source Builder: migrate-builder-stores.ts --expected-pod-uid=<source UID> --apply");
  }
  const client = createSurgeOpenClawProcessSupervisorClient(openclawStateRoot(env));
  const held = await client.migrateBuilderStores(values["expected-pod-uid"]);
  const state = values.resume ? await client.permitNormal() : held;
  console.log(JSON.stringify({ gatewayId: env.GATEWAY_ID, podUid: state.podUid, mode: state.mode, phase: state.phase,
    next: values.resume ? "Migration complete; Builder resumed." : "Migration complete. Builder remains held; rerun with --resume to start it." }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  migrateBuilderStores().catch((error: unknown) => {
    console.error(`Builder store migration failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
