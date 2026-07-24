import { assertMigrationReceiptBucket } from "../lib/migration-receipts.js";

try {
  if (process.argv.length !== 2) throw new Error("this verifier accepts no arguments");
  assertMigrationReceiptBucket();
  process.stdout.write("Immutable migration receipt bucket verified.\n");
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
