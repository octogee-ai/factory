import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
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
    expect(rendered).toContain('platformComputeClass: "octogee-platform-test-spot"');
    expect(rendered).toContain(`networkPolicy:
  enforceDefaultDeny: true
  controlPlaneCidr: "172.20.16.16/28"
  privateServicesCidr: "172.24.0.0/16"`);
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
    expect(rendered).toContain(
      'MM_URL: "http://mattermost.octogee-test-west.svc.cluster.local:8065"',
    );
    expect(rendered).toContain(
      'MM_INTERNAL_URL: "http://mattermost.octogee-test-west.svc.cluster.local:8065"',
    );
    expect(rendered).toContain(
      'loggingResourceName: "projects/octogee/locations/global/buckets/ops-agent-test-west/views/ops-agent"',
    );
    expect(rendered).toContain(`edgeIngress:
  staticIpName: "workspace-api-ip-test-west"`);
    expect(rendered).toContain(`gateway-edge:
  ingress:
    staticIpName: "workspace-api-ip-test-west"`);
    expect(rendered).toContain(`mattermost:
  ingress:
    staticIpName: "mattermost-ip-test-west"`);
    expect(rendered).toContain(`gitea:
  webIngress:
    staticIpName: "gitea-ip-test-west"`);
    expect(rendered).toContain(`gatewayFleet:
  previewIngress:
    staticIpName: "preview-ip-test-west"`);
    expect(rendered).not.toContain("mattermost.octogee-test.svc.cluster.local");
    expect(rendered).not.toContain("buckets/ops-agent-test/views/ops-agent");
    expect(rendered).not.toContain("us-central1");
    expect(rendered).not.toContain("@octogee-test.iam.gserviceaccount.com");
  });

  it.each([
    ["prod-central", "workspace-api-ip", "mattermost-ip", "gitea-ip", "preview-ip"],
    ["prod-west", "workspace-api-ip-west", "mattermost-ip-west", "gitea-ip-west", "preview-ip-west"],
    ["test-central", "workspace-api-ip-test", "mattermost-ip-test", "gitea-ip-test", "preview-ip-test"],
    ["test-west", "workspace-api-ip-test-west", "mattermost-ip-test-west", "gitea-ip-test-west", "preview-ip-test-west"],
    ["build-week-central", "workspace-api-ip-build-week", "mattermost-ip-build-week", "gitea-ip-build-week", "preview-ip-build-week"],
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

  it.each(["prod-central", "test-central", "build-week-central"])(
    "does not enable the WEST network boundary for frozen central target %s",
    (targetId) => {
      const rendered = renderDeploymentTargetHelmValues(deploymentTargetSettings(targetId));
      expect(rendered).toContain("enforceDefaultDeny: false");
    },
  );

  it("runs through a symlinked temporary-worktree entrypoint", () => {
    const temp = mkdtempSync(path.join(tmpdir(), "octogee-helm-renderer-entrypoint-"));
    const linkedEntrypoint = path.join(temp, "render-deployment-target-helm-values.js");
    symlinkSync(
      path.resolve(import.meta.dirname, "../dist/render-deployment-target-helm-values.js"),
      linkedEntrypoint,
    );

    const result = spawnSync(process.execPath, [linkedEntrypoint, "--target=test-west"], {
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('deploymentTargetId: "test-west"');
  });
});
