import { describe, expect, it, vi } from "vitest";
import {
  MIGRATION_RECEIPT_OPERATOR_MEMBERS,
  MIGRATION_RECEIPT_BUCKET_CONTROL_ROLE,
  MIGRATION_RECEIPT_BUCKET,
  RETIRED_MIGRATION_RECEIPT_BUCKET,
  MIGRATION_RECEIPT_WORM_PROOF_PRINCIPAL,
  MigrationReceiptCollisionError,
  TERRAFORM_STATE_BUCKET,
  assertMigrationReceiptBucket,
  assertMigrationReceiptWormProofAuthority,
  immutableMigrationReceiptUri,
  readImmutableMigrationReceipt,
  runMigrationReceiptCommand,
  writeImmutableMigrationReceipt,
} from "../lib/migration-receipts.js";

describe("immutable migration receipts", () => {
  const receiptBucket = {
    location: "US-CENTRAL1",
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
        role: "roles/storage.legacyBucketOwner",
        members: MIGRATION_RECEIPT_OPERATOR_MEMBERS,
      },
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
    expect(MIGRATION_RECEIPT_BUCKET).toBe("gs://octogee-central-migration-receipts");
    expect(immutableMigrationReceiptUri("platform-builder-credential-reset/test.json"))
      .toBe("gs://octogee-central-migration-receipts/receipts/platform-builder-credential-reset/test.json");
    expect(() => immutableMigrationReceiptUri("../state.tfstate")).toThrow(/path-safe/i);
  });

  it("accepts only the full dedicated and Terraform-state bucket posture", () => {
    const run = postureRunner();

    expect(() => assertMigrationReceiptBucket(run)).not.toThrow();
    expect(run).toHaveBeenCalledWith("gcloud", [
      "storage", "buckets", "describe", MIGRATION_RECEIPT_BUCKET, "--format=json", "--raw",
    ]);
    expect(run).toHaveBeenCalledWith("gcloud", [
      "storage", "buckets", "describe", TERRAFORM_STATE_BUCKET, "--format=json", "--raw",
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
          ...receiptPolicy.bindings.filter((binding) => binding.role !== "roles/storage.legacyBucketOwner"),
        ],
      },
    ))).toThrow(/roles\/storage\.legacyBucketOwner/i);
    expect(() => assertMigrationReceiptBucket(postureRunner(
      receiptBucket,
      {
        bindings: receiptPolicy.bindings.map((binding) => ({
          ...binding,
          members: ["user:someone-else@example.com"],
        })),
      },
    ))).toThrow(/exact members/i);
    expect(() => assertMigrationReceiptBucket(postureRunner(
      receiptBucket,
      {
        bindings: receiptPolicy.bindings.map((binding) => ({
          ...binding,
          condition: {
            title: "unexpected",
            expression: "request.time < timestamp('2026-07-25T00:00:00Z')",
          },
        })),
      },
    ))).toThrow(/unconditional/i);
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

  it("requires the explicit bucket controller as the non-impersonated WORM proof principal", () => {
    const run = vi.fn((_command: string, args: readonly string[]) => {
      if (args.includes("get-value")) {
        return args.at(-1) === "account"
          ? "christopher.k.eckert@squarepointconsulting.com\n"
          : "(unset)\n";
      }
      return "";
    });

    expect(assertMigrationReceiptWormProofAuthority(run)).toEqual({
      principal: MIGRATION_RECEIPT_WORM_PROOF_PRINCIPAL,
      bucket: MIGRATION_RECEIPT_BUCKET,
      role: MIGRATION_RECEIPT_BUCKET_CONTROL_ROLE,
    });

    const wrongPrincipal = vi.fn((_command: string, args: readonly string[]) => {
      if (args.includes("get-value")) {
        return args.at(-1) === "account"
          ? "someone-else@example.com\n"
          : "(unset)\n";
      }
      return "";
    });
    expect(() => assertMigrationReceiptWormProofAuthority(wrongPrincipal))
      .toThrow(/bucket controller proof principal/i);

    const impersonated = vi.fn((_command: string, args: readonly string[]) => {
      if (args.includes("get-value")) {
        if (args.at(-1) === "account") {
          return "christopher.k.eckert@squarepointconsulting.com\n";
        }
        return args.at(-1) === "auth/impersonate_service_account"
          ? "other-owner@example.test\n"
          : "(unset)\n";
      }
      return "";
    });
    expect(() => assertMigrationReceiptWormProofAuthority(impersonated))
      .toThrow(/configured gcloud authority override/i);
  });

  it("clears gcloud authority overrides while preserving the selected Cloud SDK config", () => {
    const names = [
      "CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE",
      "CLOUDSDK_AUTH_ACCESS_TOKEN_FILE",
      "CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT",
      "CLOUDSDK_CORE_ACCOUNT",
      "CLOUDSDK_CONFIG",
    ] as const;
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    try {
      process.env.CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE = "/hostile/credentials.json";
      process.env.CLOUDSDK_AUTH_ACCESS_TOKEN_FILE = "/hostile/access-token";
      process.env.CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT = "hostile@example.test";
      process.env.CLOUDSDK_CORE_ACCOUNT = "hostile@example.test";
      process.env.CLOUDSDK_CONFIG = "/intended/operator-config";

      const output = runMigrationReceiptCommand("/usr/bin/env", []);

      expect(output).toContain("CLOUDSDK_CONFIG=/intended/operator-config");
      expect(output).not.toContain("CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE=");
      expect(output).not.toContain("CLOUDSDK_AUTH_ACCESS_TOKEN_FILE=");
      expect(output).not.toContain("CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT=");
      expect(output).not.toContain("CLOUDSDK_CORE_ACCOUNT=");
    } finally {
      for (const name of names) {
        const value = previous[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
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
      uri: "gs://octogee-central-migration-receipts/receipts/platform-builder-credential-reset/test.json",
      generation: "8675309",
    });
    expect(run).toHaveBeenCalledWith("gcloud", expect.arrayContaining([
      "storage", "cp", "--if-generation-match=0",
      "gs://octogee-central-migration-receipts/receipts/platform-builder-credential-reset/test.json",
    ]));
    expect(run).toHaveBeenCalledWith("gcloud", [
      "storage",
      "objects",
      "describe",
      "gs://octogee-central-migration-receipts/receipts/platform-builder-credential-reset/test.json",
      "--format=json",
      "--raw",
    ]);
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
        uri: "gs://octogee-central-migration-receipts/receipts/platform-builder-credential-reset/test.json",
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
    const uri = `${RETIRED_MIGRATION_RECEIPT_BUCKET}/receipts/platform-builder-credential-reset/test.json`;
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
    expect(run).toHaveBeenCalledWith("gcloud", [
      "storage", "objects", "describe", uri, "--format=json", "--raw",
    ]);
    expect(run).toHaveBeenLastCalledWith("gcloud", ["storage", "cat", `${uri}#42`]);
  });
});
