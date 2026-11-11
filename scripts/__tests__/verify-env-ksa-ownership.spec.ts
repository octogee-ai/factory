import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const script = readFileSync(resolve(import.meta.dirname, "../verify-env.sh"), "utf8");
const ownershipSection = script.slice(
  script.indexOf('header "5c. Fleet controller gateway ServiceAccount ownership"'),
  script.indexOf("# ── 5e. Gateway Storage Mode"),
);
const validator = ownershipSection.match(/python3 -c '\n(?<source>[\s\S]+?)\n' "\$TARGET_ID"\);/)?.groups?.source;

function validate(payload: unknown) {
  if (!validator) throw new Error("KSA ownership validator is missing from verify-env.sh");
  return spawnSync("python3", ["-c", validator, "test-west"], {
    encoding: "utf8",
    input: JSON.stringify(payload),
  });
}

function dynamicServiceAccount(labels: Record<string, string>) {
  return {
    items: [{ metadata: { name: "octogee-gw-builder-a", labels } }],
  };
}

describe("verify-env gateway ServiceAccount ownership contract", () => {
  it("fails on an unlabeled dynamic gateway KSA while leaving static platform KSAs to Helm", () => {
    expect(ownershipSection).toContain('header "5c. Fleet controller gateway ServiceAccount ownership"');
    expect(script).toContain('kubectl --context "$K8S_CONTEXT" get serviceaccounts -n "$NAMESPACE" -o json');
    expect(script).toContain('name.startswith("octogee-gw-")');
    expect(script).toContain('"octogee.ai/controller": "cowboy"');
    expect(script).toContain('"app.kubernetes.io/managed-by": "glm-controller"');
    expect(script).toContain('"octogee.ai/deployment-target": target');
    expect(script).toContain('"octogee.ai/release": name');
    expect(script).toContain('"octogee.ai/lifecycle-identity": f"gateway-{gateway_id}"');
    expect(script).toContain("unlabeled or incorrectly owned dynamic gateway KSA");
  });

  it("accepts valid fleet controller and static KSAs, rejects malformed and mismatched fixtures", () => {
    const valid = validate(dynamicServiceAccount({
      "app.kubernetes.io/managed-by": "glm-controller",
      "octogee.ai/controller": "cowboy",
      "octogee.ai/deployment-target": "test-west",
      "octogee.ai/gateway-id": "builder-a",
      "octogee.ai/release": "octogee-gw-builder-a",
      "octogee.ai/lifecycle-identity": "gateway-builder-a",
    }));
    expect(valid.status).toBe(0);
    expect(valid.stdout.trim()).toBe("");

    const wrong = validate(dynamicServiceAccount({}));
    expect(wrong.status).toBe(1);
    expect(wrong.stdout).toContain("octogee.ai/controller");

    const staticAccount = validate({ items: [{ metadata: { name: "octogee-api", labels: {} } }] });
    expect(staticAccount.status).toBe(0);
    expect(staticAccount.stdout.trim()).toBe("");

    const malformed = validate([]);
    expect(malformed.status).not.toBe(0);
  });
});
