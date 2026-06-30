import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../..");

describe("OpenRouter platform secret management", () => {
  it("setup-secrets materializes the optional OpenRouter platform key for LLM Broker", () => {
    const script = readFileSync(path.join(repoRoot, "scripts/setup-secrets.sh"), "utf8");

    expect(script).toContain('info "octogee-openrouter"');
    expect(script).toContain('ksecret octogee-openrouter --from-literal=api_key="$OPENROUTER_API_KEY"');
    expect(script).toContain("OPENROUTER_API_KEY not found in .env or Secret Manager");
  });
});
