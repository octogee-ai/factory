import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MigrationReceiptCollisionError,
  assertMigrationReceiptBucket,
  runMigrationReceiptCommand,
  writeImmutableMigrationReceipt,
  type CommandRunner,
} from "../lib/migration-receipts.js";

const CONFIRMATION = "octogee/migration-receipt-worm-proof/test";

type ProofDependencies = {
  run: CommandRunner;
  now: () => Date;
  uuid: () => string;
};

type ObjectMetadata = {
  generation: string;
  md5Hash: string;
};

export type MigrationReceiptWormProof = {
  target: "test";
  status: "verified";
  uri: string;
  generation: string;
  md5Hash: string;
  createOnlyCollision: "verified";
  replacementRetentionDenial: "verified";
  exactGenerationDeleteRetentionDenial: "verified";
  originalObjectUnchanged: "verified";
  generationCount: 1;
};

function objectRecord(value: unknown, description: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${description} must be an object`);
  }
  return value as Record<string, unknown>;
}

function objectMetadata(output: string, description: string): ObjectMetadata {
  const value = objectRecord(JSON.parse(output), description);
  if (
    typeof value.generation !== "string" ||
    !/^[1-9]\d*$/.test(value.generation) ||
    typeof value.md5Hash !== "string" ||
    value.md5Hash.length === 0
  ) {
    throw new Error(`${description} must include generation and md5Hash`);
  }
  return { generation: value.generation, md5Hash: value.md5Hash };
}

function describeObject(
  uri: string,
  generation: string,
  run: CommandRunner,
): ObjectMetadata {
  return objectMetadata(run("gcloud", [
    "storage",
    "objects",
    "describe",
    `${uri}#${generation}`,
    "--format=json",
    "--raw",
  ]), "synthetic migration receipt metadata");
}

function expectRetentionDenial(
  description: string,
  args: readonly string[],
  run: CommandRunner,
): void {
  try {
    run("gcloud", args);
  } catch (error) {
    if (error instanceof Error && /retention/i.test(error.message)) return;
    throw new Error(`${description} did not fail specifically because of retention`, {
      cause: error,
    });
  }
  throw new Error(`${description} unexpectedly succeeded`);
}

function assertSingleOriginalGeneration(
  uri: string,
  expected: ObjectMetadata,
  run: CommandRunner,
): void {
  const output = JSON.parse(run("gcloud", [
    "storage",
    "ls",
    "--all-versions",
    "--json",
    uri,
  ])) as unknown;
  if (!Array.isArray(output) || output.length !== 1) {
    throw new Error("synthetic migration receipt must have exactly one generation");
  }
  const item = objectRecord(output[0], "synthetic migration receipt generation");
  const metadata = objectMetadata(
    JSON.stringify(objectRecord(item.metadata, "synthetic migration receipt generation metadata")),
    "synthetic migration receipt generation metadata",
  );
  if (metadata.generation !== expected.generation || metadata.md5Hash !== expected.md5Hash) {
    throw new Error("synthetic migration receipt generation or hash changed");
  }
}

export function executeMigrationReceiptWormProof(
  argv: readonly string[],
  dependencies: Partial<ProofDependencies> = {},
): MigrationReceiptWormProof {
  if (argv.length !== 2 || argv[0] !== "--target=test" || argv[1] !== `--confirm=${CONFIRMATION}`) {
    throw new Error(`usage: --target=test --confirm=${CONFIRMATION}`);
  }
  const run = dependencies.run ?? runMigrationReceiptCommand;
  const now = dependencies.now ?? (() => new Date());
  const uuid = dependencies.uuid ?? randomUUID;
  assertMigrationReceiptBucket(run);
  const createdAt = now().toISOString();
  const objectName =
    `migration-receipt-worm-proof/test/${createdAt.replaceAll(/[:.]/g, "-").toLowerCase()}-${uuid()}.json`;
  const receipt = writeImmutableMigrationReceipt(objectName, {
    schemaVersion: 1,
    kind: "migration-receipt-worm-proof",
    target: "test",
    createdAt,
    lifecycleAgeDays: 400,
    secretFree: true,
  }, run);
  const original = describeObject(receipt.uri, receipt.generation, run);

  try {
    writeImmutableMigrationReceipt(objectName, {
      schemaVersion: 1,
      kind: "migration-receipt-worm-proof-collision",
      secretFree: true,
    }, run);
    throw new Error("create-only collision unexpectedly succeeded");
  } catch (error) {
    if (!(error instanceof MigrationReceiptCollisionError)) throw error;
  }

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-worm-proof."));
  const replacement = path.join(directory, "replacement.json");
  try {
    fs.writeFileSync(replacement, "{\"syntheticReplacement\":true}\n", { mode: 0o600 });
    expectRetentionDenial("generation-matched replacement", [
      "storage",
      "cp",
      `--if-generation-match=${receipt.generation}`,
      replacement,
      receipt.uri,
    ], run);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  expectRetentionDenial("exact-generation deletion", [
    "storage",
    "rm",
    `${receipt.uri}#${receipt.generation}`,
  ], run);

  const afterDenials = describeObject(receipt.uri, receipt.generation, run);
  if (
    afterDenials.generation !== original.generation ||
    afterDenials.md5Hash !== original.md5Hash
  ) {
    throw new Error("synthetic migration receipt changed after denied mutations");
  }
  assertSingleOriginalGeneration(receipt.uri, original, run);

  return {
    target: "test",
    status: "verified",
    uri: receipt.uri,
    generation: original.generation,
    md5Hash: original.md5Hash,
    createOnlyCollision: "verified",
    replacementRetentionDenial: "verified",
    exactGenerationDeleteRetentionDenial: "verified",
    originalObjectUnchanged: "verified",
    generationCount: 1,
  };
}

function isEntrypoint(moduleUrl: string, entrypoint: string | undefined): boolean {
  if (!entrypoint) return false;
  return fs.realpathSync(fileURLToPath(moduleUrl)) === fs.realpathSync(entrypoint);
}

if (isEntrypoint(import.meta.url, process.argv[1])) {
  try {
    process.stdout.write(
      `${JSON.stringify(executeMigrationReceiptWormProof(process.argv.slice(2)))}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
