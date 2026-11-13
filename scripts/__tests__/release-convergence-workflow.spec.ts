import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const verifyEnv = readFileSync(
  path.resolve(__dirname, "../verify-env.sh"),
  "utf8",
);
describe("gateway image build workflow", () => {

  it("does not retain the now-uninvoked convergence-baseline capture entrypoint", () => {
    expect(existsSync(path.resolve(__dirname, "../ops/capture-release-convergence-baseline.ts"))).toBe(false);
  });
});

describe("verify-env shared pool selection", () => {
  it("probes the shared slots the fleet controller minted instead of the first Deployment", () => {
    expect(verifyEnv).toContain("octogee_list_shared_gateway_deployments <<<");
    expect(verifyEnv).toContain("SHARED_POOL_MIN_REPLICAS");
    expect(verifyEnv).not.toContain("octogee_resolve_default_gateway_deployment");
    expect(verifyEnv).not.toContain("-l app=octogee-gateway -o jsonpath='{.items[0].metadata.name}'");
  });
});
