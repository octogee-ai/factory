import { describe, expect, it } from "vitest";

import {
  BUILD_WEEK_ENVIRONMENT,
  deploymentEnvironmentForNamespace,
  deploymentEnvironmentForProject,
  deploymentEnvironmentSettings,
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
    expect(deploymentEnvironmentForProject("local-dev")).toBe("unknown");
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
