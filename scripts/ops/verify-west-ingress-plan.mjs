#!/usr/bin/env node

import { isIPv4 } from "node:net";
import { pathToFileURL } from "node:url";

const INGRESS_NAMES = [
  "grafana-ip",
  "gitea-ip-west",
  "mattermost-ip-west",
  "preview-ip-west",
  "workspace-api-ip-test-west",
  "workspace-api-ip-west",
];
const RETIRED_INGRESS_NAMES = [
  "gitea-ip-test-west",
  "mattermost-ip-test-west",
  "preview-ip-test-west",
];

const EXPECTED_ADDRESSES = INGRESS_NAMES.map(
  (name) => `google_compute_global_address.west_ingress["${name}"]`,
);
const RETIRED_ADDRESSES = RETIRED_INGRESS_NAMES.map(
  (name) => `google_compute_global_address.west_ingress["${name}"]`,
);

const exactStrings = (actual, expected) =>
  actual.length === expected.length &&
  actual.every((value, index) => value === expected[index]);

const isPublicIPv4 = (value) => {
  if (!isIPv4(value)) return false;
  const [first, second] = value.split(".").map(Number);
  return !(
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    first >= 224
  );
};

export const verifyWestIngressPlan = (receipt) => {
  const changes = Array.isArray(receipt?.changes) ? receipt.changes : [];
  const summary = receipt?.summary;
  const unchanged =
    changes.length === 0 &&
    summary?.create === 0 &&
    summary?.update === 0 &&
    summary?.delete === 0 &&
    summary?.replace === 0;
  if (unchanged) return "unchanged";

  const createAddresses = [];
  const deleteAddresses = [];
  for (const change of changes) {
    if (
      typeof change?.address !== "string" ||
      !Array.isArray(change?.actions) ||
      change.actions.length !== 1
    ) {
      throw new Error("WEST ingress plan contains an undeclared address reconciliation");
    }
    if (change.actions[0] === "create") {
      createAddresses.push(change.address);
    } else if (change.actions[0] === "delete") {
      deleteAddresses.push(change.address);
    } else {
      throw new Error("WEST ingress plan contains an undeclared address reconciliation");
    }
  }

  const desiredAddressSet = new Set(EXPECTED_ADDRESSES);
  const retiredAddressSet = new Set(RETIRED_ADDRESSES);
  const createsDeclaredAddresses =
    createAddresses.length === new Set(createAddresses).size &&
    createAddresses.every((address) => desiredAddressSet.has(address));
  const deletesRetiredAddresses =
    deleteAddresses.length === new Set(deleteAddresses).size &&
    deleteAddresses.every((address) => retiredAddressSet.has(address));
  const summaryMatchesActions =
    summary?.create === createAddresses.length &&
    summary?.update === 0 &&
    summary?.delete === deleteAddresses.length &&
    summary?.replace === 0;

  if (
    createAddresses.length + deleteAddresses.length === 0 ||
    !createsDeclaredAddresses ||
    !deletesRetiredAddresses ||
    !summaryMatchesActions
  ) {
    throw new Error("WEST ingress plan contains an undeclared address reconciliation");
  }
  if (createAddresses.length > 0 && deleteAddresses.length > 0) return "reconcile";
  return createAddresses.length > 0 ? "create" : "retire";
};

export const verifyWestIngressAddresses = (outputs) => {
  if (typeof outputs !== "object" || outputs === null || Array.isArray(outputs)) {
    throw new Error(
      "WEST ingress Terraform output must contain six unique public IPv4 addresses",
    );
  }
  const names = Object.keys(outputs).sort();
  const addresses = Object.values(outputs);
  if (
    !exactStrings(names, [...INGRESS_NAMES].sort()) ||
    addresses.some((address) => typeof address !== "string" || !isPublicIPv4(address)) ||
    new Set(addresses).size !== INGRESS_NAMES.length
  ) {
    throw new Error(
      "WEST ingress Terraform output must contain six unique public IPv4 addresses",
    );
  }
  return outputs;
};

const readStandardInput = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
};

const run = async () => {
  const [mode, ...extra] = process.argv.slice(2);
  if (extra.length > 0 || (mode !== "--plan" && mode !== "--addresses")) {
    throw new Error("Usage: verify-west-ingress-plan.mjs --plan|--addresses");
  }
  const input = JSON.parse(await readStandardInput());
  if (mode === "--plan") {
    process.stdout.write(`${verifyWestIngressPlan(input)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(verifyWestIngressAddresses(input), null, 2)}\n`);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
