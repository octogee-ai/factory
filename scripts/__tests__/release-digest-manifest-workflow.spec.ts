import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  resolve(import.meta.dirname, "../../.github/workflows/build-main.yml"),
  "utf8",
);
const writer = workflow.slice(workflow.indexOf("  digest-manifest:"));

describe("Build main digest manifest", () => {
  it("writes exactly one full-SHA manifest after the main build and never aliases or promotes it", () => {
    expect(workflow.slice(workflow.indexOf("\njobs:\n")).match(/^ {2}[a-z-]+:$/gm)).toEqual([
      "  scope:",
      "  existing-manifest:",
      "  gateway-images:",
      "  platform-images:",
      "  site:",
      "  desktop-image:",
      "  digest-manifest:",
    ]);
    expect(workflow).toContain("release-digest-manifest:${SOURCE_SHA}");
    expect(workflow).toContain("release-digest-manifest.mjs create-main-build");
    expect(workflow).not.toContain("release-digest-manifest.mjs create ");
    expect(workflow).not.toContain("release-digest-manifest.mjs alias-plan");
    expect(workflow).not.toContain("gcloud artifacts tags create");
    expect(workflow).not.toContain("gcloud artifacts docker tags add");
  });

  it("cannot publish when manifest resolution fails or a changed-scope build is skipped", () => {
    expect(writer).toContain("needs.existing-manifest.result == 'success'");
    expect(writer).toContain("needs.gateway-images.result == 'success'");
    expect(writer).toContain("needs.platform-images.result == 'success'");
    expect(writer).toContain("needs.desktop-image.result == 'success'");
    expect(writer).toContain("needs.site.result == 'success'");
    expect(writer).toContain("(needs.site.result == 'skipped' && needs.scope.outputs.run_site != 'true')");
    expect(writer).toContain(
      "needs.scope.outputs.run_platform != 'true' && needs.scope.outputs.run_gateway != 'true'",
    );
    expect(writer).not.toContain("needs.gateway-images.result == 'success' || needs.gateway-images.result == 'skipped'");
    expect(writer).not.toContain("needs.platform-images.result == 'success' || needs.platform-images.result == 'skipped'");
  });

  it("authors manifests only from full-SHA provenance tags", () => {
    expect(writer).toContain('ref = f"{os.environ[\'AR_REPO\']}/{image}:{os.environ[\'SOURCE_SHA\']}"');
    expect(writer).not.toContain("SOURCE_SHA'][:7]");
    const platformBuild = readFileSync(
      resolve(import.meta.dirname, "../../.github/workflows/build-and-deploy.yml"),
      "utf8",
    );
    const gatewayBuild = readFileSync(
      resolve(import.meta.dirname, "../../.github/workflows/gateway-build-operator-base.yml"),
      "utf8",
    );
    expect(platformBuild).toContain("Publish full-SHA platform provenance tags");
    expect(platformBuild).toContain("artifact-worker glm-controller octogee-api octogee-ops-agent octogee-project-runner");
    expect(platformBuild).toContain(
      'bash scripts/lib/publish-full-sha-image-tag.sh "$image"',
    );
    expect(gatewayBuild).toContain("publish-full-sha-provenance:");
    expect(gatewayBuild).toContain("needs: [matrix-setup, build, operator-image]");
    expect(gatewayBuild).toContain("gateway-edge octogee-gateway octogee-gateway-builder");
    expect(gatewayBuild).toContain(
      'bash scripts/lib/publish-full-sha-image-tag.sh "$image"',
    );
  });

  it("serializes the writer by source SHA and gives downstream consumers a verified OCI digest pin", () => {
    expect(writer).toContain("group: release-digest-manifest-${{ github.sha }}");
    expect(writer).toContain("manifest_digest=");
    expect(writer).toContain("release-digest-manifest@${manifest_digest}");
    expect(writer).toContain("after writing immutable manifest");
    expect(writer).toContain("already contains a different immutable manifest");
  });

  it("supplies an inert command when creating containers from scratch manifest images", () => {
    const containerCreates = workflow.match(/docker create [^\n]+/g) ?? [];

    expect(containerCreates).toHaveLength(1);
    for (const create of containerCreates) {
      expect(create).toContain("/bin/true");
    }
  });

  it("resolves an existing manifest before a force rebuild can move its SHA tags", () => {
    const resolver = workflow.slice(
      workflow.indexOf("  existing-manifest:"),
      workflow.indexOf("  gateway-images:"),
    );
    const gatewayImages = workflow.slice(
      workflow.indexOf("  gateway-images:"),
      workflow.indexOf("  platform-images:"),
    );
    const platformImages = workflow.slice(
      workflow.indexOf("  platform-images:"),
      workflow.indexOf("  site:"),
    );
    const authoritativeForce =
      "force_rebuild: ${{ needs.existing-manifest.outputs.exists == 'true' && 'false' || needs.scope.outputs.force_rebuild }}";

    expect(resolver).toContain("resolve-tag-digest.sh");
    expect(resolver).toContain("exists=true");
    expect(resolver).toContain("exists=false");
    expect(gatewayImages).toContain(authoritativeForce);
    expect(platformImages).toContain(authoritativeForce);
  });

  // A published manifest is immutable, so schema-gating it can only ever fail a
  // build over history nobody can change — which is exactly how the schemaVersion 3
  // baseline for e73417174 killed the release for b19f92b24 after all seven images
  // had built. An absent baseline is already tolerated a few lines down, and an old
  // one is strictly more useful than none, so the baseline is read, never judged.
  it("reads the baseline manifest as a lookup table instead of schema-gating it", () => {
    expect(writer).not.toContain("release-digest-manifest.mjs validate");
    expect(writer).toContain('prior.get("surfaces"');
    expect(writer).toContain("confirmed absent baseline manifest");
    expect(writer).toContain("could not read baseline digest manifest");
  });

  it("allows the first v2 build to read a v1 baseline without carrying forward an absent runner", () => {
    expect(writer).toContain('"octogee-api", "octogee-project-runner"');
    expect(writer).toContain('"baselineImages": baseline');
  });

  it("carries a main image digest forward only after its exact SHA tag is confirmed absent", () => {
    expect(writer).toContain("resolve-tag-digest.sh");
    expect(writer).toContain("if result.returncode == 3:");
    expect(writer).toContain("could not resolve SHA-addressed image");
  });

  it("uses structured tag lookup for absence and never parses gcloud error prose", () => {
    expect(workflow).toContain("resolve-tag-digest.sh");
    expect(workflow).not.toContain("NOT_FOUND");
    expect(workflow).not.toContain("[[:space:]]404[[:space:]:]");
    expect(workflow).toContain('if [ "$lookup_status" = "3" ]; then');
  });
});
