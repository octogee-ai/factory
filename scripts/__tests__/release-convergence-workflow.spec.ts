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
describe("tagged gateway release desired-state workflow", () => {
  it("ends CI authority at the desired-state write", () => {
    expect(workflow).toContain("update-environment-desired-state:");
    expect(workflow).not.toContain("capture-release-convergence-baseline:");
    expect(workflow).not.toContain("verify-release-convergence:");
    expect(workflow).not.toContain("ops/capture-release-convergence-baseline.ts");
    expect(workflow).not.toContain("ops/verify-release-convergence.ts");
  });

  it("promotes desired state directly after release authority", () => {
    expect(workflow).toMatch(
      /update-environment-desired-state:\n\s+needs: \[matrix-setup, alias-with-oc-version, promotion-authority\]/,
    );
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
