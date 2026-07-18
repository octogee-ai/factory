import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(import.meta.dirname, "../index.ts"), "utf8");

describe("API-server egress runtime wiring", () => {
  it("threads one live-CIDR config preparer through every durable Helm render path", () => {
    expect(source).toContain(
      "createGatewayRuntimeConfigPreparer(resolveApiServerEgressCidrs)",
    );
    expect(source).toMatch(/runGatewayConvergencePass\(\{[\s\S]*?prepareGatewayConfig,/u);
    expect(source).toMatch(/const prepared = artifact \? await passDeps\.prepareGatewayConfig\(gateway\) : null;/u);
    expect(source).toMatch(/const config = await prepareGatewayConfig\(root\);/u);
  });
});
