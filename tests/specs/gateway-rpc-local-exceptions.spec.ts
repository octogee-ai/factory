import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "../..");

function source(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), "utf8");
}

function expectLocalGatewayRpcException(rel: string): void {
  expect(source(rel), `${rel} must explicitly opt into the temporary local gateway-token bridge`)
    .toMatch(/createGatewayRpc\(\s*\{[\s\S]*?allowLegacyGatewayTokenFallback:\s*true/);
}

describe("gateway-rpc local credential exceptions", () => {
  it("keeps the db-less fleet controller on the explicit local token bridge", () => {
    expectLocalGatewayRpcException("scripts/entrypoints/fleet-controller.ts");
  });

  it("keeps config.patch helper on the explicit local token bridge", () => {
    expectLocalGatewayRpcException("scripts/lib/apply-config-patch.ts");
  });
});
