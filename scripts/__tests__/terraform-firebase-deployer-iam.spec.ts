import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../..");
const iamModule = path.join(repoRoot, "terraform/modules/iam/main.tf");

describe("firebase deployer Terraform IAM", () => {
  it("grants the CI verifier the Firestore composite-index administrator role", () => {
    const source = readFileSync(iamModule, "utf-8");
    const firebaseDeployer = source.match(
      /resource "google_project_iam_member" "firebase_deployer" \{([\s\S]*?)^\}/m,
    );

    expect(firebaseDeployer?.[1]).toContain('"roles/datastore.indexAdmin"');
  });
});
