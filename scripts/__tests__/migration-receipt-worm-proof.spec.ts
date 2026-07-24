import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MIGRATION_RECEIPT_BUCKET,
  MIGRATION_RECEIPT_OPERATOR_MEMBERS,
  TERRAFORM_STATE_BUCKET,
  type CommandRunner,
} from "../lib/migration-receipts.js";
import { executeMigrationReceiptWormProof } from "../ops/prove-migration-receipt-worm.js";

describe("migration receipt WORM proof", () => {
  it("behaviorally proves collision, retention denials, and an unchanged single generation", () => {
    let generation: string | null = null;
    let md5Hash: string | null = null;
    let originalPayload: string | null = null;
    const calls: string[][] = [];
    const uri = `${MIGRATION_RECEIPT_BUCKET}/receipts/migration-receipt-worm-proof/test/2026-07-24t00-00-00-000z-proof-id.json`;
    const run: CommandRunner = (_command, args) => {
      calls.push([...args]);
      if (args.includes("get-iam-policy")) {
        return JSON.stringify({ bindings: [
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
          md5Hash = createHash("md5").update(originalPayload).digest("base64");
          return "";
        }
        if (args.includes("--if-generation-match=42")) {
          throw new Error("gcloud failed (1): retention policy prevents object replacement");
        }
      }
      if (args[0] === "storage" && args[1] === "objects" && args[2] === "describe") {
        return JSON.stringify({ generation, md5Hash });
      }
      if (args[0] === "storage" && args[1] === "rm") {
        throw new Error("gcloud failed (1): retention policy prevents exact-generation deletion");
      }
      if (args[0] === "storage" && args[1] === "ls") {
        return JSON.stringify([{
          url: `${uri}#42`,
          metadata: { generation, md5Hash },
        }]);
      }
      throw new Error(`unexpected command: ${args.join(" ")}`);
    };

    const result = executeMigrationReceiptWormProof([
      "--target=test",
      "--confirm=octogee/migration-receipt-worm-proof/test",
    ], {
      run,
      now: () => new Date("2026-07-24T00:00:00.000Z"),
      uuid: () => "proof-id",
    });

    expect(result).toEqual({
      target: "test",
      status: "verified",
      uri,
      generation: "42",
      md5Hash,
      createOnlyCollision: "verified",
      replacementRetentionDenial: "verified",
      exactGenerationDeleteRetentionDenial: "verified",
      originalObjectUnchanged: "verified",
      generationCount: 1,
    });
    expect(originalPayload).toContain('"secretFree":true');
    expect(calls).toContainEqual([
      "storage", "cp", "--if-generation-match=42", expect.any(String), uri,
    ]);
    expect(calls).toContainEqual(["storage", "rm", `${uri}#42`]);
    expect(calls).toContainEqual(["storage", "ls", "--all-versions", "--json", uri]);
  });
});
