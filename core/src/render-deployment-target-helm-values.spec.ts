import { describe, expect, it } from "vitest";

import { deploymentTargetSettings } from "./deployment-environment.js";
import { renderDeploymentTargetHelmValues } from "./render-deployment-target-helm-values.js";

describe("deployment target Helm values", () => {
  it("renders every regional west override from one exact target", () => {
    const rendered = renderDeploymentTargetHelmValues(
      deploymentTargetSettings("test-west"),
    );

    expect(rendered).toContain('deploymentTargetId: "test-west"');
    expect(rendered).toContain('deploymentProjectId: "octogee-data-test"');
    expect(rendered).toContain('connectionName: "octogee:us-west1:octogee-pg-west"');
    expect(rendered).toContain(
      'repository: "us-west1-docker.pkg.dev/octogee/octogee/octogee-api"',
    );
    expect(rendered).toContain(
      'OCTOGEE_KMS_KEY_NAME: "projects/octogee-data-test/locations/us-west1/keyRings/octogee-creds/cryptoKeys/integrations-at-rest"',
    );
    expect(rendered).toContain(
      'gcpServiceAccount: "octogee-glm-controller@octogee-data-test.iam.gserviceaccount.com"',
    );
    expect(rendered).not.toContain("us-central1");
    expect(rendered).not.toContain("@octogee-test.iam.gserviceaccount.com");
  });
});
