import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../..");
const read = (relativePath: string) =>
  readFileSync(path.join(repoRoot, relativePath), "utf8");

describe("Builder boot base", () => {
  const dockerfile = read("infra/gateway/Dockerfile.builder-base");

  it("inherits the OpenClaw gateway base without the operator toolkit", () => {
    expect(dockerfile).toContain("ARG GATEWAY_BASE_IMAGE");
    expect(dockerfile).toContain("FROM ${GATEWAY_BASE_IMAGE}");
    expect(dockerfile).not.toContain("TOOLKIT_IMAGE");
    expect(dockerfile).not.toContain("Dockerfile.operator-toolkit");

    for (const operatorPayload of [
      "/usr/lib/google-cloud-sdk",
      "firebase-tools",
      "/usr/bin/kubectl",
      "/usr/bin/terraform",
      "/usr/local/bin/helm",
      "/usr/local/bin/yq",
      "operator-tools.versions",
    ]) {
      expect(dockerfile).not.toContain(operatorPayload);
    }
  });

  it("adds only the pre-hydration Builder launch contract", () => {
    expect(dockerfile).toMatch(
      /COPY[^\n]*stamp-claude-first-run\.mjs[^\n]*\/octogee\/infra\/gateway\/stamp-claude-first-run\.mjs/,
    );
    expect(dockerfile).not.toContain("claude-wrapper.sh");
    expect(dockerfile).not.toContain("claude-real");
    expect(dockerfile).not.toContain("apt-get");
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
  });

  it("builds Builder images without scheduling the operator toolkit or base", () => {
    expect(workflow).toContain("  builder-base:");
    expect(workflow).toContain("needs: [builder-base, matrix-setup]");
    expect(workflow).toContain(
      "_BUILDER_BASE_TAG=${{ needs.builder-base.outputs.tag }}",
    );
    expect(workflow).not.toContain("  operator-toolkit:");
    expect(workflow).not.toContain("  operator-base:");
    expect(workflow).not.toContain("cloudbuild-operator-toolkit.yaml");
    expect(workflow).not.toContain("cloudbuild-operator-base.yaml");
  });
});
