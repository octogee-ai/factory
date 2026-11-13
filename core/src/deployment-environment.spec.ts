import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runDeploymentTargetResolver } from "./resolve-deployment-target.js";

import deploymentTargetsDocument from "./fixtures/deployment-targets.json" with { type: "json" };

import {
  activeDeploymentTargetSettings,
  deploymentEnvironmentForNamespace,
  deploymentEnvironmentSettings,
  deploymentSettingsForRuntime,
  deploymentTargetForFirebaseProject,
  deploymentTargetSettings,
  DEPLOYMENT_TARGETS_ENV,
  installDeploymentTargets,
  loadDeploymentTargetsDocument,
  publicAppOriginsForTarget,
  resetDeploymentTargetsForTests,
  validateDeploymentTargetsDocument,
} from "./deployment-environment.js";

describe("deployment environment registry", () => {
  it("rejects a target that reuses another ingress identity in the same project", () => {
    const candidate = structuredClone(deploymentTargetsDocument) as {
      targets: Record<string, { clusterProjectId: string }>;
    };
    candidate.targets["test-central"].clusterProjectId =
      candidate.targets["prod-central"].clusterProjectId;

    expect(() => validateDeploymentTargetsDocument(candidate)).toThrow(
      "deployment target test-central ingress identity workspace-api-ip is already used by prod-central.edgeStaticIpName",
    );
  });

  it("refuses a registry whose active environments share a Firebase project", () => {
    const candidate = structuredClone(deploymentTargetsDocument) as { targets: Record<string, Record<string, unknown>> };
    candidate.targets["test-central"].firebaseProjectId = candidate.targets["prod-central"].firebaseProjectId;
    expect(() => validateDeploymentTargetsDocument(candidate)).toThrow(
      "active deployment targets for prod and test share Firebase project",
    );
  });

  it("refuses a registry whose active environments share a cluster namespace", () => {
    const candidate = structuredClone(deploymentTargetsDocument) as { targets: Record<string, Record<string, unknown>> };
    const prod = candidate.targets["prod-central"];
    candidate.targets["test-central"].clusterProjectId = prod.clusterProjectId;
    candidate.targets["test-central"].namespace = prod.namespace;
    candidate.targets["test-central"].ingress = { ...(prod.ingress as object), edgeStaticIpName: "test-edge", mattermostStaticIpName: "test-mm", giteaStaticIpName: "test-git", previewStaticIpName: "test-preview" };
    expect(() => validateDeploymentTargetsDocument(candidate)).toThrow(
      "active deployment targets for prod and test share cluster namespace",
    );
  });

  it("refuses a test target that carries every prod project", () => {
    const candidate = structuredClone(deploymentTargetsDocument) as { targets: Record<string, Record<string, unknown>> };
    const prod = candidate.targets["prod-central"];
    for (const field of ["firebaseProjectId", "hostingProjectId", "clusterProjectId", "namespace"]) {
      candidate.targets["test-central"][field] = prod[field];
    }
    expect(() => validateDeploymentTargetsDocument(candidate)).toThrow(/prod and test share/);
  });

  it("allows the same ingress identity name in separate projects", () => {
    expect(() => validateDeploymentTargetsDocument(deploymentTargetsDocument)).not.toThrow();
    expect(deploymentTargetSettings("test-central").edgeStaticIpName)
      .toBe(deploymentTargetSettings("prod-central").edgeStaticIpName);
  });

  it("requires a distinct dedicated user Hosting project for every target", () => {
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
    shared.targets["test-central"].customerHostingProjectId = "example-prod-hosting";
    expect(() => validateDeploymentTargetsDocument(shared)).toThrow(
      "deployment target test-central.customerHostingProjectId is already used by prod-central",
    );
  });

  it("rejects a target that reuses another target role", () => {
    const staticIpName = "gitea-ip-test";
    const candidate = structuredClone(deploymentTargetsDocument) as {
      targets: Record<string, {
        clusterProjectId: string;
        ingress: {
          edgeStaticIpName: string;
        };
      }>;
    };
    candidate.targets["test-central"].clusterProjectId =
      candidate.targets["prod-central"].clusterProjectId;
    candidate.targets["test-central"].ingress.edgeStaticIpName = "workspace-api-ip-test";
    candidate.targets["prod-central"].ingress.edgeStaticIpName = staticIpName;

    expect(() => validateDeploymentTargetsDocument(candidate)).toThrow(
      `deployment target test-central ingress identity ${staticIpName} is already used by prod-central.edgeStaticIpName`,
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
    const ingress = candidate.targets["test-central"].ingress;
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

  it("derives one target's browser origins for its values file", () => {
    const test = deploymentEnvironmentSettings("test");
    expect(publicAppOriginsForTarget(test)).toEqual([
      test.siteOrigin,
      test.appOrigin,
      "https://app-octogee-test.web.app",
      "https://octogee-test.firebaseapp.com",
      "https://app-octogee-test.firebaseapp.com",
    ]);
    const prod = deploymentEnvironmentSettings("prod");
    expect(publicAppOriginsForTarget(prod)).toContain("https://www.octogee.com");
    expect(publicAppOriginsForTarget(prod)).not.toContain(test.appOrigin);
  });
});

function manifestWith(mutate: (document: typeof deploymentTargetsDocument) => void): string {
  const document = structuredClone(deploymentTargetsDocument);
  mutate(document);
  const path = join(mkdtempSync(join(tmpdir(), "deployment-targets-")), "deployment-targets.json");
  writeFileSync(path, JSON.stringify(document));
  return path;
}

describe("deployment targets manifest location", () => {
  const original = process.env[DEPLOYMENT_TARGETS_ENV];

  afterEach(() => {
    if (original === undefined) delete process.env[DEPLOYMENT_TARGETS_ENV];
    else process.env[DEPLOYMENT_TARGETS_ENV] = original;
    resetDeploymentTargetsForTests();
  });

  it("reads the manifest named by OCTOGEE_DEPLOYMENT_TARGETS instead of the bundled file", () => {
    process.env[DEPLOYMENT_TARGETS_ENV] = manifestWith((document) => {
      document.targets["test-central"].namespace = "octogee-elsewhere";
    });
    resetDeploymentTargetsForTests();
    expect(deploymentEnvironmentSettings("test").namespace).toBe("octogee-elsewhere");
    expect(deploymentEnvironmentForNamespace("octogee-test")).toBe("unknown");
  });

  it("resolves an active custom environment without GCP configuration", () => {
    const dir = mkdtempSync(join(tmpdir(), "platform-deployment-targets-"));
    try {
      const path = join(dir, "deployment-targets.json");
      writeFileSync(path, JSON.stringify({
        schemaVersion: 1,
        activeTargets: { "local-factory": "local-kind" },
        targets: {
          "local-kind": {
            environment: "local-factory",
            lifecycle: "active",
            namespace: "factory",
            clusterName: "kind",
            kubeContext: "kind-factory",
            appOrigin: "http://localhost:4322",
            siteOrigin: "http://localhost:4321",
            apiOrigin: "http://localhost:3001",
            gitOrigin: "https://git.example.com",
            mattermostOrigin: "https://chat.example.com",
            gatewayValuesFile: "values.yaml",
          },
        },
      }));
      process.env[DEPLOYMENT_TARGETS_ENV] = path;
      resetDeploymentTargetsForTests();
      const settings = deploymentSettingsForRuntime({ namespace: "factory" });
      expect(settings).toMatchObject({
        name: "local-factory",
        targetId: "local-kind",
        kubeContext: "kind-factory",
      });
      expect(settings).not.toHaveProperty("clusterProjectId");
      expect(publicAppOriginsForTarget(settings)).toEqual(["http://localhost:4321", "http://localhost:4322"]);
      expect(JSON.parse(runDeploymentTargetResolver(["--environment=local-factory", "--format=json"])))
        .toMatchObject({ environment: "local-factory", target_id: "local-kind", namespace: "factory" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails loud when the named manifest is missing or invalid", () => {
    expect(() => loadDeploymentTargetsDocument("/nonexistent/deployment-targets.json"))
      .toThrow(/not readable at \/nonexistent\/deployment-targets\.json \(set OCTOGEE_DEPLOYMENT_TARGETS/);
    const invalid = manifestWith((document) => {
      document.activeTargets.test = "missing-target";
    });
    expect(() => loadDeploymentTargetsDocument(invalid)).toThrow(/Active deployment target does not exist/);
  });
});

describe("installed deployment targets", () => {
  const original = process.env[DEPLOYMENT_TARGETS_ENV];

  beforeEach(() => {
    delete process.env[DEPLOYMENT_TARGETS_ENV];
    resetDeploymentTargetsForTests();
  });

  afterEach(() => {
    if (original === undefined) delete process.env[DEPLOYMENT_TARGETS_ENV];
    else process.env[DEPLOYMENT_TARGETS_ENV] = original;
    resetDeploymentTargetsForTests();
  });

  it("bundles only the local kind target", () => {
    expect(activeDeploymentTargetSettings("kind")).toMatchObject({ targetId: "kind", namespace: "octogee-local" });
    expect(() => activeDeploymentTargetSettings("test")).toThrow("Unknown deployment environment: test");
  });

  it("serves the targets a composition root installs instead of the bundled ones", () => {
    installDeploymentTargets(deploymentTargetsDocument);
    expect(deploymentEnvironmentSettings("test").targetId).toBe("test-central");
    expect(deploymentEnvironmentForNamespace("octogee-local")).toBe("unknown");
  });

  it("prefers the manifest named by OCTOGEE_DEPLOYMENT_TARGETS over installed targets", () => {
    process.env[DEPLOYMENT_TARGETS_ENV] = manifestWith((document) => {
      document.targets["test-central"].namespace = "octogee-elsewhere";
    });
    installDeploymentTargets(deploymentTargetsDocument);
    expect(deploymentEnvironmentSettings("test").namespace).toBe("octogee-elsewhere");
  });

  it("refuses targets installed after the registry was read", () => {
    expect(deploymentEnvironmentForNamespace("octogee-local")).toBe("kind");
    expect(() => installDeploymentTargets(deploymentTargetsDocument))
      .toThrow("Deployment targets must be installed before the registry is read");
  });

  it("refuses an invalid installed document", () => {
    const invalid = structuredClone(deploymentTargetsDocument);
    invalid.activeTargets.test = "missing-target";
    expect(() => installDeploymentTargets(invalid)).toThrow(/Active deployment target does not exist/);
  });
});
