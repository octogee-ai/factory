import { describe, expect, it, vi } from "vitest";
import {
  MIGRATION_RECEIPT_OPERATOR_MEMBERS,
  MIGRATION_RECEIPT_BUCKET,
  MigrationReceiptCollisionError,
  TERRAFORM_STATE_BUCKET,
  assertMigrationReceiptBucket,
  immutableMigrationReceiptUri,
  readImmutableMigrationReceipt,
  writeImmutableMigrationReceipt,
} from "../lib/migration-receipts.js";

describe("immutable migration receipts", () => {
  const receiptBucket = {
    location: "US-WEST1",
    storageClass: "STANDARD",
    iamConfiguration: {
      uniformBucketLevelAccess: { enabled: true },
      publicAccessPrevention: "enforced",
    },
    versioning: { enabled: false },
    retentionPolicy: { retentionPeriod: "34560000", isLocked: true },
    softDeletePolicy: { retentionDurationSeconds: "0" },
    lifecycle: {
      rule: [{ action: { type: "Delete" }, condition: { age: 400 } }],
    },
  };
  const receiptPolicy = {
    bindings: [
      {
        role: "roles/storage.objectCreator",
        members: MIGRATION_RECEIPT_OPERATOR_MEMBERS,
      },
      {
        role: "roles/storage.objectViewer",
        members: MIGRATION_RECEIPT_OPERATOR_MEMBERS,
      },
    ],
  };
  const terraformStateBucket = {
    iamConfiguration: {
      uniformBucketLevelAccess: { enabled: true },
      publicAccessPrevention: "enforced",
    },
    versioning: { enabled: true },
    softDeletePolicy: { retentionDurationSeconds: "604800" },
  };

  function postureRunner(
    dedicated = receiptBucket,
    policy = receiptPolicy,
    state = terraformStateBucket,
  ) {
    return vi.fn((_command: string, args: readonly string[]) => {
      if (args.includes("get-iam-policy")) return JSON.stringify(policy);
      if (args.includes(TERRAFORM_STATE_BUCKET)) return JSON.stringify(state);
      return JSON.stringify(dedicated);
    });
  }

  it("uses only the dedicated receipt bucket and path-safe object names", () => {
    expect(MIGRATION_RECEIPT_BUCKET).toBe("gs://octogee-migration-receipts");
    expect(immutableMigrationReceiptUri("platform-builder-credential-reset/test.json"))
      .toBe("gs://octogee-migration-receipts/receipts/platform-builder-credential-reset/test.json");
    expect(() => immutableMigrationReceiptUri("../state.tfstate")).toThrow(/path-safe/i);
  });

  it("accepts only the full dedicated and Terraform-state bucket posture", () => {
    const run = postureRunner();

    expect(() => assertMigrationReceiptBucket(run)).not.toThrow();
    expect(run).toHaveBeenCalledWith("gcloud", [
      "storage", "buckets", "describe", MIGRATION_RECEIPT_BUCKET, "--format=json",
    ]);
    expect(run).toHaveBeenCalledWith("gcloud", [
      "storage", "buckets", "describe", TERRAFORM_STATE_BUCKET, "--format=json",
    ]);
    const { versioning: _disabledVersioning, ...withoutVersioning } = receiptBucket;
    expect(() => assertMigrationReceiptBucket(postureRunner(withoutVersioning))).not.toThrow();
  });

  it("rejects dedicated-bucket lifecycle, versioning, and exact IAM drift", () => {
    expect(() => assertMigrationReceiptBucket(postureRunner({
      ...receiptBucket,
      lifecycle: { rule: [] },
    }))).toThrow(/lifecycle/i);
    expect(() => assertMigrationReceiptBucket(postureRunner({
      ...receiptBucket,
      versioning: { enabled: true },
    }))).toThrow(/versioning.*disabled/i);
    expect(() => assertMigrationReceiptBucket(postureRunner(
      receiptBucket,
      {
        bindings: [
          ...receiptPolicy.bindings,
          { role: "roles/storage.objectAdmin", members: MIGRATION_RECEIPT_OPERATOR_MEMBERS },
        ],
      },
    ))).toThrow(/exact roles/i);
    expect(() => assertMigrationReceiptBucket(postureRunner(
      receiptBucket,
      {
        bindings: receiptPolicy.bindings.map((binding) => ({
          ...binding,
          members: ["user:someone-else@example.com"],
        })),
      },
    ))).toThrow(/exact members/i);
  });

  it("rejects mutable or retention-locked Terraform state posture", () => {
    expect(() => assertMigrationReceiptBucket(postureRunner(
      receiptBucket,
      receiptPolicy,
      { ...terraformStateBucket, versioning: { enabled: false } },
    ))).toThrow(/Terraform state.*versioning/i);
    expect(() => assertMigrationReceiptBucket(postureRunner(
      receiptBucket,
      receiptPolicy,
      { ...terraformStateBucket, retentionPolicy: { retentionPeriod: "1" } },
    ))).toThrow(/Terraform state.*retention policy/i);
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

  it("maps only create-only precondition failures to an explicit collision", () => {
    const collision = vi.fn((_command: string, args: readonly string[]) => {
      if (args.includes("cp")) {
        throw new Error("gcloud failed (1): HTTP 412 conditionNotMet: ifGenerationMatch");
      }
      return "";
    });
    try {
      writeImmutableMigrationReceipt(
        "platform-builder-credential-reset/test.json",
        { schemaVersion: 1, kind: "test-receipt" },
        collision,
      );
      throw new Error("expected collision");
    } catch (error) {
      expect(error).toBeInstanceOf(MigrationReceiptCollisionError);
      expect(error).toMatchObject({
        code: "MIGRATION_RECEIPT_COLLISION",
        uri: "gs://octogee-migration-receipts/receipts/platform-builder-credential-reset/test.json",
      });
    }

    const denied = vi.fn(() => {
      throw new Error("gcloud failed (1): permission denied");
    });
    expect(() => writeImmutableMigrationReceipt(
      "platform-builder-credential-reset/test.json",
      { schemaVersion: 1, kind: "test-receipt" },
      denied,
    )).toThrow(/permission denied/i);
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
