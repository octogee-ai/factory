import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const MIGRATION_RECEIPT_BUCKET = "gs://octogee-migration-receipts";
export const TERRAFORM_STATE_BUCKET = "gs://octogee-terraform-state";
export const MIGRATION_RECEIPT_OPERATOR_MEMBERS = [
  "user:christopher.k.eckert@squarepointconsulting.com",
] as const;
export const MIGRATION_RECEIPT_WORM_PROOF_PRINCIPAL =
  "user:christopher.k.eckert@squarepointconsulting.com";
export const MIGRATION_RECEIPT_WORM_PROOF_AUTHORITY = {
  principal: MIGRATION_RECEIPT_WORM_PROOF_PRINCIPAL,
  projectId: "octogee",
  role: "roles/owner",
} as const;
const RECEIPT_PREFIX = "receipts/";
const RETENTION_SECONDS = 400 * 24 * 60 * 60;
const OBJECT_NAME = /^[a-z0-9][a-z0-9._/-]{0,500}\.json$/;
const JSON_FORMAT = "--format=json";
const GCLOUD_AUTHORITY_OVERRIDE_ENVIRONMENT_VARIABLES = [
  "CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE",
  "CLOUDSDK_AUTH_ACCESS_TOKEN_FILE",
  "CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT",
  "CLOUDSDK_CORE_ACCOUNT",
] as const;
const GCLOUD_AUTHORITY_OVERRIDE_PROPERTIES = [
  "auth/credential_file_override",
  "auth/access_token_file",
  "auth/impersonate_service_account",
] as const;

type JsonRecord = Record<string, unknown>;
export type CommandRunner = (command: string, args: readonly string[]) => string;

export type ImmutableMigrationReceipt = {
  uri: string;
  generation: string;
};

export class MigrationReceiptCollisionError extends Error {
  readonly code = "MIGRATION_RECEIPT_COLLISION";

  constructor(readonly uri: string, options: ErrorOptions) {
    super(`immutable migration receipt already exists: ${uri}`, options);
    this.name = "MigrationReceiptCollisionError";
  }
}

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
  const env = { ...process.env };
  for (const name of GCLOUD_AUTHORITY_OVERRIDE_ENVIRONMENT_VARIABLES) {
    delete env[name];
  }
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env,
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
  if (bucket.versioning !== undefined) {
    const versioning = record(bucket.versioning, "migration receipt bucket versioning");
    if (versioning.enabled !== false) {
      throw new Error("migration receipt bucket versioning must be disabled");
    }
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
  const lifecycle = record(bucket.lifecycle, "migration receipt bucket lifecycle");
  const rules = lifecycle.rule;
  if (!Array.isArray(rules) || rules.length !== 1) {
    throw new Error("migration receipt bucket must have exactly one lifecycle rule");
  }
  const rule = record(rules[0], "migration receipt bucket lifecycle rule");
  const action = record(rule.action, "migration receipt bucket lifecycle action");
  const condition = record(rule.condition, "migration receipt bucket lifecycle condition");
  if (action.type !== "Delete" || numberValue(condition.age) !== 400) {
    throw new Error("migration receipt bucket lifecycle must delete at age 400 days");
  }
}

function assertBucketLocalIamPolicy(policy: JsonRecord): void {
  const bindings = policy.bindings;
  if (!Array.isArray(bindings)) throw new Error("migration receipt bucket IAM policy has no bindings");
  const expectedRoles = [
    "roles/storage.objectCreator",
    "roles/storage.objectViewer",
  ];
  const actualRoles: string[] = [];
  for (const bindingValue of bindings) {
    const binding = record(bindingValue, "migration receipt bucket IAM binding");
    if (typeof binding.role !== "string") {
      throw new Error("migration receipt bucket-local IAM binding has no role");
    }
    actualRoles.push(binding.role);
    const members = binding.members;
    if (
      !Array.isArray(members) ||
      members.some((member) => typeof member !== "string") ||
      JSON.stringify([...members].sort()) !==
        JSON.stringify([...MIGRATION_RECEIPT_OPERATOR_MEMBERS].sort())
    ) {
      throw new Error(`migration receipt bucket-local IAM ${binding.role} must have exact members`);
    }
  }
  if (
    JSON.stringify(actualRoles.sort()) !== JSON.stringify(expectedRoles.sort())
  ) {
    throw new Error("migration receipt bucket-local IAM must have exact roles");
  }
}

export function assertMigrationReceiptWormProofAuthority(
  run: CommandRunner = runMigrationReceiptCommand,
): typeof MIGRATION_RECEIPT_WORM_PROOF_AUTHORITY {
  for (const property of GCLOUD_AUTHORITY_OVERRIDE_PROPERTIES) {
    const value = run("gcloud", ["config", "get-value", property]).trim();
    if (value !== "" && value !== "(unset)") {
      throw new Error("migration receipt WORM proof refuses a configured gcloud authority override");
    }
  }
  const activeAccount = run("gcloud", ["config", "get-value", "account"]).trim();
  if (`user:${activeAccount}` !== MIGRATION_RECEIPT_WORM_PROOF_AUTHORITY.principal) {
    throw new Error("migration receipt WORM proof requires the configured project owner proof principal");
  }
  const projectPolicy = parseJson(run("gcloud", [
    "projects",
    "get-iam-policy",
    MIGRATION_RECEIPT_WORM_PROOF_AUTHORITY.projectId,
    JSON_FORMAT,
  ]), "migration receipt WORM proof project IAM policy");
  const bindings = projectPolicy.bindings;
  if (!Array.isArray(bindings)) {
    throw new Error("migration receipt WORM proof project IAM policy has no bindings");
  }
  const hasProofAuthority = bindings.some((bindingValue) => {
    const binding = record(bindingValue, "migration receipt WORM proof project IAM binding");
    return binding.role === MIGRATION_RECEIPT_WORM_PROOF_AUTHORITY.role &&
      Array.isArray(binding.members) &&
      binding.members.includes(MIGRATION_RECEIPT_WORM_PROOF_AUTHORITY.principal);
  });
  if (!hasProofAuthority) {
    throw new Error("migration receipt WORM proof requires the configured project owner proof principal");
  }
  return MIGRATION_RECEIPT_WORM_PROOF_AUTHORITY;
}

function assertTerraformStateBucket(bucket: JsonRecord): void {
  if (valueAt(bucket, "iamConfiguration", "uniformBucketLevelAccess", "enabled") !== true) {
    throw new Error("Terraform state bucket must enforce uniform bucket-level access");
  }
  if (valueAt(bucket, "iamConfiguration", "publicAccessPrevention") !== "enforced") {
    throw new Error("Terraform state bucket must enforce public access prevention");
  }
  if (valueAt(bucket, "versioning", "enabled") !== true) {
    throw new Error("Terraform state bucket must enable versioning");
  }
  if (numberValue(valueAt(bucket, "softDeletePolicy", "retentionDurationSeconds")) !== 604800) {
    throw new Error("Terraform state bucket must retain soft-deleted objects for seven days");
  }
  if (bucket.retentionPolicy !== undefined && bucket.retentionPolicy !== null) {
    throw new Error("Terraform state bucket must have no retention policy");
  }
}

export function assertMigrationReceiptBucket(run: CommandRunner = runMigrationReceiptCommand): void {
  const bucket = parseJson(run("gcloud", [
    "storage", "buckets", "describe", MIGRATION_RECEIPT_BUCKET, JSON_FORMAT, "--raw",
  ]), "migration receipt bucket describe");
  assertBucketConfiguration(bucket);
  const policy = parseJson(run("gcloud", [
    "storage", "buckets", "get-iam-policy", MIGRATION_RECEIPT_BUCKET, JSON_FORMAT,
  ]), "migration receipt bucket IAM policy");
  assertBucketLocalIamPolicy(policy);
  const terraformState = parseJson(run("gcloud", [
    "storage", "buckets", "describe", TERRAFORM_STATE_BUCKET, JSON_FORMAT, "--raw",
  ]), "Terraform state bucket describe");
  assertTerraformStateBucket(terraformState);
}

function generationFor(uri: string, run: CommandRunner): string {
  const metadata = parseJson(run("gcloud", [
    "storage", "objects", "describe", uri, JSON_FORMAT, "--raw",
  ]), "migration receipt metadata");
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
    try {
      run("gcloud", ["storage", "cp", "--if-generation-match=0", receiptFile, uri]);
    } catch (error) {
      if (
        error instanceof Error &&
        /(?:\b412\b|conditionnotmet|pre-?condition).*(?:ifgenerationmatch|generation|specified did not hold)|ifgenerationmatch.*(?:\b412\b|conditionnotmet|pre-?condition)/i
          .test(error.message)
      ) {
        throw new MigrationReceiptCollisionError(uri, { cause: error });
      }
      throw error;
    }
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
