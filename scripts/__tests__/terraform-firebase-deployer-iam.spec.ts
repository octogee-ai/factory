import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../..");
const iamModule = path.join(repoRoot, "terraform/modules/iam/main.tf");

describe("firebase deployer Terraform IAM", () => {
  it("allows only the exact GitHub repository pool to federate as the deployer", () => {
    const source = readFileSync(iamModule, "utf-8");
    const binding = source.match(
      /resource "google_service_account_iam_member" "firebase_deployer_github_actions" \{([\s\S]*?)^\}/m,
    )?.[1];

    expect(binding).toContain("service_account_id = google_service_account.firebase_deployer.name");
    expect(binding).toContain('role               = "roles/iam.workloadIdentityUser"');
    expect(binding).toContain("member             = var.github_actions_principal_set");
    expect(source).not.toMatch(/projects\/\d+\//);
  });

  it("grants the CI verifier the Firestore composite-index administrator role", () => {
    const source = readFileSync(iamModule, "utf-8");
    const firebaseDeployer = source.match(
      /resource "google_project_iam_member" "firebase_deployer" \{([\s\S]*?)^\}/m,
    );

    expect(firebaseDeployer?.[1]).toContain('"roles/datastore.indexAdmin"');
  });

  it("limits Firebase deployer's secret policy authority to function-bound secrets", () => {
    const source = readFileSync(iamModule, "utf-8");
    const binding = source.match(
      /resource "google_project_iam_member" "firebase_deployer_secret_binding" \{([\s\S]*?)^\}/m,
    )?.[1];

    expect(binding).toContain("condition {");
    expect(binding).toContain("projects/${data.google_project.this.number}/secrets/DISCORD_OPS_WEBHOOK_URL");
    expect(binding).toContain("projects/${data.google_project.this.number}/secrets/SOCIAL_NOTIFICATION_BEARER_TOKEN");
    expect(binding).not.toContain("expression  = \"true\"");
    expect(source).not.toContain("secretmanager.versions.access");
  });
});
