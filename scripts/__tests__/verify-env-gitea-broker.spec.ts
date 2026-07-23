import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const testDir = dirname(fileURLToPath(import.meta.url));
const script = readFileSync(resolve(testDir, "../verify-env.sh"), "utf8");
const probeHelper = readFileSync(resolve(testDir, "../lib/ready-assigned-gateway-probe.sh"), "utf8");

describe("verify-env Gitea gateway contract", () => {
  it("selects a Ready assigned gateway before the authenticated read-only broker probe", () => {
    expect(script).toContain('source "$SCRIPT_DIR/lib/ready-assigned-gateway-probe.sh"');
    expect(script).toContain('probe_ready_assigned_gateway_gitea_broker "$K8S_CONTEXT" "$NAMESPACE"');
    expect(probeHelper).toContain("/octogee/scripts/entrypoints/gitea-broker-probe.ts");
    expect(probeHelper).toContain("!process.env.GIT_API_TOKEN");
    expect(script).not.toContain("fetch(u+'/health')");
    expect(script).not.toContain("const t=process.env.GIT_API_TOKEN||''");
  });
});
