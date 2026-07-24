import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  assertMigrationReceiptBucket,
  writeImmutableMigrationReceipt,
} from "../lib/migration-receipts.js";

const CONFIRMATION = "octogee/migration-receipt-worm-proof/test";

function expectRetentionDenial(args: readonly string[]): void {
  const result = spawnSync("gcloud", args, {
    encoding: "utf8",
    input: "{\"synthetic\":true}\n",
    stdio: ["pipe", "pipe", "pipe"],
  });
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.error) throw result.error;
  if (result.status === 0 || !/retention/i.test(output)) {
    throw new Error("synthetic migration receipt was not denied by the retention policy");
  }
}

function main(argv: readonly string[]): void {
  if (argv.length !== 2 || argv[0] !== "--target=test" || argv[1] !== `--confirm=${CONFIRMATION}`) {
    throw new Error(`usage: --target=test --confirm=${CONFIRMATION}`);
  }
  assertMigrationReceiptBucket();
  const createdAt = new Date().toISOString();
  const receipt = writeImmutableMigrationReceipt(
    `migration-receipt-worm-proof/test/${createdAt.replaceAll(/[:.]/g, "-")}-${randomUUID()}.json`,
    {
      schemaVersion: 1,
      kind: "migration-receipt-worm-proof",
      target: "test",
      createdAt,
      lifecycleAgeDays: 400,
      secretFree: true,
    },
  );
  expectRetentionDenial([
    "storage",
    "cp",
    `--if-generation-match=${receipt.generation}`,
    "-",
    `${receipt.uri}#${receipt.generation}`,
  ]);
  expectRetentionDenial(["storage", "rm", `${receipt.uri}#${receipt.generation}`]);
  process.stdout.write(`${JSON.stringify({
    target: "test",
    status: "retention-denied-overwrite-and-delete",
    uri: receipt.uri,
    generation: receipt.generation,
  })}\n`);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
