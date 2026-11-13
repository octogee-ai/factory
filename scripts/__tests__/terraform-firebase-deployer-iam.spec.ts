import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../..");
const iamModule = path.join(repoRoot, "terraform/modules/iam/main.tf");
const centralPlatform = path.join(repoRoot, "terraform/environments/prod/main.tf");
const prodVariables = path.join(repoRoot, "terraform/environments/prod/variables.tf");
const prodTfvars = path.join(repoRoot, "terraform/environments/prod/terraform.tfvars");
const testEnvironment = path.join(repoRoot, "terraform/environments/test/main.tf");
const testVariables = path.join(repoRoot, "terraform/environments/test/variables.tf");
const testTfvars = path.join(repoRoot, "terraform/environments/test/terraform.tfvars");

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
    for (const environment of [centralPlatform, testEnvironment]) {
      const moduleCall = readFileSync(environment, "utf-8").match(/^module "iam" \{([\s\S]*?)^\}/m)?.[1];
      expect(moduleCall, environment).toContain(
        'github_actions_principal_set = "principalSet://iam.googleapis.com/projects/94934561284/locations/global/workloadIdentityPools/github-actions/attribute.repository_id/1181841184"',
      );
    }
  });

  it("grants the CI verifier the Firestore composite-index administrator role", () => {
    const source = readFileSync(iamModule, "utf-8");
    const firebaseDeployer = source.match(
      /resource "google_project_iam_member" "firebase_deployer" \{([\s\S]*?)^\}/m,
    );

    expect(firebaseDeployer?.[1]).toContain('"roles/datastore.indexAdmin"');
  });

  it("allows the deployer and the exact GitHub repository pool to sign Firebase custom tokens", () => {
    const moduleSource = readFileSync(iamModule, "utf-8");
    const prodSource = readFileSync(centralPlatform, "utf-8");
    const testSource = readFileSync(testEnvironment, "utf-8");

    for (const source of [testSource, prodSource]) {
      const role = source.match(
        /resource "google_project_iam_custom_role" "firebase_custom_token_signer" \{([\s\S]*?)^\}/m,
      )?.[1];
      const selfBinding = source.match(
        /resource "google_service_account_iam_member" "firebase_deployer_self_custom_token_signer" \{([\s\S]*?)^\}/m,
      )?.[1];
      const githubActionsBinding = source.match(
        /resource "google_service_account_iam_member" "firebase_deployer_github_actions_custom_token_signer" \{([\s\S]*?)^\}/m,
      )?.[1];

      expect(role).toContain('role_id     = "octogeeFirebaseCustomTokenSigner"');
      expect(role).toContain('permissions = ["iam.serviceAccounts.signBlob"]');
      expect(selfBinding).toContain(
        'service_account_id = "projects/${var.project_id}/serviceAccounts/${module.iam.firebase_deployer_sa_email}"',
      );
      expect(selfBinding).toContain(
        "role               = google_project_iam_custom_role.firebase_custom_token_signer.id",
      );
      expect(selfBinding).toContain(
        'member             = "serviceAccount:${module.iam.firebase_deployer_sa_email}"',
      );
      expect(githubActionsBinding).toContain(
        'service_account_id = "projects/${var.project_id}/serviceAccounts/${module.iam.firebase_deployer_sa_email}"',
      );
      expect(githubActionsBinding).toContain(
        "role               = google_project_iam_custom_role.firebase_custom_token_signer.id",
      );
      expect(githubActionsBinding).toContain(
        "principalSet://iam.googleapis.com/projects/94934561284/locations/global/workloadIdentityPools/github-actions/attribute.repository_id/1181841184",
      );
      expect(source).not.toContain("roles/iam.serviceAccountTokenCreator");
    }
    expect(moduleSource).not.toContain("octogeeFirebaseCustomTokenSigner");
  });

  it("grants configured environment operators only the custom-token signing permission", () => {
    for (const paths of [
      { environment: centralPlatform, variables: prodVariables, tfvars: prodTfvars },
      { environment: testEnvironment, variables: testVariables, tfvars: testTfvars },
    ]) {
      const source = readFileSync(paths.environment, "utf-8");
      const variables = readFileSync(paths.variables, "utf-8");
      const tfvars = readFileSync(paths.tfvars, "utf-8");
      const binding = source.match(
        /resource "google_service_account_iam_member" "firebase_deployer_operator_custom_token_signer" \{([\s\S]*?)^\}/m,
      )?.[1];

      expect(variables).toContain('variable "firebase_custom_token_operator_members"');
      expect(binding).toContain("for_each           = var.firebase_custom_token_operator_members");
      expect(binding).toContain(
        'service_account_id = "projects/${var.project_id}/serviceAccounts/${module.iam.firebase_deployer_sa_email}"',
      );
      expect(binding).toContain(
        "role               = google_project_iam_custom_role.firebase_custom_token_signer.id",
      );
      expect(binding).toContain("member             = each.value");
      expect(tfvars).toContain(
        'firebase_custom_token_operator_members = ["user:christopher.k.eckert@squarepointconsulting.com"]',
      );
      expect(source).not.toContain("roles/iam.serviceAccountTokenCreator");
    }
  });

  it("grants every Central release Firebase deployer reader access to the Central Artifact Registry", () => {
    const source = readFileSync(centralPlatform, "utf-8");
    const bindings = [
      ["test", "octogee-test"],
      ["prod", "octogee"],
    ].map(([environment, project]) => {
      const binding = source.match(
        new RegExp(
          `resource "google_artifact_registry_repository_iam_member" "firebase_deployer_${environment}_central_reader" \\{([\\s\\S]*?)^\\}`,
          "m",
        ),
      );

      expect(binding?.[1]).toContain('project    = var.project_id');
      expect(binding?.[1]).toContain("location   = var.region");
      expect(binding?.[1]).toContain('repository = "octogee"');
      expect(binding?.[1]).toContain('role       = "roles/artifactregistry.reader"');
      expect(binding?.[1]).toContain(
        `member     = "serviceAccount:firebase-deployer@${project}.iam.gserviceaccount.com"`,
      );
      return binding;
    });

    expect(bindings).toHaveLength(2);
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
