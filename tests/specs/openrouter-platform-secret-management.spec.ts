import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../..");

describe("OpenRouter platform secret management", () => {
  it("setup-secrets requires and materializes the OpenRouter platform key for LLM Broker and Ops", () => {
    const script = readFileSync(path.join(repoRoot, "platform/scripts/setup-secrets.sh"), "utf8");

    expect(script).toContain('info "octogee-openrouter"');
    expect(script).toContain('ksecret octogee-openrouter --from-literal=api_key="$OPENROUTER_API_KEY"');
    expect(script).toContain('[[ -n "$OPENROUTER_API_KEY" ]] || fail "OPENROUTER_API_KEY not found in .env or Secret Manager"');
    const verify = readFileSync(path.join(repoRoot, "platform/scripts/verify-secrets.sh"), "utf8");
    expect(verify).toContain('"octogee-openrouter"');
    expect(verify).toContain('"octogee-openrouter:api_key:./scripts/setup-secrets.sh ${FIX_SUFFIX}"');
  });

  it("creates and verifies a dedicated Ops Agent bearer", () => {
    const setup = readFileSync(path.join(repoRoot, "platform/scripts/setup-secrets.sh"), "utf8");
    const verify = readFileSync(path.join(repoRoot, "platform/scripts/verify-secrets.sh"), "utf8");
    expect(setup).toContain('info "ops-agent-bearer"');
    expect(setup).toContain('sm_get "OPS_AGENT_BEARER_TOKEN"');
    expect(setup).toContain('ksecret ops-agent-bearer --from-literal=bearer_token="$OPS_AGENT_BEARER_TOKEN"');
    expect(verify).toContain('"ops-agent-bearer"');
    expect(verify).toContain('"ops-agent-bearer:bearer_token:./scripts/setup-secrets.sh ${FIX_SUFFIX}"');
  });
});
