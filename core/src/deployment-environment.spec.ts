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

  it("makes central active while retaining west as the candidate rollback target", () => {
    expect(deploymentEnvironmentSettings("prod")).toMatchObject({
      targetId: "prod-central",
      lifecycle: "active",
      clusterProjectId: "octogee",
      firebaseProjectId: "octogee",
      region: "us-central1",
      clusterName: "octogee-gateway",
      kubeContext: "gke_octogee_us-central1_octogee-gateway",
      artifactRegistryRepository: "us-west1-docker.pkg.dev/octogee/octogee",
      cloudSqlConnectionName: "octogee:us-central1:octogee-pg",
      cloudSqlMattermostPasswordSecretName: "MM_DB_PASSWORD",
      cloudSqlGiteaPasswordSecretName: "gitea-db-password",
      cloudSqlConnectionNameSecretName: "cloud-sql-connection-name",
      secretNameSuffix: "prod",
      promotionSourceTargetId: "test-central",
      cloudSqlPointInTimeRecoveryEnabled: false,
      edgeStaticIpName: "workspace-api-ip",
      mattermostStaticIpName: "mattermost-ip",
      giteaStaticIpName: "gitea-ip",
      previewStaticIpName: "preview-ip",
    });

    expect(deploymentTargetSettings("prod-central")).toMatchObject({
      name: "prod",
      targetId: "prod-central",
      lifecycle: "active",
      namespace: "octogee",
      clusterProjectId: "octogee",
      firebaseProjectId: "octogee",
      hostingProjectId: "octogee",
      region: "us-central1",
      clusterName: "octogee-gateway",
      kubeContext: "gke_octogee_us-central1_octogee-gateway",
      artifactRegistryRepository: "us-west1-docker.pkg.dev/octogee/octogee",
      cloudSqlConnectionName: "octogee:us-central1:octogee-pg",
      cloudSqlMattermostPasswordSecretName: "MM_DB_PASSWORD",
      cloudSqlGiteaPasswordSecretName: "gitea-db-password",
      cloudSqlConnectionNameSecretName: "cloud-sql-connection-name",
      secretNameSuffix: "prod",
      promotionSourceTargetId: "test-central",
      cloudSqlPointInTimeRecoveryEnabled: false,
      kmsLocation: "us-central1",
      storageLocation: "us-central1",
      edgeStaticIpName: "workspace-api-ip",
      mattermostStaticIpName: "mattermost-ip",
      giteaStaticIpName: "gitea-ip",
      previewStaticIpName: "preview-ip",
    });

    expect(deploymentTargetSettings("test-central")).toMatchObject({
      name: "test",
      targetId: "test-central",
      lifecycle: "active",
      namespace: "octogee-test",
      firebaseProjectId: "octogee-test",
      region: "us-central1",
      artifactRegistryRepository: "us-west1-docker.pkg.dev/octogee/octogee",
      cloudSqlMattermostPasswordSecretName: "MM_DB_PASSWORD",
      cloudSqlGiteaPasswordSecretName: "gitea-db-password",
      cloudSqlConnectionNameSecretName: "cloud-sql-connection-name",
      secretNameSuffix: "test",
      edgeStaticIpName: "workspace-api-ip-test",
      mattermostStaticIpName: "mattermost-ip-test",
      giteaStaticIpName: "gitea-ip-test",
      previewStaticIpName: "preview-ip-test",
    });

    expect(deploymentTargetSettings("prod-west")).toMatchObject({
      lifecycle: "candidate",
      region: "us-west1",
      namespace: "octogee-west",
    });
    expect(deploymentTargetSettings("test-west")).toMatchObject({
      lifecycle: "candidate",
      region: "us-west1",
      namespace: "octogee-test-west",
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

  it("lets a caller select an exact target independent of the active pointer", () => {
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
