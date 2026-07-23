import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import {
  formatDeploymentTargetOutput,
  isDeploymentTargetResolverEntrypoint,
  resolveDeploymentTargetArguments,
  runDeploymentTargetResolver,
} from "./resolve-deployment-target.js";

describe("deployment target resolver", () => {
  it("resolves a logical environment to its active west target", () => {
    expect(resolveDeploymentTargetArguments(["--environment=test"])).toMatchObject({
      name: "test",
      targetId: "test-west",
      lifecycle: "active",
      region: "us-west1",
    });
  });

  it("allows the explicit frozen central rollback target", () => {
    expect(resolveDeploymentTargetArguments(["--target=test-central"])).toMatchObject({
      name: "test",
      targetId: "test-central",
      lifecycle: "frozen",
      firebaseProjectId: "octogee-test",
      region: "us-central1",
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
    expect(output).toContain(
      "cloud_sql_mattermost_password_secret_name=MM_DB_PASSWORD-octogee-pg-west\n",
    );
    expect(output).toContain(
      "cloud_sql_gitea_password_secret_name=gitea-db-password-octogee-pg-west\n",
    );
    expect(output).toContain(
      "cloud_sql_connection_name_secret_name=cloud-sql-connection-name-octogee-pg-west\n",
    );
    expect(output).toContain("secret_name_suffix=prod-west\n");
    expect(output).toContain("cloud_sql_point_in_time_recovery_enabled=true\n");
    expect(output).toContain("platform_compute_class=octogee-platform-spot\n");
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

  it("recognizes a symlinked macOS-style entrypoint path by canonical real path", () => {
    const temp = mkdtempSync(path.join(tmpdir(), "octogee-resolver-entrypoint-"));
    const privateTemp = path.join(temp, "private", "tmp");
    const publicTemp = path.join(temp, "tmp");
    const resolver = path.join(privateTemp, "resolve-deployment-target.js");
    mkdirSync(privateTemp, { recursive: true });
    writeFileSync(resolver, "");
    symlinkSync(privateTemp, publicTemp);

    expect(realpathSync(path.join(publicTemp, "resolve-deployment-target.js")))
      .toBe(realpathSync(resolver));
    expect(isDeploymentTargetResolverEntrypoint(
      pathToFileURL(resolver).href,
      path.join(publicTemp, "resolve-deployment-target.js"),
    )).toBe(true);
  });

  it("does not throw when an entrypoint path no longer exists", () => {
    expect(isDeploymentTargetResolverEntrypoint(
      pathToFileURL("/private/tmp/missing-resolver.js").href,
      "/tmp/missing-resolver.js",
    )).toBe(false);
  });
});
