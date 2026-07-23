import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  path.resolve(__dirname, "../../.github/workflows/gateway-build-operator-base.yml"),
  "utf8",
);
const verifyEnv = readFileSync(
  path.resolve(__dirname, "../verify-env.sh"),
  "utf8",
);

describe("tagged gateway release convergence workflow", () => {
  it("captures the configured default baseline before desired state is promoted", () => {
    expect(workflow).toContain("capture-release-convergence-baseline:");
    expect(workflow).toMatch(
      /update-environment-desired-state:\n\s+needs: \[[^\]]*capture-release-convergence-baseline[^\]]*\]/,
    );
    expect(workflow).toContain("ops/capture-release-convergence-baseline.ts");
  });

  it("blocks workflow success on a 45-minute convergence check", () => {
    expect(workflow).toContain("verify-release-convergence:");
    expect(workflow).toContain("timeout-minutes: 50");
    expect(workflow).toContain("--timeout-ms=2700000");
    expect(workflow).toContain("ops/verify-release-convergence.ts");
  });

  it("installs the GKE credential plugin before each convergence cluster selection", () => {
    for (const [job, nextJob] of [
      ["capture-release-convergence-baseline:", "update-environment-desired-state:"],
      ["verify-release-convergence:", undefined],
    ]) {
      const jobSource = workflow.slice(
        workflow.indexOf(job),
        nextJob ? workflow.indexOf(nextJob) : workflow.length,
      );

      expect(jobSource.indexOf("Install gke-gcloud-auth-plugin")).toBeGreaterThan(-1);
      expect(jobSource.indexOf("Install gke-gcloud-auth-plugin")).toBeLessThan(
        jobSource.indexOf("Select cluster"),
      );
    }
  });

  it("reads the environment Discord Ops webhook for failed convergence", () => {
    expect(workflow).toContain("secret/discord-ops-webhook");
    expect(workflow).toContain("DISCORD_OPS_WEBHOOK_URL");
  });
});

describe("verify-env configured default selection", () => {
  it("selects the configured default gateway instead of the first Deployment", () => {
    expect(verifyEnv).toContain("config/orchestrator");
    expect(verifyEnv).toContain('gateway-instance=$DEFAULT_GATEWAY_ID"');
    expect(verifyEnv).not.toContain("-l app=octogee-gateway -o jsonpath='{.items[0].metadata.name}'");
  });
});
