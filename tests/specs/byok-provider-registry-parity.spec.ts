import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PROVIDERS } from "../../scripts/lib/byot-multi-provider-config.js";
import {
  SUPPORTED,
  CANONICAL_BASE_URL,
} from "../../gateway-edge/src/billing/provider-key-format.js";

// The BYOK provider list lives in three places that MUST agree, or a new
// provider "works" in one layer and fails at runtime in another (exactly the
// #1726 review finding). This pins them together so adding a provider to one
// without the others fails CI:
//   1. scripts/lib byot-multi-provider-config PROVIDERS (api_key entries) — what byot-sync materializes
//   2. gateway-edge provider-key-format SUPPORTED — what the /byot-key route accepts + probes
//   3. scripts/secret-resolver.mjs BYOK_ID_RE — what the gateway resolver will resolve

const repoRoot = path.resolve(__dirname, "../..");

const apiKeyProviders = Object.entries(PROVIDERS)
  .filter(([, spec]) => spec.mode === "api_key")
  .map(([id]) => id)
  .sort();

function resolverGrammarProviders(): string[] {
  const src = readFileSync(path.join(repoRoot, "scripts/secret-resolver.mjs"), "utf8");
  const m = src.match(/\(\?<provider>([^)]+)\)/);
  if (!m) throw new Error("could not find the BYOK_ID_RE provider group in secret-resolver.mjs");
  return m[1].split("|").sort();
}

describe("BYOK provider registry parity (scripts PROVIDERS ↔ route ↔ resolver)", () => {
  it("gateway-edge SUPPORTED == scripts PROVIDERS api_key providers", () => {
    expect([...SUPPORTED].sort()).toEqual(apiKeyProviders);
  });

  it("the secret-resolver grammar accepts exactly the api_key providers", () => {
    expect(resolverGrammarProviders()).toEqual(apiKeyProviders);
  });

  it("CANONICAL_BASE_URL matches scripts PROVIDERS.baseUrl for every canonical provider", () => {
    for (const [provider, baseUrl] of Object.entries(CANONICAL_BASE_URL)) {
      const spec = PROVIDERS[provider as keyof typeof PROVIDERS];
      expect(spec, `${provider} missing from PROVIDERS`).toBeDefined();
      expect(spec.baseUrl).toBe(baseUrl);
    }
  });
});
