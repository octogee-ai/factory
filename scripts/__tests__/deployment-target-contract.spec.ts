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

  it("keeps active Central releases and gateway bootstrap image paths in Central Artifact Registry", () => {
    const targets = JSON.parse(source("core/src/deployment-targets.json")) as {
      activeTargets: Record<string, string>;
      targets: Record<string, { artifactRegistry: { location: string } }>;
    };

    for (const environment of ["prod", "test"]) {
      const targetId = targets.activeTargets[environment];
      expect(targetId).toMatch(/-central$/);
      expect(targets.targets[targetId]?.artifactRegistry.location).toBe("us-central1");
    }

    for (const valuesFile of [
      "helm/octogee-gateway/values.prod.yaml",
      "helm/octogee-gateway/values.test.yaml",
    ]) {
      const values = source(valuesFile);
      expect(values, valuesFile).toContain("us-central1-docker.pkg.dev/octogee/octogee/");
      expect(values, valuesFile).not.toContain("us-west1-docker.pkg.dev/octogee/octogee/");
    }
  });

  it("keeps only Central release targets and no WEST release credential routes", () => {
    const targets = JSON.parse(source("core/src/deployment-targets.json")) as {
      activeTargets: Record<string, string>;
      targets: Record<string, unknown>;
    };

    expect(targets.activeTargets).toEqual({
      prod: "prod-central",
      test: "test-central",
    });
    expect(Object.keys(targets.targets).sort()).toEqual([
      "prod-central",
      "test-central",
    ]);

    for (const workflow of [
      ".github/workflows/build-main.yml",
      ".github/workflows/gateway-build-operator-base.yml",
      ".github/workflows/site.yml",
    ]) {
      const contents = source(workflow);
      expect(contents, workflow).not.toMatch(/\b(?:test|prod)-west\b/);
      expect(contents, workflow).not.toMatch(/(?:TEST|PROD)_WEST/);
    }
  });

  it("rejects retired candidate targets from release workflows while retaining an exact target handoff", () => {
    const targetAction = source(".github/actions/resolve-deployment-target/action.yml");
    expect(targetAction).toContain("--reject-candidate-target");
    expect(targetAction).toContain("Candidate deployment targets cannot run release or build automation");

    for (const workflow of [
      ".github/workflows/build-and-deploy.yml",
      ".github/workflows/gateway-build-operator-base.yml",
      ".github/workflows/site.yml",
    ]) {
      const contents = source(workflow);
      expect(contents, workflow).toContain("deployment_target");
      expect(contents, workflow).not.toContain("for example test-west");
    }
  });

  it("passes the selected registry location into every Cloud Build", () => {
    const platform = source(".github/workflows/build-and-deploy.yml");
    const gateway = source(".github/workflows/gateway-build-operator-base.yml");

    expect(platform.match(/_REGION=\$\{\{ steps\.target\.outputs\.artifact_registry_location \}\}/g))
      .toHaveLength(5);
    expect(gateway.match(/_REGION=\$\{\{ needs\.matrix-setup\.outputs\.ar_location \}\}/g))
      .toHaveLength(3);
    expect(gateway).not.toContain("build-gateway-extra-oc");
    expect(gateway).not.toContain("build-operator-extra-oc");

    for (const config of [
      "artifact-worker/cloudbuild.yaml",
      "cloudbuild-base.yaml",
      "cloudbuild-builder-base.yaml",
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
    const platform = source(".github/workflows/build-and-deploy.yml");
    const verifySecrets = source("scripts/verify-secrets.sh");

    expect(platform).toContain(
      "--deployment-target=${{ steps.target.outputs.target_id }}",
    );
    expect(verifySecrets).toContain("--deployment-target=*)");
    expect(verifySecrets).toContain('octogee_load_deployment_target "--target=$DEPLOYMENT_TARGET"');
  });

  it("builds the current OpenClaw base from its selected environment", () => {
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
    expect(workflow).toContain("environment:");
    expect(workflow).toContain("./.github/actions/resolve-deployment-target");
    expect(workflow).toContain("artifact_registry_location");
    expect(workflow).toContain("cluster_project_id");
  });

  it("selects public Firebase credentials by exact registered target", () => {
    const workflow = source(".github/workflows/site.yml");
    const gateway = source(".github/workflows/gateway-build-operator-base.yml");

    expect(workflow).toContain("PUBLIC_FIREBASE_API_KEY_TEST");
    expect(workflow).toContain("PUBLIC_MM_TEAM_ID_TEST");
    expect(workflow).not.toContain("BUILD_WEEK");
    expect(workflow).toContain("firebase-deployer@${{ steps.target.outputs.firebase_project_id }}.iam.gserviceaccount.com");
    expect(gateway).not.toContain("firebase-deployer@");
    expect(workflow).not.toContain("FIREBASE_DEPLOYER_KEY");
    expect(gateway).not.toContain("FIREBASE_DEPLOYER_KEY");
    expect(workflow).not.toMatch(/(?:TEST|PROD)_WEST/);
    expect(gateway).not.toMatch(/(?:TEST|PROD)_WEST/);
    expect(workflow).toContain(
      "for value_name in api_key app_id sender_id mm_team_id; do",
    );
    expect(workflow).not.toContain(
      "for value_name in api_key app_id sender_id measurement_id mm_team_id; do",
    );
    expect(workflow).toContain("export_environment_variables: false");
    expect(workflow).toContain("token_format: access_token");
    expect(gateway).not.toContain("GOOGLE_OAUTH_ACCESS_TOKEN");
    expect(gateway).not.toContain("google-github-actions/auth");
  });

  it("does not embed the active cluster context in fleet operations", () => {
    for (const script of [
      "scripts/ops/fleet.ts",
    ]) {
      expect(source(script), script).not.toContain(
        "gke_octogee_us-central1_octogee-gateway",
      );
    }
  });

  it("keeps the platform credential reset out of ordinary deploy and gateway migration paths", () => {
    const resetScript = "reset-platform-builder-credentials";
    for (const path of [
      ".github/workflows/build-main.yml",
      ".github/workflows/build-and-deploy.yml",
      ".github/workflows/gateway-build-operator-base.yml",
      "scripts/ops/fleet.ts",
      "scripts/ops/cutover-simple-roll.ts",
    ]) {
      expect(source(path), path).not.toContain(resetScript);
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
      "scripts/shell-gateway.sh",
      "scripts/shell-gateway-ui.sh",
      "scripts/setup-monitoring.sh",
      "scripts/setup-monitoring-iap.sh",
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
    expect(setup).toContain("WEST Terraform prerequisites are not converged");
    expect(setup).not.toContain("gcloud sql instances patch");
    expect(setup).not.toContain("gcloud sql databases create");
    expect(setup).not.toContain("gcloud secrets create");
    expect(setup).not.toContain("gcloud secrets add-iam-policy-binding");
    expect(setup).not.toContain('2>/dev/null || echo ""');
    expect(setup).not.toContain('DESIRED_PITR="false"');
  });

  it("forces rebuild credential rotation so a rerun repairs a half-written SQL pair", () => {
    const setup = source("scripts/setup-cloud-sql.sh");
    const bootstrap = source("scripts/bootstrap-west-platform.sh");

    expect(setup).toContain("--rotate) FORCE_ROTATE=true");
    expect(setup).toContain('if ! $FORCE_ROTATE && $user_exists && $secret_exists; then');
    expect(setup).toContain('rollback_candidate_secret_version "$secret" "$candidate_version"');
    expect(bootstrap).toContain('setup-cloud-sql.sh" --target=test-west --rotate');
  });

  it("permits only the reviewed Cloud SQL recovery IAM replacement during a WEST rebuild", () => {
    const bootstrap = source("scripts/bootstrap-west-platform.sh");
    const destructiveAddresses = bootstrap
      .split("DESTRUCTIVE_ADDRESSES=(", 2)[1]
      ?.split("\n)", 1)[0];

    expect(destructiveAddresses).toContain(
      "'google_storage_bucket_iam_member.cloud_sql_recovery'",
    );
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

  it("lets custom namespace provisioning select and retain its exact test target", () => {
    const provision = source("scripts/provision-namespace.sh");

    expect(provision).toContain("--deployment-target=*)");
    expect(provision).toContain('octogee_load_deployment_target "--target=$DEPLOYMENT_TARGET"');
    expect(provision).toContain("does not belong to environment 'test'");
    expect(provision.match(/--env=custom --namespace="\$NAMESPACE" --yes --deployment-target="\$TARGET_ID"/g)).toHaveLength(4);

    for (const script of [
      "scripts/setup-secrets.sh",
      "scripts/setup-mattermost.sh",
      "scripts/setup-gitea.sh",
    ]) {
      const contents = source(script);
      expect(contents, script).not.toContain('"--deployment-target cannot be used with --env=custom"');
      expect(contents, script).toContain('[[ "$TARGET_ENVIRONMENT" != "$TARGET_ENV" ]]');
      expect(contents, script).toContain('if [[ "$ENV" != "custom" ]]; then');
    }
  });

  it("selects candidate data and cluster targets in canonical finalizers", () => {
    for (const script of ["scripts/verify-env.sh"]) {
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

  it("resolves the project runner API egress allowlist from the live cluster before Helm", () => {
    const workflow = source(".github/workflows/build-and-deploy.yml");

    expect(workflow).toContain("get endpoints kubernetes");
    expect(workflow).toContain("get service kubernetes");
    expect(workflow).toContain("API_SERVER_EGRESS_CIDRS_JSON");
    expect(workflow).toContain(
      '--set-json "projectRunner.apiServerEgressCidrs=${API_SERVER_EGRESS_CIDRS_JSON}"',
    );
  });

  it("reconciles durable PVC snapshot schedules after every platform release", () => {
    const workflow = source(".github/workflows/build-and-deploy.yml");

    expect(workflow).toContain("reconcile-pvc-snapshot-schedules.sh");
    expect(workflow).toContain("--target=${{ steps.target.outputs.target_id }}");
    expect(workflow).toContain("--apply");
    expect(workflow).not.toContain("needs.build.outputs.env !=");
    expect(workflow).not.toContain("steps.target.outputs.region == 'us-west1'");
  });

  it("owns the shared Central snapshot schedule and grants its reconciler only the required Compute permissions", () => {
    const controlPlane = source("terraform/environments/control-plane/main.tf");
    const ownership = JSON.parse(
      source("terraform/environments/control-plane/ownership.json"),
    ) as { requiredServices: string[] };

    expect(ownership.requiredServices).toContain("compute.googleapis.com");
    expect(controlPlane).toContain(
      'resource "google_compute_resource_policy" "central_pvc_snapshots"',
    );
    expect(controlPlane).toContain('name    = "octogee-central-pvc-daily"');
    expect(controlPlane).toContain("days_in_cycle = 1");
    expect(controlPlane).toContain('start_time    = "08:00"');
    expect(controlPlane).toContain("max_retention_days    = 14");
    expect(controlPlane).toContain(
      'on_source_disk_delete = "APPLY_RETENTION_POLICY"',
    );
    expect(controlPlane).toContain('storage_locations = ["us-central1"]');
    expect(controlPlane).toContain('role_id     = "octogeeCentralPvcSnapshots"');
    for (const permission of [
      "compute.disks.addResourcePolicies",
      "compute.disks.get",
      "compute.resourcePolicies.get",
      "compute.resourcePolicies.use",
    ]) {
      expect(controlPlane).toContain(`"${permission}"`);
    }
    expect(controlPlane).toContain(
      'member  = "serviceAccount:${google_service_account.github_actions.email}"',
    );
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
        "prod-central|test-central) ;;",
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
    expect(verify).toContain('--deployment-target="$TARGET_ID" --check');
    expect(verify).toContain("--env=$ENV$TARGET_ARG");
  });

  it("runs fleet-control keypair verification for central and west targets", () => {
    const verify = source("scripts/verify-env.sh");

    expect(verify).toContain('if [[ "$ENV" == "custom" ]]');
    expect(verify).not.toContain('if [[ "$NAMESPACE" != "octogee"');
    expect(verify).not.toContain("Unknown namespace '$NAMESPACE' — skipping fleet-control secret checks");
  });

  it("resolves registry paths in gateway configuration tooling", () => {
    const script = "scripts/lib/gateway-mutable-config-backfill.ts";
    const contents = source(script);
    expect(contents).toContain("@octogee/core/deployment-environment");
    expect(contents).not.toContain("us-central1");
    expect(contents).not.toContain("-docker.pkg.dev/octogee/octogee");
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

  it("seeds a fresh default gateway from separate immutable gateway and gateway-edge receipts", () => {
    const workflow = source(".github/workflows/build-and-deploy.yml");

    expect(workflow).toContain(
      "--set-string glm-controller.bootstrapDefaultGateway.imageTag=${GLM_TAG}@${GATEWAY_DIGEST}",
    );
    expect(workflow).toContain(
      "--set glm-controller.bootstrapDefaultGateway.imageRepository=${{ steps.target.outputs.artifact_registry_repository }}/octogee-gateway",
    );
    expect(workflow).toContain(
      "--set glm-controller.bootstrapDefaultGateway.gatewayEdgeImageRepository=${{ steps.target.outputs.artifact_registry_repository }}/gateway-edge",
    );
    expect(workflow).toContain(
      "--set-string glm-controller.bootstrapDefaultGateway.gatewayEdgeImageTag=${GLM_TAG}@${ROUTER_DIGEST}",
    );
  });

  it("prints a full-rebuild recipe that requires a digest-qualified default-gateway image", () => {
    const teardown = source("scripts/teardown-env.sh");

    expect(teardown).toContain(
      "BOOTSTRAP_GATEWAY_IMAGE=<tested release SHA>@sha256:<octogee-gateway digest from release receipt>",
    );
    expect(teardown).toContain(
      "BOOTSTRAP_GATEWAY_EDGE_IMAGE=<tested release SHA>@sha256:<gateway-edge digest from release receipt>",
    );
    expect(teardown).toContain(
      "glm-controller.bootstrapDefaultGateway.imageTag=\\$BOOTSTRAP_GATEWAY_IMAGE",
    );
    expect(teardown).toContain(
      "glm-controller.bootstrapDefaultGateway.gatewayEdgeImageTag=\\$BOOTSTRAP_GATEWAY_EDGE_IMAGE",
    );
    expect(teardown).not.toContain("BOOTSTRAP_GATEWAY_TAG=");
    expect(teardown).not.toContain(
      "Cowboy auto-installs octogee-gw-default after step 2",
    );
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
