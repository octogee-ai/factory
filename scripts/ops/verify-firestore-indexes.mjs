import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "../../..");
const defaultConfigPath = path.join(repoRoot, "site/firestore.indexes.json");

function collectionGroup(index) {
  if (typeof index.collectionGroup === "string") return index.collectionGroup;
  if (typeof index.name !== "string") return "";
  const match = index.name.match(/\/collectionGroups\/([^/]+)\/indexes\//);
  return match ? decodeURIComponent(match[1]) : "";
}

function normalizedFields(index) {
  if (!Array.isArray(index.fields)) return [];
  return index.fields
    .filter((field) => field?.fieldPath !== "__name__")
    .map((field) => ({
      fieldPath: field?.fieldPath,
      order: field?.order,
      arrayConfig: field?.arrayConfig,
    }));
}

function signature(index) {
  return JSON.stringify({
    collectionGroup: collectionGroup(index),
    queryScope: index.queryScope,
    fields: normalizedFields(index),
  });
}

function description(index) {
  const fields = normalizedFields(index)
    .map((field) => `${field.fieldPath} ${field.order ?? field.arrayConfig ?? "UNKNOWN"}`)
    .join(", ");
  return `${collectionGroup(index)}(${fields})`;
}

export function compareCompositeIndexes(expectedConfig, actualIndexes) {
  const actualBySignature = new Map(actualIndexes.map((index) => [signature(index), index]));
  const missing = [];
  const unready = [];

  for (const expected of expectedConfig.indexes ?? []) {
    const actual = actualBySignature.get(signature(expected));
    if (!actual) {
      missing.push(description(expected));
    } else if (actual.state !== "READY") {
      unready.push(`${description(expected)} [${actual.state ?? "UNKNOWN"}]`);
    }
  }

  return { missing, unready };
}

function positiveInteger(value, name) {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`${name} must be a positive integer`);
  }
  return Number(value);
}

function nonNegativeInteger(value, name) {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return Number(value);
}

function parseArgs(argv) {
  let project = "";
  let configPath = defaultConfigPath;
  for (const argument of argv) {
    if (argument.startsWith("--project=")) project = argument.slice("--project=".length);
    else if (argument.startsWith("--config=")) configPath = argument.slice("--config=".length);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!project) throw new Error("--project is required");
  return { project, configPath };
}

function listCompositeIndexes(project, env) {
  const output = execFileSync(
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- gcloud is the authenticated operator/CI control-plane client.
    "gcloud",
    [
      "firestore",
      "indexes",
      "composite",
      "list",
      `--project=${project}`,
      "--database=(default)",
      "--format=json",
    ],
    { encoding: "utf8", env },
  );
  const parsed = JSON.parse(output);
  if (!Array.isArray(parsed)) {
    throw new Error("gcloud returned a non-array composite index inventory");
  }
  return parsed;
}

function failureSummary(project, comparison) {
  const parts = [];
  if (comparison.missing.length > 0) parts.push(`missing ${comparison.missing.join("; ")}`);
  if (comparison.unready.length > 0) parts.push(`not ready ${comparison.unready.join("; ")}`);
  return `Firestore composite indexes are not ready in ${project}: ${parts.join(" | ")}`;
}

export async function verifyFirestoreIndexesMain(argv = process.argv.slice(2), env = process.env) {
  const { project, configPath } = parseArgs(argv);
  const expectedConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const maxAttempts = positiveInteger(
    env.FIRESTORE_INDEX_VERIFY_MAX_ATTEMPTS ?? "60",
    "FIRESTORE_INDEX_VERIFY_MAX_ATTEMPTS",
  );
  const retrySeconds = nonNegativeInteger(
    env.FIRESTORE_INDEX_VERIFY_RETRY_SECONDS ?? "10",
    "FIRESTORE_INDEX_VERIFY_RETRY_SECONDS",
  );

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const actualIndexes = listCompositeIndexes(project, env);
    const comparison = compareCompositeIndexes(expectedConfig, actualIndexes);
    if (comparison.missing.length === 0 && comparison.unready.length === 0) {
      process.stdout.write(
        `Firestore composite indexes ready in ${project}: ${expectedConfig.indexes?.length ?? 0}\n`,
      );
      return;
    }
    if (attempt === maxAttempts) throw new Error(failureSummary(project, comparison));
    await new Promise((resolve) => setTimeout(resolve, retrySeconds * 1000));
  }
}

function invokedAsMain() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(scriptPath);
  } catch {
    return false;
  }
}

if (invokedAsMain()) {
  verifyFirestoreIndexesMain().catch((error) => {
    process.stderr.write(
      `[firestore-index-verify] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
