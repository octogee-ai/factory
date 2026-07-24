import { describe, expect, it } from "vitest";

import deploymentTargetsDocument from "./deployment-targets.json" with { type: "json" };

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
  validateDeploymentTargetsDocument,
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
      platformComputeClass: undefined,
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

  it("makes west active while retaining central as the frozen rollback source", () => {
    expect(deploymentEnvironmentSettings("prod")).toMatchObject({
      targetId: "prod-west",
      lifecycle: "active",
      clusterProjectId: "octogee",
      firebaseProjectId: "octogee-data-prod",
      region: "us-west1",
      clusterName: "octogee-gateway",
      kubeContext: "gke_octogee_us-west1_octogee-gateway",
      artifactRegistryRepository: "us-west1-docker.pkg.dev/octogee/octogee",
      cloudSqlConnectionName: "octogee:us-west1:octogee-pg-west",
      cloudSqlMattermostPasswordSecretName: "MM_DB_PASSWORD-octogee-pg-west",
      cloudSqlGiteaPasswordSecretName: "gitea-db-password-octogee-pg-west",
      cloudSqlConnectionNameSecretName: "cloud-sql-connection-name-octogee-pg-west",
      secretNameSuffix: "prod-west",
      promotionSourceTargetId: "test-west",
      cloudSqlPointInTimeRecoveryEnabled: true,
      edgeStaticIpName: "workspace-api-ip-west",
      mattermostStaticIpName: "mattermost-ip-west",
      giteaStaticIpName: "gitea-ip-west",
      previewStaticIpName: "preview-ip-west",
      platformComputeClass: "octogee-platform-spot",
    });

    expect(deploymentTargetSettings("prod-west")).toMatchObject({
      name: "prod",
      targetId: "prod-west",
      lifecycle: "active",
      namespace: "octogee-west",
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
      secretNameSuffix: "prod-west",
      promotionSourceTargetId: "test-west",
      cloudSqlPointInTimeRecoveryEnabled: true,
      kmsLocation: "us-west1",
      storageLocation: "us-west1",
      edgeStaticIpName: "workspace-api-ip-west",
      mattermostStaticIpName: "mattermost-ip-west",
      giteaStaticIpName: "gitea-ip-west",
      previewStaticIpName: "preview-ip-west",
    });

    expect(deploymentTargetSettings("test-west")).toMatchObject({
      name: "test",
      targetId: "test-west",
      lifecycle: "active",
      namespace: "octogee-test-west",
      firebaseProjectId: "octogee-data-test",
      region: "us-west1",
      cloudSqlMattermostPasswordSecretName: "MM_DB_PASSWORD-octogee-pg-west",
      cloudSqlGiteaPasswordSecretName: "gitea-db-password-octogee-pg-west",
      cloudSqlConnectionNameSecretName: "cloud-sql-connection-name-octogee-pg-west",
      secretNameSuffix: "test-west",
      edgeStaticIpName: "workspace-api-ip-test-west",
      mattermostStaticIpName: "workspace-api-ip-test-west",
      giteaStaticIpName: "workspace-api-ip-test-west",
      previewStaticIpName: "workspace-api-ip-test-west",
      platformComputeClass: "octogee-platform-test-spot",
    });

    expect(deploymentTargetSettings("prod-central")).toMatchObject({
      lifecycle: "frozen",
      region: "us-central1",
      namespace: "octogee",
    });
    expect(deploymentTargetSettings("test-central")).toMatchObject({
      lifecycle: "frozen",
      region: "us-central1",
      namespace: "octogee-test",
    });
  });

  it("rejects a target that reuses another ingress identity", () => {
    const candidate = structuredClone(deploymentTargetsDocument) as {
      targets: Record<string, {
        ingress: {
          edgeStaticIpName: string;
        };
      }>;
    };
    candidate.targets["test-west"].ingress.edgeStaticIpName =
      candidate.targets["test-central"].ingress.edgeStaticIpName;

    expect(() => validateDeploymentTargetsDocument(candidate)).toThrow(
      "deployment target test-west ingress identity workspace-api-ip-test is already used",
    );
  });

  it("rejects a target that reuses another target role", () => {
    const staticIpName = "gitea-ip-west";
    const candidate = structuredClone(deploymentTargetsDocument) as {
      targets: Record<string, {
        ingress: {
          edgeStaticIpName: string;
        };
      }>;
    };
    candidate.targets["test-west"].ingress.edgeStaticIpName = staticIpName;

    expect(() => validateDeploymentTargetsDocument(candidate)).toThrow(
      `deployment target test-west ingress identity ${staticIpName} is already used`,
    );
  });

  it("accepts one shared ingress identity for every role within a target", () => {
    const candidate = structuredClone(deploymentTargetsDocument) as {
      targets: Record<string, {
        ingress: {
          edgeStaticIpName: string;
          mattermostStaticIpName: string;
          giteaStaticIpName: string;
          previewStaticIpName: string;
        };
      }>;
    };
    const ingress = candidate.targets["test-west"].ingress;
    ingress.mattermostStaticIpName = ingress.edgeStaticIpName;
    ingress.giteaStaticIpName = ingress.edgeStaticIpName;
    ingress.previewStaticIpName = ingress.edgeStaticIpName;

    expect(() => validateDeploymentTargetsDocument(candidate)).not.toThrow();
  });

  it("rejects partial ingress identity sharing within a target", () => {
    const candidate = structuredClone(deploymentTargetsDocument) as {
      targets: Record<string, {
        ingress: {
          edgeStaticIpName: string;
          mattermostStaticIpName: string;
          giteaStaticIpName: string;
          previewStaticIpName: string;
        };
      }>;
    };
    const ingress = candidate.targets["prod-west"].ingress;
    ingress.giteaStaticIpName = ingress.edgeStaticIpName;

    expect(() => validateDeploymentTargetsDocument(candidate)).toThrow(
      "must use either four distinct identities or one shared edge identity",
    );
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
      namespace: "octogee-test-west",
      targetId: "test-west",
    })).toMatchObject({
      targetId: "test-west",
      firebaseProjectId: "octogee-data-test",
      region: "us-west1",
    });
  });

  it("rejects a runtime target that belongs to another namespace", () => {
    expect(() => deploymentSettingsForRuntime({
      namespace: "octogee-test-west",
      targetId: "prod-west",
    })).toThrow("Deployment target prod-west belongs to namespace octogee-west");
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
