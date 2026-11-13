import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

describe("platform-sponsored web research secrets", () => {
  it("materializes optional Brave and Tavily keys for the trusted API broker", () => {
    const setup = read("scripts/setup-secrets.sh");
    expect(setup).toContain('ksecret octogee-brave --from-literal=key="$BRAVE_API_KEY"');
    expect(setup).toContain("ksecret octogee-tavily");
    expect(setup).toContain('--from-literal=api_key="$TAVILY_API_KEY"');
    expect(setup).toContain('--from-literal=cost_per_credit_usd="$TAVILY_COST_PER_CREDIT_USD"');
  });
});
