import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import { deploymentTargetSettings } from "./deployment-environment.js";
import { renderDeploymentTargetHelmValues } from "./render-deployment-target-helm-values.js";

describe("deployment target Helm values", () => {
  it("renders every active Central value from one exact target", () => {
    const rendered = renderDeploymentTargetHelmValues(
      deploymentTargetSettings("test-central"),
    );

    expect(rendered).toContain('deploymentTargetId: "test-central"');
    expect(rendered).toContain('deploymentProjectId: "octogee-test"');
    expect(rendered).toContain('customerHostingProjectId: "octogee-customer-hosting-test"');
    expect(rendered.match(/customerHostingProjectId:/g)).toHaveLength(1);
    expect(rendered).not.toContain("OCTOGEE_CUSTOMER_HOSTING_PROJECT_ID:");
    expect(rendered).not.toContain("projectPublisher:");
    expect(rendered).not.toContain("platformComputeClass");
    expect(rendered).toContain(`projectRunner:
  apiServerEgressCidrs: ["10.128.0.2/32","34.118.224.1/32"]`);
    expect(rendered).toContain(`networkPolicy:
  enforceDefaultDeny: false`);
    expect(rendered).toContain('connectionName: "octogee:us-central1:octogee-pg"');
    expect(rendered).toContain(
      'repository: "us-central1-docker.pkg.dev/octogee/octogee/octogee-api"',
    );
    expect(rendered).toContain(
      'repository: "us-central1-docker.pkg.dev/octogee/octogee/octogee-project-runner"',
    );
    expect(rendered).toContain(
      'OCTOGEE_KMS_KEY_NAME: "projects/octogee-test/locations/us-central1/keyRings/octogee-creds/cryptoKeys/integrations-at-rest"',
    );
    expect(rendered).toContain(
      'gcpServiceAccount: "octogee-glm-controller@octogee-test.iam.gserviceaccount.com"',
    );
    expect(rendered).toContain(
      'MM_URL: "http://mattermost.octogee-test.svc.cluster.local:8065"',
    );
    expect(rendered).toContain(
      'MM_INTERNAL_URL: "http://mattermost.octogee-test.svc.cluster.local:8065"',
    );
    expect(rendered).toContain(
      'loggingResourceName: "projects/octogee/locations/global/buckets/ops-agent-test/views/ops-agent"',
    );
    expect(rendered).toContain(`edgeIngress:
  staticIpName: "workspace-api-ip-test"`);
    expect(rendered).toContain(`gateway-edge:
  ingress:
    staticIpName: "workspace-api-ip-test"`);
    expect(rendered).toContain(`mattermost:
  ingress:
    staticIpName: "mattermost-ip-test"`);
    expect(rendered).toContain(`gitea:
  webIngress:
    staticIpName: "gitea-ip-test"`);
    expect(rendered).toContain(`gatewayFleet:
  previewIngress:
    staticIpName: "preview-ip-test"`);
    expect(rendered).not.toContain("us-west1");
    expect(rendered).not.toContain("octogee-data-test");
  });

  it.each([
    ["prod-central", "workspace-api-ip", "mattermost-ip", "gitea-ip", "preview-ip"],
    ["test-central", "workspace-api-ip-test", "mattermost-ip-test", "gitea-ip-test", "preview-ip-test"],
  ])(
    "renders the canonical ingress identities for %s",
    (targetId, edge, mattermost, gitea, preview) => {
      const rendered = renderDeploymentTargetHelmValues(
        deploymentTargetSettings(targetId),
      );

      expect(rendered).toContain(`edgeIngress:\n  staticIpName: "${edge}"`);
      expect(rendered).toContain(`gateway-edge:\n  ingress:\n    staticIpName: "${edge}"`);
      expect(rendered).toContain(`mattermost:\n  ingress:\n    staticIpName: "${mattermost}"`);
      expect(rendered).toContain(`gitea:\n  webIngress:\n    staticIpName: "${gitea}"`);
      expect(rendered).toContain(`gatewayFleet:\n  previewIngress:\n    staticIpName: "${preview}"`);
    },
  );

  it.each(["prod-central", "test-central"])(
    "renders the exact central project runner API-server destinations for %s",
    (targetId) => {
      const rendered = renderDeploymentTargetHelmValues(deploymentTargetSettings(targetId));
      expect(rendered).toContain(`projectRunner:
  apiServerEgressCidrs: ["10.128.0.2/32","34.118.224.1/32"]`);
      expect(rendered).toContain("enforceDefaultDeny: false");
    },
  );

  it.each(["prod-central", "test-central"])(
    "emits no platform compute class for %s",
    (targetId) => {
      expect(renderDeploymentTargetHelmValues(deploymentTargetSettings(targetId)))
        .not.toContain("ComputeClass");
    },
  );

  it("runs through a symlinked temporary-worktree entrypoint", () => {
    const temp = mkdtempSync(path.join(tmpdir(), "octogee-helm-renderer-entrypoint-"));
    const linkedEntrypoint = path.join(temp, "render-deployment-target-helm-values.js");
    symlinkSync(
      path.resolve(import.meta.dirname, "../dist/render-deployment-target-helm-values.js"),
      linkedEntrypoint,
    );

    const result = spawnSync(process.execPath, [linkedEntrypoint, "--target=test-central"], {
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('deploymentTargetId: "test-central"');
  });
});
