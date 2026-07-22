import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");
const helper = resolve(repoRoot, "scripts/lib/deployment-target.sh");

function bash(command: string) {
  return spawnSync("bash", ["-c", command], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

describe("deployment target shell loader", () => {
  it("loads a west target without reconstructing regional resource paths", () => {
    const result = bash(`
      source "${helper}"
      octogee_load_deployment_target --target=prod-west
      printf '%s\n' "$TARGET_ID" "$TARGET_REGION" "$TARGET_KUBE_CONTEXT" "$TARGET_AR_REPOSITORY" "$TARGET_CLOUD_SQL_CONNECTION" "$TARGET_CLOUD_SQL_PITR_ENABLED" "$TARGET_KMS_KEY_NAME"
    `);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "prod-west",
      "us-west1",
      "gke_octogee_us-west1_octogee-gateway",
      "us-west1-docker.pkg.dev/octogee/octogee",
      "octogee:us-west1:octogee-pg-west",
      "true",
      "projects/octogee-data-prod/locations/us-west1/keyRings/octogee-creds/cryptoKeys/integrations-at-rest",
    ]);
  });

  it("propagates resolver failures", () => {
    const result = bash(`
      source "${helper}"
      octogee_load_deployment_target --environment=dev
    `);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Unknown deployment environment: dev");
  });

  it("fails immediately when the resolver exits successfully without output", () => {
    const result = bash(`
      node() { return 0; }
      source "${helper}"
      octogee_load_deployment_target --target=prod-west
    `);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("deployment target resolver returned empty output");
  });
});
