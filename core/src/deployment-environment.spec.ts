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

  it("keeps Central prod and test mappings stable and rejects retired projects and custom namespaces", () => {
    expect(deploymentEnvironmentForNamespace("octogee")).toBe("prod");
    expect(deploymentEnvironmentForNamespace("octogee-test")).toBe("test");
    expect(deploymentEnvironmentForNamespace("feat-alice")).toBe("unknown");
    expect(deploymentEnvironmentForProject("octogee")).toBe("prod");
    expect(deploymentEnvironmentForProject("octogee-test")).toBe("test");
    expect(deploymentEnvironmentForProject("octogee-data-prod")).toBe("unknown");
    expect(deploymentEnvironmentForProject("octogee-data-test")).toBe("unknown");
    expect(deploymentEnvironmentForProject("local-dev")).toBe("unknown");
  });

  it("keeps CENTRAL as the only prod and test target", () => {
    expect(deploymentEnvironmentSettings("prod")).toMatchObject({
      targetId: "prod-central",
      lifecycle: "active",
      clusterProjectId: "octogee",
      firebaseProjectId: "octogee",
      customerHostingProjectId: "octogee-customer-hosting",
      region: "us-central1",
      clusterName: "octogee-gateway",
      kubeContext: "gke_octogee_us-central1_octogee-gateway",
      artifactRegistryRepository: "us-central1-docker.pkg.dev/octogee/octogee",
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
      projectRunnerApiServerEgressCidrs: ["10.128.0.2/32", "34.118.224.1/32"],
    });

    expect(deploymentTargetSettings("prod-central")).toMatchObject({
      name: "prod",
      targetId: "prod-central",
      lifecycle: "active",
      namespace: "octogee",
      clusterProjectId: "octogee",
      firebaseProjectId: "octogee",
      hostingProjectId: "octogee",
      customerHostingProjectId: "octogee-customer-hosting",
      region: "us-central1",
      clusterName: "octogee-gateway",
      kubeContext: "gke_octogee_us-central1_octogee-gateway",
      artifactRegistryRepository: "us-central1-docker.pkg.dev/octogee/octogee",
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
      projectRunnerApiServerEgressCidrs: ["10.128.0.2/32", "34.118.224.1/32"],
    });

    expect(deploymentTargetSettings("test-central")).toMatchObject({
      name: "test",
      targetId: "test-central",
      lifecycle: "active",
      namespace: "octogee-test",
      firebaseProjectId: "octogee-test",
      customerHostingProjectId: "octogee-customer-hosting-test",
      region: "us-central1",
      artifactRegistryRepository: "us-central1-docker.pkg.dev/octogee/octogee",
      cloudSqlMattermostPasswordSecretName: "MM_DB_PASSWORD",
      cloudSqlGiteaPasswordSecretName: "gitea-db-password",
      cloudSqlConnectionNameSecretName: "cloud-sql-connection-name",
      secretNameSuffix: "test",
      edgeStaticIpName: "workspace-api-ip-test",
      mattermostStaticIpName: "mattermost-ip-test",
      giteaStaticIpName: "gitea-ip-test",
      previewStaticIpName: "preview-ip-test",
      projectRunnerApiServerEgressCidrs: ["10.128.0.2/32", "34.118.224.1/32"],
      appOrigin: "https://app-test.octogee.com",
    });

    expect(deploymentTargetsForEnvironment("prod")).toEqual([
      expect.objectContaining({ targetId: "prod-central", lifecycle: "active" }),
    ]);
    expect(deploymentTargetsForEnvironment("test")).toEqual([
      expect.objectContaining({ targetId: "test-central", lifecycle: "active" }),
    ]);
    for (const targetId of ["prod-west", "test-west"]) {
      expect(() => deploymentTargetSettings(targetId)).toThrow(
        `Unknown deployment target: ${targetId}`,
      );
    }
  });

  it("rejects a target that reuses another ingress identity", () => {
    const candidate = structuredClone(deploymentTargetsDocument) as {
      targets: Record<string, {
        ingress: {
          edgeStaticIpName: string;
        };
      }>;
    };
    candidate.targets["build-week-central"].ingress.edgeStaticIpName =
      candidate.targets["test-central"].ingress.edgeStaticIpName;

    expect(() => validateDeploymentTargetsDocument(candidate)).toThrow(
      "deployment target build-week-central ingress identity workspace-api-ip-test is already used",
    );
  });

  it("requires a distinct dedicated customer Hosting project for every target", () => {
    const missing = structuredClone(deploymentTargetsDocument) as { targets: Record<string, Record<string, unknown>> };
    delete missing.targets["test-central"].customerHostingProjectId;
    expect(() => validateDeploymentTargetsDocument(missing)).toThrow(
      "deployment target test-central.customerHostingProjectId must be a non-empty string",
    );

    const appProject = structuredClone(deploymentTargetsDocument) as { targets: Record<string, Record<string, unknown>> };
    appProject.targets["test-central"].customerHostingProjectId = "octogee-test";
    expect(() => validateDeploymentTargetsDocument(appProject)).toThrow(
      "deployment target test-central.customerHostingProjectId must be isolated",
    );

    const foreignAppProject = structuredClone(deploymentTargetsDocument) as { targets: Record<string, Record<string, unknown>> };
    foreignAppProject.targets["test-central"].customerHostingProjectId = "octogee";
    expect(() => validateDeploymentTargetsDocument(foreignAppProject)).toThrow(
      "deployment target test-central.customerHostingProjectId must be isolated",
    );

    const shared = structuredClone(deploymentTargetsDocument) as { targets: Record<string, Record<string, unknown>> };
    shared.targets["test-central"].customerHostingProjectId = "octogee-customer-hosting";
    expect(() => validateDeploymentTargetsDocument(shared)).toThrow(
      "deployment target test-central.customerHostingProjectId is already used by prod-central",
    );
  });

  it("rejects a target that reuses another target role", () => {
    const staticIpName = "gitea-ip-test";
    const candidate = structuredClone(deploymentTargetsDocument) as {
      targets: Record<string, {
        ingress: {
          edgeStaticIpName: string;
        };
      }>;
    };
    candidate.targets["build-week-central"].ingress.edgeStaticIpName = staticIpName;

    expect(() => validateDeploymentTargetsDocument(candidate)).toThrow(
      `deployment target build-week-central ingress identity ${staticIpName} is already used`,
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
    const ingress = candidate.targets["build-week-central"].ingress;
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
    const ingress = candidate.targets["prod-central"].ingress;
    ingress.giteaStaticIpName = ingress.edgeStaticIpName;

    expect(() => validateDeploymentTargetsDocument(candidate)).toThrow(
      "must use either four distinct identities or one shared edge identity",
    );
  });

  it("accepts only a non-empty unique list of canonical project runner API-server /32s", () => {
    const candidate = structuredClone(deploymentTargetsDocument) as {
      targets: Record<string, { projectRunnerApiServerEgressCidrs: unknown }>;
    };
    candidate.targets["test-central"].projectRunnerApiServerEgressCidrs = [
      "10.128.0.2/32",
      "34.118.224.1/32",
    ];
    expect(() => validateDeploymentTargetsDocument(candidate)).not.toThrow();

    for (const cidrs of [
      [],
      ["34.58.245.121/27"],
      ["0.0.0.0/32"],
      ["300.1.1.1/32"],
      ["10.128.0.2/32", "10.128.0.2/32"],
      "10.128.0.2/32",
    ]) {
      candidate.targets["test-central"].projectRunnerApiServerEgressCidrs = cidrs;
      expect(() => validateDeploymentTargetsDocument(candidate), JSON.stringify(cidrs)).toThrow(
        "deployment target test-central.projectRunnerApiServerEgressCidrs must contain unique canonical IPv4 /32 CIDRs",
      );
    }
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

  it("lets a caller select the exact active target for its namespace", () => {
    expect(deploymentSettingsForRuntime({
      namespace: "octogee-test",
      targetId: "test-central",
    })).toMatchObject({
      targetId: "test-central",
      firebaseProjectId: "octogee-test",
      region: "us-central1",
    });
  });

  it("rejects a runtime target that belongs to another namespace", () => {
    expect(() => deploymentSettingsForRuntime({
      namespace: "octogee-test",
      targetId: "prod-central",
    })).toThrow("Deployment target prod-central belongs to namespace octogee");
  });

  it("does not resolve retired Firebase data projects", () => {
    expect(deploymentTargetForFirebaseProject("octogee-test")).toMatchObject({
      targetId: "test-central",
      region: "us-central1",
    });
    for (const projectId of ["octogee-data-prod", "octogee-data-test", "outside-project"]) {
      expect(() => deploymentTargetForFirebaseProject(projectId)).toThrow(
        `Unknown Firebase deployment project: ${projectId}`,
      );
    }
  });

  it("publishes every browser origin used by CORS and redirects", () => {
    const settings = deploymentEnvironmentSettings("build-week");
    expect(publicAppOrigins()).toEqual(expect.arrayContaining([
      settings.siteOrigin,
      settings.appOrigin,
      "https://octogee-build-week.firebaseapp.com",
      "https://app-octogee-build-week.firebaseapp.com",
    ]));
    expect(publicAppOrigins()).toContain("https://app-octogee-test.web.app");
  });
});
