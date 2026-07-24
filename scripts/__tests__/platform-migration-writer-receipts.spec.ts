import { describe, expect, it, vi } from "vitest";
import {
  assertRequiredMigrationReceipts,
  platformMigrationWriterReceiptUri,
  readPlatformMigrationWriterReceipt,
  writePlatformMigrationWriterReceipt,
} from "../ops/quiesce-platform-migration-writers.js";

const migrationId = "west-cutover-20260724";
const revision = "a".repeat(40);
const quiescenceReceipt = {
  schemaVersion: 1 as const,
  kind: "platform-migration-writer-quiescence-receipt" as const,
  targetId: "test-west" as const,
  partnerTargetId: "test-central" as const,
  migrationId,
  revision,
  priorMaintenance: null,
  writerWorkloads: [{
    kind: "Deployment" as const,
    name: "octogee-api",
    replicas: 1,
    containers: ["octogee-api"],
  }],
};

describe("platform migration writer receipt adapter", () => {
  it("writes and reads the quiescence receipt through create-only, generation-bound storage", () => {
    const uri = platformMigrationWriterReceiptUri(quiescenceReceipt);
    expect(uri).toBe(
      `gs://octogee-migration-receipts/receipts/platform-migration-writer-quiescence/${migrationId}/test-west.json`,
    );
    const run = vi.fn((_command: string, args: readonly string[]) => {
      if (args.includes("describe")) return JSON.stringify({ generation: "7" });
      if (args.includes("cat")) return JSON.stringify(quiescenceReceipt);
      return "";
    });

    writePlatformMigrationWriterReceipt(uri, quiescenceReceipt, run);
    expect(run).toHaveBeenCalledWith("gcloud", expect.arrayContaining([
      "storage", "cp", "--if-generation-match=0", uri,
    ]));
    expect(readPlatformMigrationWriterReceipt(uri, run)).toEqual(quiescenceReceipt);
    expect(run).toHaveBeenLastCalledWith("gcloud", ["storage", "cat", `${uri}#7`]);
  });

  it("reads exact content and Firebase evidence from pinned generations in the dedicated bucket", () => {
    const contentUri =
      `gs://octogee-migration-receipts/receipts/platform-content-migration/test-central-to-test-west/${migrationId}.json`;
    const firebaseUri =
      `gs://octogee-migration-receipts/receipts/platform-firestore-auth-west-migration/${migrationId}-test-central-test-west-${revision}-complete.json`;
    const content = {
      schemaVersion: 1,
      kind: "platform-content-migration-receipt",
      migrationId,
      source: "test-central",
      target: "test-west",
      revision,
      completedAt: "2026-07-24T00:00:00.000Z",
      verified: true,
      services: [
        { service: "mattermost", files: { digest: "a" }, database: "mattermost_test" },
        { service: "gitea", files: { digest: "b" }, database: "gitea_test" },
      ],
    };
    const firebase = {
      schemaVersion: 1,
      kind: "platform-firestore-auth-west-migration-receipt",
      mode: "apply",
      verified: true,
      migrationId,
      sourceTargetId: "test-central",
      targetTargetId: "test-west",
      gitCommit: revision,
    };
    const run = vi.fn((_command: string, args: readonly string[]) => {
      if (args.includes("ls")) return firebaseUri;
      if (args.includes("describe")) return JSON.stringify({ generation: "9" });
      if (args.includes("cat")) {
        return JSON.stringify(args.at(-1) === `${contentUri}#9` ? content : firebase);
      }
      throw new Error(`unexpected command: ${args.join(" ")}`);
    });

    expect(() => assertRequiredMigrationReceipts(quiescenceReceipt, run)).not.toThrow();
    expect(run).toHaveBeenCalledWith("gcloud", ["storage", "cat", `${contentUri}#9`]);
    expect(run).toHaveBeenCalledWith("gcloud", ["storage", "cat", `${firebaseUri}#9`]);
  });
});
