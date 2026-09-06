import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../..");
const read = (relativePath: string) =>
  readFileSync(path.join(repoRoot, relativePath), "utf8");

describe("Builder boot base", () => {
  const dockerfile = read("infra/gateway/Dockerfile.builder-base");

  it("inherits the full OpenClaw base and installs controlled groups without the operator image", () => {
    expect(dockerfile).toContain("ARG GATEWAY_BASE_IMAGE");
    expect(dockerfile).toContain("FROM ${GATEWAY_BASE_IMAGE}");
    expect(dockerfile).not.toContain("TOOLKIT_IMAGE");
    expect(dockerfile).not.toContain("Dockerfile.operator-toolkit");

    expect(dockerfile).toContain("DEBIAN_PACKAGES=");
    expect(dockerfile).toContain("standaloneTools.gcloud.version");
    expect(dockerfile).toContain("/usr/lib/google-cloud-sdk");
    expect(dockerfile).toContain("/usr/local/bin/terraform");
    expect(dockerfile).not.toContain("operator-tools.versions");
  });

  it("bakes non-npm workstation groups while leaving npm payloads for hydration", () => {
    expect(dockerfile).toMatch(
      /COPY[^\n]*stamp-claude-first-run\.mjs[^\n]*\/octogee\/infra\/gateway\/stamp-claude-first-run\.mjs/,
    );
    expect(dockerfile).not.toContain("claude-wrapper.sh");
    expect(dockerfile).not.toContain("claude-real");
    expect(dockerfile).toContain("apt-get install -y --no-install-recommends $DEBIAN_PACKAGES");
    expect(dockerfile).toContain("pip3 install --break-system-packages --no-cache-dir");
    expect(dockerfile).not.toContain("COPY --from=builder-toolchain-validation /tmp/builder-toolchain-validation/node_modules");
    expect(dockerfile).not.toContain("apply-gateway-class-policy.mjs");
    expect(dockerfile).toMatch(/USER\s+node\s*$/m);
  });
});

describe.each([
  "cloudbuild-operator-final.yaml",
  "cloudbuild-operator-final-extra.yaml",
])("%s Builder base selection", (file) => {
  const source = read(file);

  it("selects the Builder base while preserving the shipped image", () => {
    expect(source).toContain('_BUILDER_BASE_IMAGE: "octogee-gateway-builder-base"');
    expect(source).toContain("_BUILDER_BASE_TAG:");
    expect(source).not.toContain("_OPERATOR_BASE_IMAGE");
    expect(source).not.toContain("_OPERATOR_BASE_TAG");
    expect(source).toContain('_PROFILE_IMAGE: "octogee-gateway-builder"');
  });
});

describe("Builder base build authority", () => {
  const workflow = read(".github/workflows/gateway-build-operator-base.yml");
  const buildConfig = read("cloudbuild-builder-base.yaml");

  it("keys the immutable intermediate from its gateway base and complete recipe", () => {
    for (const input of [
      "infra/gateway/Dockerfile.builder-base",
      "cloudbuild-builder-base.yaml",
      "infra/gateway/builder-toolchain/package.json",
      "infra/gateway/builder-toolchain/package-lock.json",
      "infra/gateway/builder-toolchain/groups.json",
      "infra/gateway/stamp-claude-first-run.mjs",
    ]) {
      expect(workflow).toContain(input);
    }
    expect(workflow).toContain(
      'builder_base_tag=${GATEWAY_BASE_TAG}-builder-${BUILDER_BASE_INPUT_HASH}',
    );
    expect(buildConfig).toContain(
      '"$$BUILDER_BASE_TAG" == "$${GATEWAY_BASE_TAG}-builder-$${BUILDER_INPUT_HASH}"',
    );
    expect(buildConfig).not.toContain(":latest");
    expect(buildConfig).toContain('_GATEWAY_BASE_IMAGE: "octogee-gateway-base"');
    expect(buildConfig).not.toContain("GATEWAY_CORE_IMAGE");
    expect(workflow).toContain('SENTINEL="${AR_REPO}/octogee-gateway-base:${GATEWAY_BASE_TAG}"');
  });

  it("builds the Builder base and final image in one job without scheduling the operator toolkit or base", () => {
    expect(workflow).not.toContain("  builder-base:");
    expect(workflow).not.toContain("needs.builder-base");
    expect(workflow).toContain("  operator-image:\n    needs: matrix-setup\n");
    expect(workflow).toContain(
      'echo "builder_base_tag=${{ needs.matrix-setup.outputs.canonical_builder_base_tag }}" >> "$GITHUB_OUTPUT"',
    );
    expect(workflow).toContain(
      "_BUILDER_BASE_TAG=${{ steps.vars.outputs.builder_base_tag }}",
    );
    const baseBuild = workflow.indexOf("name: Build Builder base");
    const finalBuild = workflow.indexOf("name: Build Builder final image from Builder base");
    expect(baseBuild).toBeGreaterThan(workflow.indexOf("  operator-image:"));
    expect(finalBuild).toBeGreaterThan(baseBuild);
    expect(workflow).not.toContain("  operator-toolkit:");
    expect(workflow).not.toContain("  operator-base:");
    expect(workflow).not.toContain("cloudbuild-operator-toolkit.yaml");
    expect(workflow).not.toContain("cloudbuild-operator-base.yaml");
  });
});
