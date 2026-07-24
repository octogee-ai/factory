import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MIGRATION_RECEIPT_BUCKET,
  MIGRATION_RECEIPT_BUCKET_CONTROL_ROLE,
  MIGRATION_RECEIPT_OPERATOR_MEMBERS,
  MIGRATION_RECEIPT_WORM_PROOF_PRINCIPAL,
  TERRAFORM_STATE_BUCKET,
  type CommandRunner,
} from "../lib/migration-receipts.js";
import { executeMigrationReceiptWormProof } from "../ops/prove-migration-receipt-worm.js";

const uri = `${MIGRATION_RECEIPT_BUCKET}/receipts/migration-receipt-worm-proof/test/2026-07-24t00-00-00-000z-proof-id.json`;

function proofHarness(mutationDenial: "retention" | "permission" = "retention") {
  let generation: string | null = null;
  let md5Hash: string | null = null;
  let originalPayload: string | null = null;
  const calls: string[][] = [];
  const run: CommandRunner = (_command, args) => {
    calls.push([...args]);
    if (args[0] === "config" && args[1] === "get-value") {
      return args.at(-1) === "account"
        ? "christopher.k.eckert@squarepointconsulting.com\n"
        : "(unset)\n";
    }
    if (args[0] === "storage" && args.includes("get-iam-policy")) {
      return JSON.stringify({ bindings: [
        { role: MIGRATION_RECEIPT_BUCKET_CONTROL_ROLE, members: MIGRATION_RECEIPT_OPERATOR_MEMBERS },
        { role: "roles/storage.objectCreator", members: MIGRATION_RECEIPT_OPERATOR_MEMBERS },
        { role: "roles/storage.objectViewer", members: MIGRATION_RECEIPT_OPERATOR_MEMBERS },
      ] });
    }
    if (args[0] === "storage" && args[1] === "buckets" && args[2] === "describe") {
      if (args.includes(TERRAFORM_STATE_BUCKET)) {
        return JSON.stringify({
          iamConfiguration: {
            uniformBucketLevelAccess: { enabled: true },
            publicAccessPrevention: "enforced",
          },
          versioning: { enabled: true },
          softDeletePolicy: { retentionDurationSeconds: "604800" },
        });
      }
      return JSON.stringify({
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
      });
    }
    if (args[0] === "storage" && args[1] === "cp") {
      const source = args.at(-2)!;
      if (args.includes("--if-generation-match=0")) {
        if (generation !== null) {
          throw new Error("gcloud failed (1): HTTP 412 conditionNotMet: ifGenerationMatch");
        }
        originalPayload = readFileSync(source, "utf8");
        generation = "42";
        md5Hash = "dGVzdC1yZWNlaXB0";
        return "";
      }
      if (args.includes("--if-generation-match=42")) {
        throw new Error(mutationDenial === "retention"
          ? "gcloud failed (1): retention policy prevents object replacement"
          : "gcloud failed (1): permission denied");
      }
    }
    if (args[0] === "storage" && args[1] === "objects" && args[2] === "describe") {
      return JSON.stringify({ generation, md5Hash });
    }
    if (args[0] === "storage" && args[1] === "rm") {
      throw new Error(mutationDenial === "retention"
        ? "gcloud failed (1): retention policy prevents exact-generation deletion"
        : "gcloud failed (1): permission denied");
    }
    if (args[0] === "storage" && args[1] === "ls") {
      return JSON.stringify([{
        url: `${uri}#42`,
        metadata: { generation, md5Hash },
      }]);
    }
    throw new Error(`unexpected command: ${args.join(" ")}`);
  };
  return {
    calls,
    run,
    getMd5Hash: () => md5Hash,
    getOriginalPayload: () => originalPayload,
  };
}

describe("migration receipt WORM proof", () => {
  it("behaviorally proves collision, retention denials, and an unchanged single generation", () => {
    const harness = proofHarness();

    const result = executeMigrationReceiptWormProof([
      "--target=test",
      "--confirm=octogee/migration-receipt-worm-proof/test",
    ], {
      run: harness.run,
      now: () => new Date("2026-07-24T00:00:00.000Z"),
      uuid: () => "proof-id",
    });

    expect(result).toEqual({
      target: "test",
      status: "verified",
      uri,
      generation: "42",
      md5Hash: harness.getMd5Hash(),
      createOnlyCollision: "verified",
      replacementRetentionDenial: "verified",
      exactGenerationDeleteRetentionDenial: "verified",
      originalObjectUnchanged: "verified",
      generationCount: 1,
    });
    expect(harness.getOriginalPayload()).toContain('"secretFree":true');
    expect(harness.getOriginalPayload()).toContain(
      `"proofAuthority":{"principal":"${MIGRATION_RECEIPT_WORM_PROOF_PRINCIPAL}","bucket":"${MIGRATION_RECEIPT_BUCKET}","role":"${MIGRATION_RECEIPT_BUCKET_CONTROL_ROLE}"}`,
    );
    expect(harness.calls).toContainEqual([
      "storage", "cp", "--if-generation-match=42", expect.any(String), uri,
    ]);
    expect(harness.calls).toContainEqual([
      "storage", "objects", "describe", uri, "--format=json", "--raw",
    ]);
    expect(harness.calls.filter((call) =>
      JSON.stringify(call) === JSON.stringify([
        "storage", "objects", "describe", `${uri}#42`, "--format=json", "--raw",
      ]))).toHaveLength(2);
    expect(harness.calls).toContainEqual(["storage", "rm", `${uri}#42`]);
    expect(harness.calls).toContainEqual(["storage", "ls", "--all-versions", "--json", uri]);
  });

  it("does not misreport a least-privilege IAM denial as a retention proof", () => {
    const harness = proofHarness("permission");

    expect(() => executeMigrationReceiptWormProof([
      "--target=test",
      "--confirm=octogee/migration-receipt-worm-proof/test",
    ], {
      run: harness.run,
      now: () => new Date("2026-07-24T00:00:00.000Z"),
      uuid: () => "proof-id",
    })).toThrow("did not fail specifically because of retention");
  });
});
