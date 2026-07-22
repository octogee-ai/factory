import { describe, expect, it } from "vitest";

import {
  BUILD_WEEK_ENVIRONMENT,
  deploymentEnvironmentForNamespace,
  deploymentEnvironmentForProject,
  deploymentEnvironmentSettings,
  deploymentSettingsForRuntime,
  deploymentTargetForFirebaseProject,
  deploymentTargetSettings,
  deploymentTargetsForEnvironment,
  publicAppOrigins,
} from "./deployment-environment.js";

describe("deployment environment registry", () => {
  it("maps the isolated Build Week namespace and Firebase project", () => {
    expect(deploymentEnvironmentForNamespace("octogee-build-week")).toBe("build-week");
    expect(deploymentEnvironmentForProject("octogee-build-week")).toBe("build-week");
    expect(BUILD_WEEK_ENVIRONMENT).toMatchObject({
      namespace: "octogee-build-week",
      firebaseProjectId: "octogee-build-week",
      apiOrigin: "https://api-build-week.octogee.com",
      previewOrigin: "https://preview-build-week.octogee.com",
      gatewayValuesFile: "values.build-week.yaml",
      computeClass: "octogee-gateway-build-week",
      pinEnvironment: "build-week",
    });
  });

  it("keeps prod and test mappings stable and rejects custom namespaces", () => {
    expect(deploymentEnvironmentForNamespace("octogee")).toBe("prod");
    expect(deploymentEnvironmentForNamespace("octogee-test")).toBe("test");
    expect(deploymentEnvironmentForNamespace("feat-alice")).toBe("unknown");
    expect(deploymentEnvironmentForProject("octogee")).toBe("prod");
    expect(deploymentEnvironmentForProject("octogee-test")).toBe("test");
    expect(deploymentEnvironmentForProject("octogee-data-prod")).toBe("prod");
    expect(deploymentEnvironmentForProject("octogee-data-test")).toBe("test");
    expect(deploymentEnvironmentForProject("local-dev")).toBe("unknown");
  });

  it("keeps central active while declaring the fresh west launch targets", () => {
    expect(deploymentEnvironmentSettings("prod")).toMatchObject({
      targetId: "prod-central",
      lifecycle: "active",
      clusterProjectId: "octogee",
      region: "us-central1",
      clusterName: "octogee-gateway",
      kubeContext: "gke_octogee_us-central1_octogee-gateway",
      artifactRegistryRepository: "us-central1-docker.pkg.dev/octogee/octogee",
      cloudSqlConnectionName: "octogee:us-central1:octogee-pg",
      cloudSqlMattermostPasswordSecretName: "MM_DB_PASSWORD",
      cloudSqlGiteaPasswordSecretName: "gitea-db-password",
      cloudSqlConnectionNameSecretName: "cloud-sql-connection-name",
      cloudSqlPointInTimeRecoveryEnabled: false,
    });

    expect(deploymentTargetSettings("prod-west")).toMatchObject({
      name: "prod",
      targetId: "prod-west",
      lifecycle: "candidate",
      clusterProjectId: "octogee",
      firebaseProjectId: "octogee-data-prod",
      hostingProjectId: "octogee",
      region: "us-west1",
      clusterName: "octogee-gateway",
      kubeContext: "gke_octogee_us-west1_octogee-gateway",
      artifactRegistryRepository: "us-west1-docker.pkg.dev/octogee/octogee",
      cloudSqlConnectionName: "octogee:us-west1:octogee-pg-west",
      cloudSqlMattermostPasswordSecretName: "MM_DB_PASSWORD-octogee-pg-west",
      cloudSqlGiteaPasswordSecretName: "gitea-db-password-octogee-pg-west",
      cloudSqlConnectionNameSecretName: "cloud-sql-connection-name-octogee-pg-west",
      cloudSqlPointInTimeRecoveryEnabled: true,
      kmsLocation: "us-west1",
      storageLocation: "us-west1",
    });

    expect(deploymentTargetSettings("test-west")).toMatchObject({
      name: "test",
      targetId: "test-west",
      lifecycle: "candidate",
      firebaseProjectId: "octogee-data-test",
      region: "us-west1",
      cloudSqlMattermostPasswordSecretName: "MM_DB_PASSWORD-octogee-pg-west",
      cloudSqlGiteaPasswordSecretName: "gitea-db-password-octogee-pg-west",
      cloudSqlConnectionNameSecretName: "cloud-sql-connection-name-octogee-pg-west",
    });
  });

  it("freezes Build Week in central and gives it no west candidate", () => {
    expect(deploymentTargetsForEnvironment("build-week")).toEqual([
      expect.objectContaining({
        targetId: "build-week-central",
        lifecycle: "frozen",
        region: "us-central1",
      }),
    ]);
  });

  it("fails closed for an unknown deployment target", () => {
    expect(() => deploymentTargetSettings("prod-somewhere")).toThrow(
      "Unknown deployment target: prod-somewhere",
    );
  });

  it("lets a candidate cluster select its exact target before the active pointer flips", () => {
    expect(deploymentSettingsForRuntime({
      namespace: "octogee-test",
      targetId: "test-west",
    })).toMatchObject({
      targetId: "test-west",
      firebaseProjectId: "octogee-data-test",
      region: "us-west1",
    });
  });

  it("rejects a runtime target that belongs to another namespace", () => {
    expect(() => deploymentSettingsForRuntime({
      namespace: "octogee-test",
      targetId: "prod-west",
    })).toThrow("Deployment target prod-west belongs to namespace octogee");
  });

  it("resolves Secret Manager placement from the exact Firebase project target", () => {
    expect(deploymentTargetForFirebaseProject("octogee-data-prod")).toMatchObject({
      targetId: "prod-west",
      region: "us-west1",
    });
    expect(() => deploymentTargetForFirebaseProject("outside-project")).toThrow(
      "Unknown Firebase deployment project: outside-project",
    );
  });

  it("publishes every browser origin used by CORS and redirects", () => {
    const settings = deploymentEnvironmentSettings("build-week");
    expect(publicAppOrigins()).toEqual(expect.arrayContaining([
      settings.siteOrigin,
      settings.appOrigin,
      "https://octogee-build-week.firebaseapp.com",
      "https://app-octogee-build-week.firebaseapp.com",
    ]));
  });
});
