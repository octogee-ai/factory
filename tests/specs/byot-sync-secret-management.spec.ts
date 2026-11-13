import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../..");

describe("BYOT sync signing secret management", () => {
  it("setup-secrets creates the dedicated byot-sync-internal secret", () => {
    const script = readFileSync(path.join(repoRoot, "scripts/setup-secrets.sh"), "utf8");

    expect(script).toContain('info "byot-sync-internal"');
    expect(script).toContain("ksecret byot-sync-internal --from-literal=secret=");
  });

  it("verify-secrets treats byot-sync-internal as required", () => {
    const script = readFileSync(path.join(repoRoot, "scripts/verify-secrets.sh"), "utf8");

    expect(script).toContain('"byot-sync-internal"');
    expect(script).toContain('"byot-sync-internal:secret:./scripts/setup-secrets.sh ${FIX_SUFFIX}"');
  });
});
