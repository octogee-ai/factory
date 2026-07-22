#!/usr/bin/env node

import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const MUTATING_ACTIONS = new Set(["create", "update", "delete"]);

const countAction = (actions) => {
  const creates = actions.includes("create");
  const deletes = actions.includes("delete");

  if (creates && deletes) return "replace";
  if (creates) return "create";
  if (actions.includes("update")) return "update";
  if (deletes) return "delete";
  return null;
};

export const buildPlanReceipt = (plan, options) => {
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
    schemaVersion: 1,
    target: options.target,
    phase: options.phase,
    generatedAt: options.generatedAt,
    gitCommit: options.gitCommit,
    terraformVersion: plan.terraform_version,
    planFormatVersion: plan.format_version,
    planSha256: createHash("sha256").update(JSON.stringify(plan)).digest("hex"),
    summary,
    changes,
  };
};

const parseArguments = (args) => {
  const values = {
    allowedChangeAddresses: null,
    allowedDestructiveAddresses: new Set(),
    generatedAt: new Date().toISOString(),
  };

  for (const arg of args) {
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
