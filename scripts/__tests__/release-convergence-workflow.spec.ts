import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  path.resolve(__dirname, "../../.github/workflows/gateway-build-operator-base.yml"),
  "utf8",
);
const verifyEnv = readFileSync(
  path.resolve(__dirname, "../verify-env.sh"),
  "utf8",
);
describe("gateway image build workflow", () => {
  it("builds images only — desired state is written by Release platform through the fleet CLI", () => {
    expect(workflow).not.toContain("update-environment-desired-state:");
    expect(workflow).not.toContain("promotion-authority:");
    expect(workflow).not.toContain("alias-with-oc-version:");
    expect(workflow).not.toContain("canonical-alias-authority:");
    expect(workflow).not.toContain("promote-gateway.ts");
    expect(workflow).not.toContain("release-state-authority");
    expect(workflow).not.toContain("capture-release-convergence-baseline:");
    expect(workflow).not.toContain("verify-release-convergence:");
    expect(workflow).not.toContain("ops/capture-release-convergence-baseline.ts");
    expect(workflow).not.toContain("ops/verify-release-convergence.ts");
  });

  it("does not retain the now-uninvoked convergence-baseline capture entrypoint", () => {
    expect(existsSync(path.resolve(__dirname, "../ops/capture-release-convergence-baseline.ts"))).toBe(false);
  });
});

describe("verify-env configured default selection", () => {
  it("selects the configured default gateway instead of the first Deployment", () => {
    expect(verifyEnv).toContain("config/orchestrator");
    expect(verifyEnv).toContain(
      'octogee_resolve_default_gateway_deployment "$DEFAULT_GATEWAY_ID"',
    );
    expect(verifyEnv).not.toContain("-l app=octogee-gateway -o jsonpath='{.items[0].metadata.name}'");
  });
});
