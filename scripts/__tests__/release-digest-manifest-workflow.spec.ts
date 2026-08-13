import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  resolve(import.meta.dirname, "../../.github/workflows/releasev2.yml"),
  "utf8",
);

describe("releasev2 digest manifest", () => {
  it("writes a full-SHA manifest after a main build and promotes only its recorded digests", () => {
    expect(workflow).toMatch(
      /write-release-digest-manifest:\n\s+needs: \[resolve, detect-release-scope, resolve-release-digest-manifest, gateway-artifacts, platform, gateway\]/,
    );
    expect(workflow).toContain("release-digest-manifest:${SOURCE_SHA}");
    expect(workflow).toContain("release-digest-manifest:${RELEASE_SHA}");
    expect(workflow).toContain("release-digest-manifest.mjs create");
    expect(workflow).toContain("release-digest-manifest.mjs alias-plan");
  });

  it("cannot publish when manifest resolution fails or a changed-scope build is skipped", () => {
    const writer = workflow.slice(
      workflow.indexOf("  write-release-digest-manifest:"),
      workflow.indexOf("  site:"),
    );

    expect(writer).toContain("needs.resolve-release-digest-manifest.result == 'success'");
    expect(writer).toContain("needs.detect-release-scope.outputs.run_platform == 'true' &&");
    expect(writer).toContain("needs.gateway-artifacts.result == 'success'");
    expect(writer).toContain("needs.platform.result == 'success'");
    expect(writer).toContain("needs.detect-release-scope.outputs.run_gateway == 'true' &&");
    expect(writer).toContain("needs.gateway.result == 'success'");
    expect(writer).not.toContain("needs.gateway-artifacts.result == 'success' || needs.gateway-artifacts.result == 'skipped'");
    expect(writer).not.toContain("needs.platform.result == 'success' || needs.platform.result == 'skipped'");
    expect(writer).not.toContain("needs.gateway.result == 'success' || needs.gateway.result == 'skipped'");
  });

  it("deploys the site only after one successful immutable manifest promotion path", () => {
    const site = workflow.slice(workflow.indexOf("  site:"));

    expect(workflow).toContain("site-release-authority:");
    expect(workflow).toContain("site-deployment-authority.mjs");
    expect(site).toContain("site-release-authority");
    expect(site).toContain("needs.site-release-authority.outputs.authorized == 'true'");
  });

  it("authors manifests only from full-SHA provenance tags", () => {
    const missingWriter = workflow.slice(
      workflow.indexOf("  write-missing-release-digest-manifest:"),
      workflow.indexOf("  promote-built-digests:"),
    );
    const writer = workflow.slice(
      workflow.indexOf("  write-release-digest-manifest:"),
      workflow.indexOf("  site:"),
    );

    expect(missingWriter).toContain('ref = f"{os.environ[\'AR_REPO\']}/{image}:{os.environ[\'RELEASE_SHA\']}"');
    expect(missingWriter).not.toContain("RELEASE_SHA'][:7]");
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

  it("removes the GitHub run-history walk from release promotion", () => {
    const promotion = workflow.slice(
      workflow.indexOf("  promote-main-digests:"),
      workflow.indexOf("  gateway-artifacts:"),
    );

    expect(promotion).not.toContain("gh api --paginate");
    expect(promotion).not.toContain("source_for_surface");
    expect(promotion).toContain("release-digest-manifest.mjs alias-plan");
  });

  it("builds a complete exact-SHA image set before creating and aliasing a missing release manifest", () => {
    expect(workflow).toMatch(
      /resolve-release-digest-manifest:[\s\S]*?outputs:[\s\S]*?exists:/,
    );
    expect(workflow).toMatch(
      /write-missing-release-digest-manifest:\n\s+needs: \[resolve, detect-release-scope, resolve-release-digest-manifest, gateway-artifacts, platform\]/,
    );
    expect(workflow).toMatch(
      /promote-built-digests:\n\s+needs: \[resolve, detect-release-scope, resolve-release-digest-manifest, write-missing-release-digest-manifest\]/,
    );
    expect(workflow).toMatch(
      /gateway:\n\s+needs: \[resolve, detect-release-scope, resolve-release-digest-manifest, promote-main-digests, gateway-artifacts, platform, write-missing-release-digest-manifest, promote-built-digests, platform-after-manifest\]/,
    );

    const missingManifest = workflow.slice(
      workflow.indexOf("  write-missing-release-digest-manifest:"),
      workflow.indexOf("  promote-built-digests:"),
    );
    expect(missingManifest).toContain('"artifact-worker", "gateway-edge", "glm-controller", "octogee-api", "octogee-project-runner"');
    expect(missingManifest).toContain('"octogee-gateway", "octogee-gateway-builder", "octogee-ops-agent"');
    expect(missingManifest).not.toContain("BASE_SHA");
    expect(missingManifest).not.toContain("baseline");
  });

  it("builds a missing manifest without deploying platform state, then aliases it before the platform deploy path", () => {
    const platformBuild = workflow.slice(
      workflow.indexOf("  platform:"),
      workflow.indexOf("  write-missing-release-digest-manifest:"),
    );
    const missingPromotion = workflow.slice(
      workflow.indexOf("  promote-built-digests:"),
      workflow.indexOf("  platform-after-manifest:"),
    );
    const platformDeploy = workflow.slice(
      workflow.indexOf("  platform-after-manifest:"),
      workflow.indexOf("  gateway:"),
    );

    expect(platformBuild).toContain("deploy: ${{ needs.resolve-release-digest-manifest.outputs.exists == 'true' && needs.resolve.outputs.deploy || 'false' }}");
    expect(missingPromotion).toContain("release-digest-manifest.mjs reference");
    expect(platformDeploy).toMatch(
      /needs: \[resolve, detect-release-scope, resolve-release-digest-manifest, promote-built-digests\]/,
    );
    expect(platformDeploy).toContain("deploy: ${{ 'true' }}");
  });

  it("serializes every writer by source SHA and gives downstream consumers a verified OCI digest pin", () => {
    const mainWriter = workflow.slice(
      workflow.indexOf("  write-release-digest-manifest:"),
      workflow.indexOf("  site:"),
    );
    const missingWriter = workflow.slice(
      workflow.indexOf("  write-missing-release-digest-manifest:"),
      workflow.indexOf("  promote-built-digests:"),
    );
    const existingPromotion = workflow.slice(
      workflow.indexOf("  promote-main-digests:"),
      workflow.indexOf("  gateway-artifacts:"),
    );

    for (const writer of [mainWriter, missingWriter]) {
      expect(writer).toContain("group: release-digest-manifest-${{ github.sha }}");
      expect(writer).toContain("manifest_digest=");
      expect(writer).toContain("release-digest-manifest@${manifest_digest}");
      expect(writer).toContain("after writing immutable manifest");
    }
    expect(existingPromotion).toContain("release-digest-manifest.mjs reference");
  });

  it("supplies an inert command when creating containers from scratch manifest images", () => {
    const containerCreates = workflow.match(/docker create [^\n]+/g) ?? [];

    expect(containerCreates).toHaveLength(4);
    for (const create of containerCreates) {
      expect(create).toContain("/bin/true");
    }
  });

  it("creates a release alias with create-only semantics and accepts only an identical concurrent winner", () => {
    const existingPromotion = workflow.slice(
      workflow.indexOf("  promote-main-digests:"),
      workflow.indexOf("  gateway-artifacts:"),
    );
    const builtPromotion = workflow.slice(
      workflow.indexOf("  promote-built-digests:"),
      workflow.indexOf("  platform-after-manifest:"),
    );

    for (const promotion of [existingPromotion, builtPromotion]) {
      expect(promotion).not.toContain('2>/dev/null)"; then');
      expect(promotion).toContain("resolve-tag-digest.sh");
      expect(promotion).toContain('if [ "$lookup_status" = "3" ]; then');
      expect(promotion).toContain("could not resolve immutable release alias ${target}");
      expect(promotion).toContain("gcloud artifacts tags create");
      expect(promotion).not.toContain("gcloud artifacts docker tags add");
      expect(promotion).toContain("release-digest-alias-create.err");
      expect(promotion).toContain("could not create immutable release alias ${target}");
    }
  });

  it("resolves every manual or reusable run while limiting missing-manifest writes to deploys", () => {
    const resolver = workflow.slice(
      workflow.indexOf("  resolve-release-digest-manifest:"),
      workflow.indexOf("  promote-main-digests:"),
    );
    const missingWriter = workflow.slice(
      workflow.indexOf("  write-missing-release-digest-manifest:"),
      workflow.indexOf("  promote-built-digests:"),
    );

    expect(resolver).not.toContain("needs.resolve.outputs.deploy == 'true'");
    expect(missingWriter).toContain("needs.resolve.outputs.deploy == 'true'");
    expect(resolver).not.toContain("github.event_name == 'release' ||");
  });

  it("resolves an existing manifest before build-only force rebuilds can write its SHA tags", () => {
    const resolver = workflow.slice(
      workflow.indexOf("  resolve-release-digest-manifest:"),
      workflow.indexOf("  promote-main-digests:"),
    );
    const gatewayArtifacts = workflow.slice(
      workflow.indexOf("  gateway-artifacts:"),
      workflow.indexOf("  platform:"),
    );
    const platform = workflow.slice(
      workflow.indexOf("  platform:"),
      workflow.indexOf("  write-missing-release-digest-manifest:"),
    );

    expect(resolver).not.toContain("needs.resolve.outputs.deploy == 'true'");
    expect(resolver).toContain("needs.resolve.result == 'success'");
    expect(gatewayArtifacts).toContain(
      "needs.resolve-release-digest-manifest.outputs.exists == 'true' && 'false' || needs.resolve.outputs.force_rebuild",
    );
    expect(platform).toContain(
      "needs.resolve-release-digest-manifest.outputs.exists == 'true' && 'false' || needs.resolve.outputs.force_rebuild",
    );
  });

  // A published manifest is immutable, so schema-gating it can only ever fail a
  // build over history nobody can change — which is exactly how the schemaVersion 3
  // baseline for e73417174 killed the release for b19f92b24 after all seven images
  // had built. An absent baseline is already tolerated a few lines down, and an old
  // one is strictly more useful than none, so the baseline is read, never judged.
  it("reads the baseline manifest as a lookup table instead of schema-gating it", () => {
    const writer = workflow.slice(
      workflow.indexOf("  write-release-digest-manifest:"),
      workflow.indexOf("  site:"),
    );

    expect(writer).not.toContain("release-digest-manifest.mjs validate");
    expect(writer).toContain('prior.get("surfaces"');
    expect(writer).toContain("confirmed absent baseline manifest");
    expect(writer).toContain("could not read baseline digest manifest");
  });

  it("allows the first v2 build to read a v1 baseline without carrying forward an absent runner", () => {
    const writer = workflow.slice(
      workflow.indexOf("  write-release-digest-manifest:"),
      workflow.indexOf("  site:"),
    );

    expect(writer).toContain('"octogee-api", "octogee-project-runner"');
    expect(writer).toContain('"baselineImages": baseline');
    expect(writer).toContain("release-digest-manifest.mjs create-main-build");
  });

  it("carries a main image digest forward only after its exact SHA tag is confirmed absent", () => {
    const writer = workflow.slice(
      workflow.indexOf("  write-release-digest-manifest:"),
      workflow.indexOf("  site:"),
    );

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

  it("uses recorded manifest bytes instead of force-rebuilding an authoritative release", () => {
    const gatewayArtifacts = workflow.slice(
      workflow.indexOf("  gateway-artifacts:"),
      workflow.indexOf("  platform:"),
    );
    const platform = workflow.slice(
      workflow.indexOf("  platform:"),
      workflow.indexOf("  write-missing-release-digest-manifest:"),
    );
    const gateway = workflow.slice(
      workflow.indexOf("  gateway:"),
      workflow.indexOf("  write-release-digest-manifest:"),
    );
    const authoritativeForce = "needs.resolve-release-digest-manifest.outputs.exists == 'true' && 'false' ||";

    expect(gatewayArtifacts).toContain(`force_rebuild: \${{ ${authoritativeForce} needs.resolve.outputs.force_rebuild }}`);
    expect(platform).toContain(`force_rebuild: \${{ ${authoritativeForce} needs.resolve.outputs.force_rebuild }}`);
    expect(gateway).toContain(authoritativeForce);
  });
});
