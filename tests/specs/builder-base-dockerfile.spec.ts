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
