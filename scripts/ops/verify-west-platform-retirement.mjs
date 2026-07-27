#!/usr/bin/env node

import { pathToFileURL } from "node:url";

const RETIREMENT_GLOBAL_DESTROY_ALLOWLIST = new Set([
  "google_compute_global_address.private_services",
  'google_compute_global_address.west_ingress["gitea-ip-west"]',
  'google_compute_global_address.west_ingress["mattermost-ip-west"]',
  'google_compute_global_address.west_ingress["preview-ip-west"]',
  'google_compute_global_address.west_ingress["workspace-api-ip-test-west"]',
  'google_compute_global_address.west_ingress["workspace-api-ip-west"]',
]);

const isDestructive = (actions) => Array.isArray(actions) && actions.includes("delete");

export const verifyWestPlatformRetirementPlan = ({ retirementEnabled, changes }) => {
  const destructiveChanges = (changes ?? []).filter(({ actions }) => isDestructive(actions));
  if (destructiveChanges.length === 0) return "unchanged";
  if (retirementEnabled !== true) {
    throw new Error("WEST retirement plan contains destructive actions while retirement mode is not enabled");
  }

  for (const { address } of destructiveChanges) {
    if (address === "google_compute_global_address.monitoring_grafana" || address.includes("grafana-ip")) {
      throw new Error("WEST retirement destroy allowlist excludes the Central-owned grafana-ip");
    }
    if (address.startsWith("google_compute_global_address.") && !RETIREMENT_GLOBAL_DESTROY_ALLOWLIST.has(address)) {
      throw new Error(`WEST retirement plan contains an unapproved global-address deletion: ${address}`);
    }
  }
  return "retirement";
};

const readStandardInput = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
};

const run = async () => {
  const [mode, ...extra] = process.argv.slice(2);
  if (extra.length > 0 || (mode !== "--normal" && mode !== "--retirement")) {
    throw new Error("Usage: verify-west-platform-retirement.mjs --normal|--retirement");
  }
  const plan = JSON.parse(await readStandardInput());
  const changes = (plan.resource_changes ?? []).map(({ address, change }) => ({
    address,
    actions: change?.actions ?? [],
  }));
  process.stdout.write(`${verifyWestPlatformRetirementPlan({
    retirementEnabled: mode === "--retirement",
    changes,
  })}\n`);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
