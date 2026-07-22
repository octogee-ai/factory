import { describe, expect, it } from "vitest";

import {
  formatDeploymentTargetOutput,
  resolveDeploymentTargetArguments,
  runDeploymentTargetResolver,
} from "./resolve-deployment-target.js";

describe("deployment target resolver", () => {
  it("resolves a logical environment to its active central target", () => {
    expect(resolveDeploymentTargetArguments(["--environment=test"])).toMatchObject({
      name: "test",
      targetId: "test-central",
      lifecycle: "active",
      region: "us-central1",
    });
  });

  it("allows an explicit west candidate without changing the active target", () => {
    expect(resolveDeploymentTargetArguments(["--target=test-west"])).toMatchObject({
      name: "test",
      targetId: "test-west",
      lifecycle: "candidate",
      firebaseProjectId: "octogee-data-test",
      region: "us-west1",
    });
  });

  it("requires exactly one target selector", () => {
    expect(() => resolveDeploymentTargetArguments([])).toThrow(
      "Exactly one of --environment or --target is required",
    );
    expect(() => resolveDeploymentTargetArguments([
      "--environment=prod",
      "--target=prod-west",
    ])).toThrow("Exactly one of --environment or --target is required");
  });

  it("rejects unknown arguments and environments", () => {
    expect(() => resolveDeploymentTargetArguments(["--environment=dev"])).toThrow(
      "Unknown deployment environment: dev",
    );
    expect(() => resolveDeploymentTargetArguments(["--environment=prod", "--west"])).toThrow(
      "Unknown argument: --west",
    );
  });

  it("emits every regional value needed by workflows and shell tooling", () => {
    const output = formatDeploymentTargetOutput(
      resolveDeploymentTargetArguments(["--target=prod-west"]),
      "github",
    );

    expect(output).toContain("target_id=prod-west\n");
    expect(output).toContain("region=us-west1\n");
    expect(output).toContain("kube_context=gke_octogee_us-west1_octogee-gateway\n");
    expect(output).toContain(
      "artifact_registry_repository=us-west1-docker.pkg.dev/octogee/octogee\n",
    );
    expect(output).toContain("cloud_sql_connection_name=octogee:us-west1:octogee-pg-west\n");
    expect(output).toContain("cloud_sql_point_in_time_recovery_enabled=true\n");
    expect(output).toContain(
      "kms_key_name=projects/octogee-data-prod/locations/us-west1/keyRings/octogee-creds/cryptoKeys/integrations-at-rest\n",
    );
  });

  it("supports JSON output for operator scripts", () => {
    const output = formatDeploymentTargetOutput(
      resolveDeploymentTargetArguments(["--environment=build-week"]),
      "json",
    );

    expect(JSON.parse(output)).toMatchObject({
      target_id: "build-week-central",
      lifecycle: "frozen",
      region: "us-central1",
    });
  });

  it("parses CLI output format without weakening selector validation", () => {
    expect(JSON.parse(runDeploymentTargetResolver([
      "--target=test-west",
      "--format=json",
    ]))).toMatchObject({ target_id: "test-west", region: "us-west1" });
    expect(() => runDeploymentTargetResolver([
      "--environment=test",
      "--format=dotenv",
    ])).toThrow("Unknown output format: dotenv");
  });
});
