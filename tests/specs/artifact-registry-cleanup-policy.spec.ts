import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

type CleanupPolicy = {
  name: string;
  action: { type: string };
  condition?: {
    tagState?: string;
    olderThan?: string;
  };
};

const repoRoot = resolve(import.meta.dirname, "../..");
const policies = JSON.parse(
  readFileSync(resolve(repoRoot, "platform/scripts/ops/ar-cleanup-policy.json"), "utf8"),
) as CleanupPolicy[];

describe("Artifact Registry cleanup policy", () => {
  it("never automatically deletes tagged image versions", () => {
    const deletePolicies = policies.filter((policy) => policy.action.type === "Delete");

    expect(deletePolicies.length).toBeGreaterThan(0);
    expect(deletePolicies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          condition: expect.objectContaining({
            tagState: "untagged",
            olderThan: "1209600s",
          }),
        }),
      ]),
    );
    expect(deletePolicies.every((policy) => policy.condition?.tagState === "untagged")).toBe(true);
  });
});
