#!/usr/bin/env node

import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const MUTATING_ACTIONS = new Set(["create", "update", "delete"]);
const FIRESTORE_DATABASE_ADDRESS = "module.data_project.google_firestore_database.default";
const FIRESTORE_SENSITIVITY_SHAPE = { cmek_config: [] };

const countAction = (actions) => {
  const creates = actions.includes("create");
  const deletes = actions.includes("delete");

  if (creates && deletes) return "replace";
  if (creates) return "create";
  if (actions.includes("update")) return "update";
  if (deletes) return "delete";
  return null;
};

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const changedTopLevelPaths = (before, after) => {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return keys.filter((key) => !isDeepStrictEqual(before[key], after[key]));
};

const isReadOnly = (actions) => Array.isArray(actions)
  && actions.length > 0
  && actions.every((action) => action === "no-op" || action === "read");

const isNonemptyString = (value) => typeof value === "string" && value.length > 0;

const knownVolatileFirestoreEtagException = (resource) => {
  const change = resource.change ?? {};
  const allowedChangeKeys = [
    "actions",
    "after",
    "after_sensitive",
    "after_unknown",
    "before",
    "before_sensitive",
  ];

  return resource.address === FIRESTORE_DATABASE_ADDRESS
    && isDeepStrictEqual(Object.keys(change).sort(), allowedChangeKeys)
    && Array.isArray(change.actions)
    && change.actions.length === 1
    && change.actions[0] === "update"
    && isPlainObject(change.before)
    && isPlainObject(change.after)
    && Object.hasOwn(change.before, "etag")
    && Object.hasOwn(change.after, "etag")
    && isNonemptyString(change.before.etag)
    && isNonemptyString(change.after.etag)
    && change.before.etag !== change.after.etag
    && isPlainObject(change.after_unknown)
    && Object.keys(change.after_unknown).length === 0
    && isDeepStrictEqual(change.before_sensitive, FIRESTORE_SENSITIVITY_SHAPE)
    && isDeepStrictEqual(change.after_sensitive, FIRESTORE_SENSITIVITY_SHAPE)
    && isDeepStrictEqual(changedTopLevelPaths(change.before, change.after), ["etag"]);
};

const assertNoMutatingResourceDrift = (plan) => {
  for (const resource of plan.resource_drift ?? []) {
    const actions = resource.change?.actions ?? [];
    if (!isReadOnly(actions)) {
      throw new Error(`Plan contains provider-reported resource drift: ${resource.address}`);
    }
  }
};

const convergenceExceptions = (plan) => {
  const resourceChanges = plan.resource_changes ?? [];
  const outputChanges = Object.values(plan.output_changes ?? {});
  const resourceDrift = plan.resource_drift ?? [];

  if (plan.complete !== true || plan.errored !== false) {
    throw new Error("Plan is not complete and error-free");
  }
  if (plan.deferred_changes !== undefined) {
    throw new Error("Plan contains deferred changes");
  }
  if (!Array.isArray(plan.checks) || plan.checks.some((check) => check.status !== "pass")) {
    throw new Error("Plan contains a check that did not pass");
  }
  if (resourceChanges.some((resource) => !isReadOnly(resource.change?.actions ?? []))) {
    throw new Error("Plan contains resource changes; convergence evidence requires none");
  }
  if (outputChanges.some((output) => !isReadOnly(output?.actions ?? []))) {
    throw new Error("Plan contains output changes; convergence evidence requires none");
  }
  if (resourceDrift.length > 1) {
    throw new Error("Plan contains multiple provider-reported resource drift entries");
  }
  if (resourceDrift.length === 0) return [];
  if (!knownVolatileFirestoreEtagException(resourceDrift[0])) {
    throw new Error("Plan contains unsupported provider-reported resource drift");
  }

  return [{
    source: "resource_drift",
    address: FIRESTORE_DATABASE_ADDRESS,
    actions: ["update"],
    changedTopLevelPaths: ["etag"],
  }];
};

export const buildPlanReceipt = (plan, options) => {
  const knownVolatileMetadataExceptions = options.preReleaseConvergence
    ? convergenceExceptions(plan)
    : (assertNoMutatingResourceDrift(plan), []);
  const changes = [];
  const summary = { create: 0, update: 0, delete: 0, replace: 0 };

  for (const resource of plan.resource_changes ?? []) {
    const actions = resource.change?.actions ?? [];
    const kind = countAction(actions);
    const unknownActions = actions.filter(
      (action) => !MUTATING_ACTIONS.has(action) && action !== "no-op" && action !== "read",
    );

    if (unknownActions.length > 0) {
      throw new Error(
        `Plan contains unsupported actions for ${resource.address}: ${unknownActions.join(", ")}`,
      );
    }
    if (kind === null) continue;
    if (
      options.allowedChangeAddresses !== null &&
      options.allowedChangeAddresses !== undefined &&
      !options.allowedChangeAddresses.has(resource.address)
    ) {
      throw new Error(`Plan contains an unauthorized change: ${resource.address}`);
    }
    if (actions.includes("delete") && !options.allowedDestructiveAddresses.has(resource.address)) {
      throw new Error(`Plan contains an unauthorized destructive change: ${resource.address}`);
    }

    summary[kind] += 1;
    changes.push({ address: resource.address, actions: [...actions] });
  }

  return {
    schemaVersion: options.preReleaseConvergence ? 2 : 1,
    target: options.target,
    phase: options.phase,
    generatedAt: options.generatedAt,
    gitCommit: options.gitCommit,
    terraformVersion: plan.terraform_version,
    planFormatVersion: plan.format_version,
    planSha256: createHash("sha256").update(JSON.stringify(plan)).digest("hex"),
    summary,
    changes,
    ...(options.preReleaseConvergence ? { knownVolatileMetadataExceptions } : {}),
  };
};

const parseArguments = (args) => {
  const values = {
    allowedChangeAddresses: null,
    allowedDestructiveAddresses: new Set(),
    generatedAt: new Date().toISOString(),
  };

  for (const arg of args) {
    if (arg === "--pre-release-convergence") {
      values.preReleaseConvergence = true;
      continue;
    }
    const [name, ...valueParts] = arg.split("=");
    const value = valueParts.join("=");
    if (!value) throw new Error(`Argument requires a value: ${name}`);

    switch (name) {
      case "--target":
        values.target = value;
        break;
      case "--phase":
        values.phase = value;
        break;
      case "--git-commit":
        values.gitCommit = value;
        break;
      case "--generated-at":
        values.generatedAt = value;
        break;
      case "--allow-destroy":
        values.allowedDestructiveAddresses.add(value);
        break;
      case "--allow-change":
        values.allowedChangeAddresses ??= new Set();
        values.allowedChangeAddresses.add(value);
        break;
      default:
        throw new Error(`Unknown argument: ${name}`);
    }
  }

  for (const required of ["target", "phase", "gitCommit"]) {
    if (!values[required]) {
      const argumentName = required.replaceAll(/([A-Z])/g, "-$1").toLowerCase();
      throw new Error(`Missing required argument: --${argumentName}`);
    }
  }

  return values;
};

const readStandardInput = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
};

const run = async () => {
  const options = parseArguments(process.argv.slice(2));
  const input = await readStandardInput();
  const plan = JSON.parse(input);
  process.stdout.write(`${JSON.stringify(buildPlanReceipt(plan, options), null, 2)}\n`);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
