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
