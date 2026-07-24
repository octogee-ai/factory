import { describe, expect, it, vi } from "vitest";
import {
  MIGRATION_RECEIPT_BUCKET,
  assertMigrationReceiptBucket,
  immutableMigrationReceiptUri,
  readImmutableMigrationReceipt,
  writeImmutableMigrationReceipt,
} from "../lib/migration-receipts.js";

describe("immutable migration receipts", () => {
  it("uses only the dedicated receipt bucket and path-safe object names", () => {
    expect(MIGRATION_RECEIPT_BUCKET).toBe("gs://octogee-migration-receipts");
    expect(immutableMigrationReceiptUri("platform-builder-credential-reset/test.json"))
      .toBe("gs://octogee-migration-receipts/receipts/platform-builder-credential-reset/test.json");
    expect(() => immutableMigrationReceiptUri("../state.tfstate")).toThrow(/path-safe/i);
  });

  it("rejects a live bucket that is not locked, regional, private, versioned, and without soft delete", () => {
    const validBucket = {
      location: "US-WEST1",
      storageClass: "STANDARD",
      iamConfiguration: { uniformBucketLevelAccess: { enabled: true }, publicAccessPrevention: "enforced" },
      versioning: { enabled: true },
      retentionPolicy: { retentionPeriod: "34560000", isLocked: true },
      softDeletePolicy: { retentionDurationSeconds: "0" },
    };
    const run = vi.fn((_command: string, args: readonly string[]) =>
      args.includes("get-iam-policy")
        ? JSON.stringify({ bindings: [
          { role: "roles/storage.objectCreator", members: ["user:operator@example.com"] },
          { role: "roles/storage.objectViewer", members: ["user:operator@example.com"] },
        ] })
        : JSON.stringify(validBucket),
    );

    expect(() => assertMigrationReceiptBucket(run)).not.toThrow();
    expect(run).toHaveBeenCalledWith("gcloud", [
      "storage", "buckets", "describe", MIGRATION_RECEIPT_BUCKET, "--format=json",
    ]);
    expect(() => assertMigrationReceiptBucket(() => JSON.stringify({ ...validBucket,
      retentionPolicy: { retentionPeriod: "34560000", isLocked: false },
    }))).toThrow(/locked/i);
  });

  it("creates receipts once with generation zero and reports the immutable generation", () => {
    const run = vi.fn((_command: string, args: readonly string[]) =>
      args.includes("describe") ? JSON.stringify({ generation: "8675309" }) : "",
    );
    const receipt = writeImmutableMigrationReceipt(
      "platform-builder-credential-reset/test.json",
      { schemaVersion: 1, kind: "test-receipt" },
      run,
    );

    expect(receipt).toEqual({
      uri: "gs://octogee-migration-receipts/receipts/platform-builder-credential-reset/test.json",
      generation: "8675309",
    });
    expect(run).toHaveBeenCalledWith("gcloud", expect.arrayContaining([
      "storage", "cp", "--if-generation-match=0",
      "gs://octogee-migration-receipts/receipts/platform-builder-credential-reset/test.json",
    ]));
  });

  it("reads the generation it described and validates exact receipt evidence", () => {
    const uri = "gs://octogee-migration-receipts/receipts/platform-builder-credential-reset/test.json";
    const run = vi.fn((_command: string, args: readonly string[]) => {
      if (args.includes("describe")) return JSON.stringify({ generation: "42" });
      return JSON.stringify({
        schemaVersion: 1,
        kind: "platform-region-cutover-builder-credential-reset-receipt",
        mode: "apply",
        targetId: "test-central",
        migrationId: "west-cutover-20260724",
        gitCommit: "a".repeat(40),
        cleanup: "verified",
        verified: true,
      });
    });

    expect(readImmutableMigrationReceipt(uri, {
      schemaVersion: 1,
      kind: "platform-region-cutover-builder-credential-reset-receipt",
      mode: "apply",
      targetId: "test-central",
      migrationId: "west-cutover-20260724",
      gitCommit: "a".repeat(40),
      cleanup: "verified",
      verified: true,
    }, run)).toMatchObject({ generation: "42" });
    expect(run).toHaveBeenLastCalledWith("gcloud", ["storage", "cat", `${uri}#42`]);
  });
});
