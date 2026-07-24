import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const MIGRATION_RECEIPT_BUCKET = "gs://octogee-migration-receipts";
const RECEIPT_PREFIX = "receipts/";
const RETENTION_SECONDS = 400 * 24 * 60 * 60;
const OBJECT_NAME = /^[a-z0-9][a-z0-9._/-]{0,500}\.json$/;

type JsonRecord = Record<string, unknown>;
export type CommandRunner = (command: string, args: readonly string[]) => string;

export type ImmutableMigrationReceipt = {
  uri: string;
  generation: string;
};

function record(value: unknown, description: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${description} must be an object`);
  }
  return value as JsonRecord;
}

function parseJson(output: string, description: string): JsonRecord {
  try {
    return record(JSON.parse(output), description);
  } catch (error) {
    if (error instanceof Error && error.message.endsWith("must be an object")) throw error;
    throw new Error(`${description} returned invalid JSON`);
  }
}

export function runMigrationReceiptCommand(
  command: string,
  args: readonly string[],
): string {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed (${result.status ?? "signal"}): ${result.stderr.trim()}`);
  }
  return result.stdout;
}

export function immutableMigrationReceiptUri(objectName: string): string {
  if (!OBJECT_NAME.test(objectName) || objectName.includes("..") || objectName.startsWith("/")) {
    throw new Error("migration receipt object name must be path-safe and end in .json");
  }
  return `${MIGRATION_RECEIPT_BUCKET}/${RECEIPT_PREFIX}${objectName}`;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return null;
}

function valueAt(recordValue: JsonRecord, ...keys: string[]): unknown {
  let value: unknown = recordValue;
  for (const key of keys) value = record(value, `bucket field ${keys.join(".")}`)[key];
  return value;
}

function assertBucketConfiguration(bucket: JsonRecord): void {
  if (bucket.location !== "US-WEST1") throw new Error("migration receipt bucket must be in US-WEST1");
  if (bucket.storageClass !== "STANDARD") throw new Error("migration receipt bucket must use STANDARD storage");
  if (valueAt(bucket, "iamConfiguration", "uniformBucketLevelAccess", "enabled") !== true) {
    throw new Error("migration receipt bucket must enforce uniform bucket-level access");
  }
  if (valueAt(bucket, "iamConfiguration", "publicAccessPrevention") !== "enforced") {
    throw new Error("migration receipt bucket must enforce public access prevention");
  }
  if (valueAt(bucket, "versioning", "enabled") !== true) {
    throw new Error("migration receipt bucket must enable versioning");
  }
  if (numberValue(valueAt(bucket, "retentionPolicy", "retentionPeriod")) !== RETENTION_SECONDS) {
    throw new Error("migration receipt bucket must retain objects for exactly 400 days");
  }
  if (valueAt(bucket, "retentionPolicy", "isLocked") !== true) {
    throw new Error("migration receipt bucket retention policy must be locked");
  }
  if (numberValue(valueAt(bucket, "softDeletePolicy", "retentionDurationSeconds")) !== 0) {
    throw new Error("migration receipt bucket soft delete must be disabled");
  }
}

function assertBucketIamBoundary(policy: JsonRecord): void {
  const bindings = policy.bindings;
  if (!Array.isArray(bindings)) throw new Error("migration receipt bucket IAM policy has no bindings");
  const roles = new Set<string>();
  for (const bindingValue of bindings) {
    const binding = record(bindingValue, "migration receipt bucket IAM binding");
    if (typeof binding.role === "string") roles.add(binding.role);
    const members = binding.members;
    if (!Array.isArray(members)) continue;
    if (members.some((member) => member === "allUsers" || member === "allAuthenticatedUsers")) {
      throw new Error("migration receipt bucket IAM must not grant public access");
    }
  }
  for (const role of ["roles/storage.objectCreator", "roles/storage.objectViewer"]) {
    if (!roles.has(role)) throw new Error(`migration receipt bucket IAM lacks ${role}`);
  }
}

export function assertMigrationReceiptBucket(run: CommandRunner = runMigrationReceiptCommand): void {
  const bucket = parseJson(run("gcloud", [
    "storage", "buckets", "describe", MIGRATION_RECEIPT_BUCKET, "--format=json",
  ]), "migration receipt bucket describe");
  assertBucketConfiguration(bucket);
  const policy = parseJson(run("gcloud", [
    "storage", "buckets", "get-iam-policy", MIGRATION_RECEIPT_BUCKET, "--format=json",
  ]), "migration receipt bucket IAM policy");
  assertBucketIamBoundary(policy);
}

function generationFor(uri: string, run: CommandRunner): string {
  const metadata = parseJson(run("gcloud", ["storage", "objects", "describe", uri, "--format=json"]), "migration receipt metadata");
  const generation = metadata.generation;
  if (typeof generation !== "string" || !/^\d+$/.test(generation) || generation === "0") {
    throw new Error("migration receipt metadata has no valid generation");
  }
  return generation;
}

export function writeImmutableMigrationReceipt(
  objectName: string,
  receipt: JsonRecord,
  run: CommandRunner = runMigrationReceiptCommand,
): ImmutableMigrationReceipt {
  const uri = immutableMigrationReceiptUri(objectName);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-migration-receipt."));
  const receiptFile = path.join(directory, "receipt.json");
  try {
    fs.writeFileSync(receiptFile, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
    run("gcloud", ["storage", "cp", "--if-generation-match=0", receiptFile, uri]);
    return { uri, generation: generationFor(uri, run) };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

export function readImmutableMigrationReceipt(
  uri: string,
  expected: JsonRecord,
  run: CommandRunner = runMigrationReceiptCommand,
): ImmutableMigrationReceipt & { receipt: JsonRecord } {
  if (!uri.startsWith(`${MIGRATION_RECEIPT_BUCKET}/${RECEIPT_PREFIX}`)) {
    throw new Error("migration receipt must be in the immutable receipt bucket");
  }
  const generation = generationFor(uri, run);
  const receipt = parseJson(run("gcloud", ["storage", "cat", `${uri}#${generation}`]), "migration receipt");
  for (const [key, value] of Object.entries(expected)) {
    if (receipt[key] !== value) throw new Error(`migration receipt does not prove ${key}`);
  }
  return { uri, generation, receipt };
}
