import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const setupMonitoring = readFileSync(
  resolve(root, "scripts/setup-monitoring.sh"),
  "utf8",
);

describe("monitoring setup", () => {
  it("waits for the managed rule evaluator after applying ClusterRules", () => {
    const rulesApply = setupMonitoring.indexOf(
      'kubectl apply -f "$REPO_DIR/helm/monitoring/gmp-rules.yaml"',
    );
    const evaluatorWait = setupMonitoring.indexOf(
      "deployment/rule-evaluator",
      rulesApply,
    );

    expect(rulesApply).toBeGreaterThan(-1);
    expect(evaluatorWait).toBeGreaterThan(rulesApply);
    expect(
      setupMonitoring.slice(evaluatorWait - 180, evaluatorWait + 180),
    ).toMatch(
      /kubectl wait[\s\S]*?--for=jsonpath='\{\.status\.availableReplicas\}'[\s\S]*?--timeout=5m/,
    );
  });
});
