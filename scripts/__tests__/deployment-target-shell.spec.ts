import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { PROD_TARGET } from "./fixtures/deployment.js";

const repoRoot = resolve(import.meta.dirname, "../..");
const helper = resolve(repoRoot, "scripts/lib/deployment-target.sh");

function bash(command: string) {
  return spawnSync("bash", ["-c", command, "--", helper], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

describe("deployment target shell loader", () => {
  it("loads a Central target without reconstructing regional resource paths", () => {
    const result = bash(`
      source "$1"
      octogee_load_deployment_target --target=prod-central
      printf '%s\n' "$TARGET_ID" "$TARGET_REGION" "$TARGET_KUBE_CONTEXT" "$TARGET_AR_REPOSITORY" "$TARGET_CLOUD_SQL_CONNECTION" "$TARGET_CLOUD_SQL_PITR_ENABLED" "$TARGET_KMS_KEY_NAME"
    `);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "prod-central",
      "us-central1",
      PROD_TARGET.kubeContext,
      "us-central1-docker.pkg.dev/octogee/octogee",
      "octogee:us-central1:octogee-pg",
      "false",
      "projects/octogee/locations/us-central1/keyRings/octogee-creds/cryptoKeys/integrations-at-rest",
    ]);
  });

  it("propagates resolver failures", () => {
    const result = bash(`
      source "$1"
      octogee_load_deployment_target --environment=dev
    `);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Unknown deployment environment: dev");
  });

  it("fails immediately when the resolver exits successfully without output", () => {
    const result = bash(`
      node() { return 0; }
      source "$1"
      octogee_load_deployment_target --target=prod-central
    `);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("deployment target resolver returned empty output");
  });

  it("reads one field of another target without replacing the loaded target", () => {
    const result = bash(`
      source "$1"
      octogee_load_deployment_target --environment=test
      test_namespace="$TARGET_NAMESPACE"
      octogee_load_deployment_target --target=prod-central
      [[ "$(octogee_deployment_target_field --environment=test namespace)" == "$test_namespace" ]] && printf '%s\n' "$TARGET_ID"
    `);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("prod-central");
  });

  it("fails when the requested field is absent", () => {
    const result = bash(`
      source "$1"
      octogee_deployment_target_field --environment=test no_such_field
    `);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("deployment target has no no_such_field");
  });
});
