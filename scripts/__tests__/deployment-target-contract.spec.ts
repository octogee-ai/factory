import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");

function source(path: string): string {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

describe("deployment target consumers", () => {
  it("resolves regional values in every deployment workflow", () => {
    const workflows = [
      ".github/workflows/build-and-deploy.yml",
      ".github/workflows/gateway-build-operator-base.yml",
      ".github/workflows/site.yml",
      ".github/workflows/trivy-images.yml",
    ];

    for (const workflow of workflows) {
      const contents = source(workflow);
      expect(contents, workflow).toContain("./.github/actions/resolve-deployment-target");
      expect(contents, workflow).not.toContain("us-central1");
      expect(contents, workflow).not.toContain("gke_octogee_");
      expect(contents, workflow).not.toContain("-docker.pkg.dev/octogee/octogee");
    }
  });

  it("keeps the reusable target action free of a regional fallback", () => {
    const contents = source(".github/actions/resolve-deployment-target/action.yml");
    expect(contents).toContain("core/dist/resolve-deployment-target.js");
    expect(contents).toContain("does not belong to requested environment");
    expect(contents).not.toContain("us-central1");
    expect(contents).not.toContain("us-west1");
  });

  it("lets release workflows select a reviewed candidate target explicitly", () => {
    for (const workflow of [
      ".github/workflows/releasev2.yml",
      ".github/workflows/build-and-deploy.yml",
      ".github/workflows/gateway-build-operator-base.yml",
      ".github/workflows/site.yml",
    ]) {
      expect(source(workflow), workflow).toContain("deployment_target");
    }
  });

  it("passes the selected registry location into every Cloud Build", () => {
    const platform = source(".github/workflows/build-and-deploy.yml");
    const gateway = source(".github/workflows/gateway-build-operator-base.yml");
    const pinnedGateway = source("scripts/build-pinned-gateway.sh");
    const matrixBases = source("scripts/rebuild-matrix-bases.sh");

    expect(platform.match(/_REGION=\$\{\{ steps\.target\.outputs\.artifact_registry_location \}\}/g))
      .toHaveLength(5);
    expect(gateway.match(/_REGION=\$\{\{ needs\.matrix-setup\.outputs\.ar_location \}\}/g))
      .toHaveLength(7);
    expect(pinnedGateway).toContain("_REGION=${TARGET_AR_LOCATION}");
    expect(matrixBases).toContain("_REGION=${TARGET_AR_LOCATION}");

    for (const config of [
      "artifact-worker/cloudbuild.yaml",
      "cloudbuild-base-beta.yaml",
      "cloudbuild-base.yaml",
      "cloudbuild-gateway-candidate.yaml",
      "cloudbuild-operator-base-extra.yaml",
      "cloudbuild-operator-base.yaml",
      "cloudbuild-operator-final-extra.yaml",
      "cloudbuild-operator-final.yaml",
      "cloudbuild-operator-toolkit.yaml",
      "cloudbuild.yaml",
      "gateway-edge/cloudbuild-candidate.yaml",
      "gateway-edge/cloudbuild.yaml",
      "glm-controller/cloudbuild.yaml",
      "octogee-api/cloudbuild.yaml",
      "ops-agent/cloudbuild.yaml",
    ]) {
      expect(source(config), config).not.toContain('  _REGION: "us-central1"');
    }
  });

  it("passes the selected region into every platform Cloud Build waiter", () => {
    const platform = source(".github/workflows/build-and-deploy.yml");

    expect(platform.match(/--region="\$\{\{ steps\.target\.outputs\.region \}\}"/g))
      .toHaveLength(5);
  });

  it("passes exact targets into promotion and secret preflight", () => {
    const gateway = source(".github/workflows/gateway-build-operator-base.yml");
    const platform = source(".github/workflows/build-and-deploy.yml");
    const verifySecrets = source("scripts/verify-secrets.sh");

    expect(gateway).toContain('--deployment-target="${DEPLOYMENT_TARGET}"');
    expect(platform).toContain(
      "--deployment-target=${{ steps.target.outputs.target_id }}",
    );
    expect(verifySecrets).toContain("--deployment-target=*)");
    expect(verifySecrets).toContain('octogee_load_deployment_target "--target=$DEPLOYMENT_TARGET"');
  });

  it("lets canonical bootstrap and base-image tools select candidate targets", () => {
    for (const script of [
      "scripts/setup-secrets.sh",
      "scripts/setup-mattermost.sh",
      "scripts/setup-gitea.sh",
    ]) {
      const contents = source(script);
      expect(contents, script).toContain("--deployment-target=*)");
      expect(contents, script).toContain(
        'octogee_load_deployment_target "--target=$DEPLOYMENT_TARGET"',
      );
      expect(contents, script).toContain("does not belong to environment");
    }

    const workflow = source(".github/workflows/gateway-base-rebuild.yml");
    const script = source("scripts/rebuild-matrix-bases.sh");
    expect(workflow).toContain("deployment_target:");
    expect(workflow).toContain("./.github/actions/resolve-deployment-target");
    expect(workflow).toContain('--deployment-target="${{ steps.target.outputs.target_id }}"');
    expect(script).toContain("--deployment-target=*)");
    expect(script).toContain('octogee_load_deployment_target "--target=$DEPLOYMENT_TARGET"');
  });

  it("selects public Firebase credentials by exact deployment target", () => {
    const workflow = source(".github/workflows/site.yml");
    const gateway = source(".github/workflows/gateway-build-operator-base.yml");

    expect(workflow).toContain('case "${{ steps.target.outputs.target_id }}" in');
    expect(workflow).toContain("PUBLIC_FIREBASE_API_KEY_TEST_WEST");
    expect(workflow).toContain("PUBLIC_FIREBASE_API_KEY_PROD_WEST");
    expect(workflow).toContain("PUBLIC_MM_TEAM_ID_TEST_WEST");
    expect(workflow).toContain("PUBLIC_MM_TEAM_ID_PROD_WEST");
    expect(workflow).toContain("FIREBASE_DEPLOYER_KEY_TEST_WEST");
    expect(workflow).toContain("FIREBASE_DEPLOYER_KEY_PROD_WEST");
    expect(gateway).toContain("FIREBASE_DEPLOYER_KEY_TEST_WEST");
    expect(gateway).toContain("FIREBASE_DEPLOYER_KEY_PROD_WEST");
    expect(workflow).toContain(
      "for value_name in api_key app_id sender_id mm_team_id; do",
    );
    expect(workflow).not.toContain(
      "for value_name in api_key app_id sender_id measurement_id mm_team_id; do",
    );
    expect(workflow).toContain("No Firebase deployer key slot for deployment target");
    expect(gateway).toContain("No Firebase deployer key slot for deployment target");
  });

  it("does not embed the active cluster context in fleet operations", () => {
    for (const script of [
      "scripts/ops/fleet.ts",
      "scripts/ops/set-glm-maintenance.ts",
    ]) {
      expect(source(script), script).not.toContain(
        "gke_octogee_us-central1_octogee-gateway",
      );
    }
  });

  it("loads setup and verification topology from the shell target contract", () => {
    for (const script of [
      "scripts/setup-secrets.sh",
      "scripts/setup-mattermost.sh",
      "scripts/setup-gitea.sh",
      "scripts/verify-env.sh",
      "scripts/verify-secrets.sh",
      "scripts/provision-namespace.sh",
      "scripts/rotate-secret.sh",
      "scripts/teardown-env.sh",
      "scripts/setup-cloud-sql.sh",
      "scripts/build-pinned-gateway.sh",
      "scripts/rebuild-matrix-bases.sh",
      "scripts/shell-gateway.sh",
      "scripts/shell-gateway-ui.sh",
      "scripts/setup-monitoring.sh",
      "scripts/setup-monitoring-iap.sh",
      "scripts/setup-deprovision-iam.sh",
      "scripts/fix-functions-iam.sh",
      "scripts/ops/reconcile-coach-names.sh",
      "scripts/ops/reconcile-gitea-org.sh",
      "scripts/ops/migrate-secrets-single-region.sh",
    ]) {
      const contents = source(script);
      expect(contents, script).toContain("lib/deployment-target.sh");
      expect(contents, script).not.toContain("us-central1");
      expect(contents, script).not.toContain("gke_octogee_");
      expect(contents, script).not.toContain("-docker.pkg.dev/octogee/octogee");
    }
  });

  it("enforces the Cloud SQL recovery policy declared by the selected target", () => {
    const setup = source("scripts/setup-cloud-sql.sh");
    expect(setup).toContain('DESIRED_PITR="$TARGET_CLOUD_SQL_PITR_ENABLED"');
    expect(setup).not.toContain('DESIRED_PITR="false"');
  });

  it("reserves central and west deployment namespaces from custom provisioning", () => {
    const provision = source("scripts/provision-namespace.sh");
    const terraform = source("terraform/environments/custom/variables.tf");

    for (const namespace of ["octogee", "octogee-test", "octogee-west", "octogee-test-west"]) {
      expect(provision).toContain(namespace);
      expect(terraform).toContain(`"${namespace}"`);
    }
  });

  it("keeps west Cloud SQL bootstrap away from central Secret Manager slots", () => {
    const setupCloudSql = source("scripts/setup-cloud-sql.sh");
    const setupSecrets = source("scripts/setup-secrets.sh");
    const setupMattermost = source("scripts/setup-mattermost.sh");
    const provisionNamespace = source("scripts/provision-namespace.sh");
    const platformWorkflow = source(".github/workflows/build-and-deploy.yml");

    expect(setupCloudSql).toContain('MATTERMOST_PASSWORD_SECRET="$TARGET_CLOUD_SQL_MATTERMOST_PASSWORD_SECRET"');
    expect(setupCloudSql).toContain('GITEA_PASSWORD_SECRET="$TARGET_CLOUD_SQL_GITEA_PASSWORD_SECRET"');
    expect(setupCloudSql).toContain('CONNECTION_NAME_SECRET="$TARGET_CLOUD_SQL_CONNECTION_NAME_SECRET"');
    expect(setupSecrets).toContain('sm_get "$TARGET_CLOUD_SQL_MATTERMOST_PASSWORD_SECRET" "$SM_PROJECT"');
    expect(setupSecrets).toContain('sm_get "$TARGET_CLOUD_SQL_GITEA_PASSWORD_SECRET" "$SM_PROJECT"');
    expect(setupMattermost).toContain('--secret="$TARGET_CLOUD_SQL_MATTERMOST_PASSWORD_SECRET"');
    expect(setupMattermost).toContain('--instance="$TARGET_CLOUD_SQL_INSTANCE"');
    expect(provisionNamespace).toContain('MM_DB_PASSWORD_SECRET="$TARGET_CLOUD_SQL_MATTERMOST_PASSWORD_SECRET"');
    expect(provisionNamespace).toContain('GITEA_DB_PASSWORD_SECRET="$TARGET_CLOUD_SQL_GITEA_PASSWORD_SECRET"');
    expect(platformWorkflow).toContain('steps.target.outputs.cloud_sql_gitea_password_secret_name');
  });

  it("scopes internal bootstrap credentials to the exact target", () => {
    const setupSecrets = source("scripts/setup-secrets.sh");
    const setupGitea = source("scripts/setup-gitea.sh");

    expect(setupSecrets).toContain('INTERNAL_SECRET_SUFFIX="$TARGET_SECRET_NAME_SUFFIX"');
    expect(setupSecrets).toContain('GITEA_API_TOKEN_SM_KEY="gitea-api-token-${INTERNAL_SECRET_SUFFIX}"');
    expect(setupSecrets).toContain('GITEA_ADMIN_PASSWORD_SM_KEY="gitea-admin-password-${INTERNAL_SECRET_SUFFIX}"');
    expect(setupSecrets).not.toContain('gitea-api-token-${ENV}');
    expect(setupGitea).toContain('GITEA_API_TOKEN_SM_KEY="gitea-api-token-${TARGET_SECRET_NAME_SUFFIX}"');
    expect(setupGitea).toContain('GITEA_ADMIN_PASSWORD_SM_KEY="gitea-admin-password-${TARGET_SECRET_NAME_SUFFIX}"');
    expect(setupGitea).not.toContain('gitea-api-token-${ENV}');
  });

  it("preserves exact targets through the canonical bootstrap handoff", () => {
    for (const script of [
      "scripts/setup-secrets.sh",
      "scripts/setup-mattermost.sh",
      "scripts/setup-gitea.sh",
    ]) {
      expect(source(script), script).toContain('TARGET_ARG=" --deployment-target=$TARGET_ID"');
    }

    const teardown = source("scripts/teardown-env.sh");
    expect(teardown).toContain("--deployment-target=*)");
    expect(teardown).toContain('octogee_load_deployment_target "--target=$DEPLOYMENT_TARGET"');
    expect(teardown).toContain('./scripts/setup-cloud-sql.sh --target=$TARGET_ID');
    expect(teardown).toContain('TARGET_ARG=" --deployment-target=$TARGET_ID"');
  });

  it("selects candidate data and cluster targets in canonical finalizers", () => {
    for (const script of [
      "scripts/setup-firestore-ttls.sh",
      "scripts/verify-env.sh",
    ]) {
      const contents = source(script);
      expect(contents, script).toContain("--deployment-target=*)");
      expect(contents, script).toContain(
        'octogee_load_deployment_target "--target=$DEPLOYMENT_TARGET"',
      );
      expect(contents, script).toContain("does not belong to environment");
    }
  });

  it("layers exact target Helm values into every canonical install", () => {
    const renderer = "core/dist/render-deployment-target-helm-values.js";
    for (const script of [
      "scripts/setup-secrets.sh",
      "scripts/setup-mattermost.sh",
      "scripts/teardown-env.sh",
    ]) {
      const contents = source(script);
      expect(contents, script).toContain(renderer);
      expect(contents, script).toContain("--target=$TARGET_ID");
    }
    expect(source(".github/workflows/build-and-deploy.yml")).toContain(renderer);
  });

  it("keeps regional bootstrap state isolated after target activation", () => {
    for (const script of [
      "scripts/setup-secrets.sh",
      "scripts/setup-mattermost.sh",
      "scripts/setup-gitea.sh",
      "scripts/teardown-env.sh",
    ]) {
      const contents = source(script);
      expect(contents, script).toContain(
        "prod-central|test-central|build-week-central) ;;",
      );
      expect(contents, script).toContain(
        '*) ENV_FILE="$REPO_DIR/.env.$TARGET_ID" ;;',
      );
      expect(contents, script).not.toContain(
        '[[ "$TARGET_LIFECYCLE" == "candidate" ]] && ENV_FILE=',
      );
    }
    expect(source("scripts/setup-secrets.sh")).toContain(
      'SA_KEY_PATH="$HOME/.openclaw/secrets/$TARGET_FIREBASE_PROJECT-sa-key.json"',
    );
    expect(source("scripts/teardown-env.sh")).toContain(
      'SA_KEY_DEFAULT="$HOME/.openclaw/secrets/$TARGET_FIREBASE_PROJECT-sa-key.json"',
    );
  });

  it("preserves the candidate target in verification probes and repairs", () => {
    const verify = source("scripts/verify-env.sh");
    expect(verify).toContain('--deployment-target="$TARGET_ID" --dry-run');
    expect(verify).toContain("--env=$ENV$TARGET_ARG");
  });

  it("resolves registry paths in gateway promotion code", () => {
    for (const script of [
      "scripts/ops/promote-gateway.ts",
      "scripts/lib/openclaw-candidate-manifest.ts",
      "scripts/lib/w9-test-candidate-promotion.ts",
      "scripts/lib/gateway-mutable-config-backfill.ts",
    ]) {
      const contents = source(script);
      expect(contents, script).toContain("@octogee/core/deployment-environment");
      expect(contents, script).not.toContain("us-central1");
      expect(contents, script).not.toContain("-docker.pkg.dev/octogee/octogee");
    }
  });

  it("delivers the active gateway repository to the Admin fleet UI", () => {
    const router = source("core/src/admin-fleet-router.ts");
    const adminTypes = source("app/src/types/admin.ts");
    const fleetPanel = source("app/src/components/admin/fleet/FleetPanel.tsx");

    expect(router).toContain("gatewayImageRepository");
    expect(router).not.toContain("us-central1");
    expect(adminTypes).toContain("gatewayImageRepository");
    expect(fleetPanel).toContain("settings.gatewayImageRepository");
    expect(fleetPanel).not.toContain("us-central1");
  });

  it("passes the exact deployment target into platform runtimes", () => {
    const workflow = source(".github/workflows/build-and-deploy.yml");
    const glmDeployment = source("helm/octogee/charts/glm-controller/templates/deployment.yaml");
    const apiDeployment = source("helm/octogee/charts/octogee-api/templates/deployment.yaml");
    const controller = source("glm-controller/src/index.ts");

    expect(workflow).toContain("global.deploymentTargetId");
    expect(glmDeployment).toContain("DEPLOYMENT_TARGET_ID");
    expect(apiDeployment).toContain("DEPLOYMENT_TARGET_ID");
    expect(controller).toContain("deploymentSettingsForRuntime");
    expect(controller).toContain("K8S_NAMESPACE is required for glm-controller");
    expect(controller).not.toContain('process.env.K8S_NAMESPACE ?? "octogee"');
  });

  it("keeps generated custom values and dependency inventory target-driven", () => {
    const customValues = source("helm/octogee/values.custom.yaml.tpl");
    const inventory = source("scripts/lib/dependency-inventory.ts");

    expect(customValues).toContain("__TARGET_ID__");
    expect(customValues).toContain("__AR_REPOSITORY__");
    expect(customValues).not.toContain("us-central1");
    expect(inventory).toContain("@octogee/core/deployment-environment");
    expect(inventory).not.toContain("us-central1-docker.pkg.dev/octogee/octogee/");
  });

  it("keeps shared Helm defaults free of a legacy regional target", () => {
    for (const valuesFile of [
      "helm/octogee/values.yaml",
      "helm/octogee/charts/cloud-sql-proxy/values.yaml",
      "helm/octogee/charts/gateway-edge/values.yaml",
      "helm/octogee/charts/glm-controller/values.yaml",
      "helm/octogee/charts/octogee-api/values.yaml",
      "helm/octogee-gateway/values.yaml",
    ]) {
      const values = source(valuesFile);
      expect(values, valuesFile).not.toContain("us-central1");
      expect(values, valuesFile).not.toContain("-docker.pkg.dev/octogee/octogee");
    }
  });

  it("requires Terraform callers to provide every regional location", () => {
    for (const moduleFile of [
      "terraform/modules/cloud-sql/variables.tf",
      "terraform/modules/networking/variables.tf",
      "terraform/modules/kms/variables.tf",
      "terraform/modules/secrets/main.tf",
    ]) {
      expect(source(moduleFile), moduleFile).not.toContain("us-central1");
    }
    expect(source("terraform/modules/secrets/main.tf")).toContain("location = var.region");
  });
});
