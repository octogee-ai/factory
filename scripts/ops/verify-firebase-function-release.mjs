#!/usr/bin/env node

import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const functionKey = (codebase, region, id) => `${codebase}:${region}:${id}`;

const requireString = (value, label) => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Firebase Functions inventory has invalid ${label}`);
  }
  return value;
};

const endpointRegions = (endpoint, targetRegion) => {
  const configured = endpoint.region;
  const regions = Array.isArray(configured) ? configured : [configured ?? targetRegion];
  if (regions.length === 0 || regions.some((region) => typeof region !== "string" || region.length === 0)) {
    throw new Error("Desired Firebase Function has an invalid region");
  }
  return regions;
};

const desiredFunctions = (moduleExports, targetRegion) => {
  const desired = new Map();

  for (const [id, entry] of Object.entries(moduleExports)) {
    const endpoint = entry?.__endpoint;
    if (!endpoint) continue;
    if (!isRecord(endpoint) || endpoint.platform !== "gcfv2") {
      throw new Error(`Desired Firebase Function ${id} is not Gen2`);
    }

    const scheduled = isRecord(endpoint.scheduleTrigger);
    const event = isRecord(endpoint.eventTrigger);
    if (Number(scheduled) + Number(event) !== 1) {
      throw new Error(`Desired Firebase Function ${id} is not exactly one scheduled or event trigger`);
    }

    for (const region of endpointRegions(endpoint, targetRegion)) {
      const key = functionKey("default", region, id);
      if (desired.has(key)) throw new Error(`Duplicate desired Firebase Function: ${key}`);
      desired.set(key, { id, key, region, trigger: scheduled ? "schedule" : "event" });
    }
  }

  if (desired.size === 0) throw new Error("Desired Firebase Functions inventory is empty");
  return desired;
};

const deployedFunctions = (inventory) => {
  if (!Array.isArray(inventory)) throw new Error("Firebase Functions inventory is malformed");
  const deployed = new Map();

  for (const entry of inventory) {
    if (!isRecord(entry)) throw new Error("Firebase Functions inventory is malformed");
    if (entry.codebase !== "default") continue;
    const id = requireString(entry.id, "id");
    const region = requireString(entry.region, "region");
    const key = functionKey("default", region, id);
    if (deployed.has(key)) throw new Error(`Duplicate deployed Firebase Function: ${key}`);
    deployed.set(key, entry);
  }

  return deployed;
};

const assertNoUnexpectedFunctions = (deployed, desired, allowed) => {
  const unexpected = [...deployed.keys()]
    .filter((key) => !desired.has(key) && !allowed.has(key))
    .sort();
  if (unexpected.length > 0) {
    throw new Error(`Unplanned Functions deletion blocked: ${unexpected.join(", ")}`);
  }
};

export const verifyPredeployInventory = (
  inventory,
  moduleExports,
  targetRegion,
  allowedDeletionIds,
) => {
  const desired = desiredFunctions(moduleExports, targetRegion);
  const deployed = deployedFunctions(inventory);
  const allowed = new Set(
    allowedDeletionIds.map((id) => functionKey("default", targetRegion, id)),
  );
  assertNoUnexpectedFunctions(deployed, desired, allowed);
};

export const verifyPostdeployInventory = (inventory, moduleExports, targetRegion) => {
  const desired = desiredFunctions(moduleExports, targetRegion);
  const deployed = deployedFunctions(inventory);
  assertNoUnexpectedFunctions(deployed, desired, new Set());

  const missing = [...desired.keys()].filter((key) => !deployed.has(key)).sort();
  if (missing.length > 0) throw new Error(`Firebase Functions missing after deploy: ${missing.join(", ")}`);

  const scheduledIamChecks = [];
  for (const [key, expected] of desired) {
    const actual = deployed.get(key);
    if (actual.state !== "ACTIVE") throw new Error(`Firebase Function is not ACTIVE: ${key}`);
    if (actual.platform !== "gcfv2") throw new Error(`Firebase Function is not Gen2: ${key}`);

    const actualTrigger = isRecord(actual.scheduleTrigger)
      ? "schedule"
      : isRecord(actual.eventTrigger)
        ? "event"
        : "unknown";
    if (actualTrigger !== expected.trigger) {
      throw new Error(`Firebase Function trigger drift: ${key}`);
    }

    if (expected.trigger === "schedule") {
      const runServiceId = requireString(actual.runServiceId, "runServiceId");
      const serviceAccount = requireString(actual.serviceAccount, "serviceAccount");
      if (!/^[a-z][a-z0-9-]{0,62}$/.test(runServiceId)) {
        throw new Error(`Firebase Function has invalid runServiceId: ${key}`);
      }
      if (!/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.gserviceaccount\.com$/.test(serviceAccount)) {
        throw new Error(`Firebase Function has invalid serviceAccount: ${key}`);
      }
      scheduledIamChecks.push({ runServiceId, serviceAccount });
    }
  }

  return scheduledIamChecks.sort((left, right) => left.runServiceId.localeCompare(right.runServiceId));
};

const parseArguments = (args) => {
  const values = { allowedDeletionIds: [] };
  for (const argument of args) {
    const [name, ...valueParts] = argument.split("=");
    const value = valueParts.join("=");
    if (!value) throw new Error(`Argument requires a value: ${name}`);
    switch (name) {
      case "--mode": values.mode = value; break;
      case "--inventory": values.inventory = value; break;
      case "--functions-module": values.functionsModule = value; break;
      case "--target-region": values.targetRegion = value; break;
      case "--allow-delete": values.allowedDeletionIds.push(value); break;
      default: throw new Error(`Unknown argument: ${name}`);
    }
  }
  for (const required of ["mode", "inventory", "functionsModule", "targetRegion"]) {
    if (!values[required]) throw new Error(`Missing required argument: --${required.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`);
  }
  if (!new Set(["predeploy", "postdeploy"]).has(values.mode)) {
    throw new Error(`Unsupported verification mode: ${values.mode}`);
  }
  return values;
};

const run = async () => {
  const options = parseArguments(process.argv.slice(2));
  const inventoryDocument = JSON.parse(readFileSync(resolve(options.inventory), "utf8"));
  if (!Array.isArray(inventoryDocument.result)) {
    throw new Error("Firebase Functions inventory is malformed");
  }
  const moduleExports = await import(pathToFileURL(resolve(options.functionsModule)).href);

  if (options.mode === "predeploy") {
    verifyPredeployInventory(
      inventoryDocument.result,
      moduleExports,
      options.targetRegion,
      options.allowedDeletionIds,
    );
    return;
  }

  const checks = verifyPostdeployInventory(
    inventoryDocument.result,
    moduleExports,
    options.targetRegion,
  );
  for (const check of checks) {
    process.stdout.write(`${check.runServiceId}\t${check.serviceAccount}\n`);
  }
};

const mainUrl = (value) => {
  try {
    return pathToFileURL(realpathSync(value)).href;
  } catch {
    return pathToFileURL(value).href;
  }
};

if (process.argv[1] && import.meta.url === mainUrl(process.argv[1])) {
  run().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
