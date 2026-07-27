import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../..");
const iamModule = path.join(repoRoot, "terraform/modules/iam/main.tf");
const centralPlatform = path.join(repoRoot, "terraform/environments/prod/main.tf");

describe("firebase deployer Terraform IAM", () => {
  it("grants the CI verifier the Firestore composite-index administrator role", () => {
    const source = readFileSync(iamModule, "utf-8");
    const firebaseDeployer = source.match(
      /resource "google_project_iam_member" "firebase_deployer" \{([\s\S]*?)^\}/m,
    );

    expect(firebaseDeployer?.[1]).toContain('"roles/datastore.indexAdmin"');
  });

  it("grants only the Central TEST Firebase deployer reader access to the active Central Artifact Registry", () => {
    const source = readFileSync(centralPlatform, "utf-8");
    const binding = source.match(
      /resource "google_artifact_registry_repository_iam_member" "firebase_deployer_test_central_reader" \{([\s\S]*?)^\}/m,
    );

    expect(binding?.[1]).toContain('project    = var.project_id');
    expect(binding?.[1]).toContain("location   = var.region");
    expect(binding?.[1]).toContain('repository = "octogee"');
    expect(binding?.[1]).toContain('role       = "roles/artifactregistry.reader"');
    expect(binding?.[1]).toContain(
      'member     = "serviceAccount:firebase-deployer@octogee-test.iam.gserviceaccount.com"',
    );
  });
});
