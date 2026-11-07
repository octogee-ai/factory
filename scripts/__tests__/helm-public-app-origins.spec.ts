import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  deploymentEnvironmentSettings,
  publicAppOriginsForTarget,
  type DeploymentEnvironment,
} from "@octogee/core/deployment-environment";

const repoRoot = resolve(import.meta.dirname, "../..");

function values(path: string): Record<string, unknown> {
  return parse(readFileSync(resolve(repoRoot, path), "utf8")) as Record<string, unknown>;
}

function platformOrigins(path: string): unknown {
  return (values(path).global as { publicAppOrigins?: unknown } | undefined)?.publicAppOrigins;
}

function gatewayOrigins(path: string): unknown {
  return (values(path).gatewayEdge as { publicAppOrigins?: unknown } | undefined)?.publicAppOrigins;
}

describe("browser origins reach runtime pods from the environment values", () => {
  it.each<DeploymentEnvironment>(["prod", "test"])(
    "%s values list exactly the active target's public app origins for the platform and gateway charts",
    (environment) => {
      const expected = publicAppOriginsForTarget(deploymentEnvironmentSettings(environment));
      expect(platformOrigins(`helm/octogee/values.${environment}.yaml`)).toEqual(expected);
      expect(gatewayOrigins(`helm/octogee-gateway/values.${environment}.yaml`)).toEqual(expected);
    },
  );

  it("custom namespaces reuse the TEST origins", () => {
    expect(platformOrigins("helm/octogee/values.custom.yaml.tpl"))
      .toEqual(publicAppOriginsForTarget(deploymentEnvironmentSettings("test")));
  });

  it("shared chart defaults carry no origins", () => {
    expect(platformOrigins("helm/octogee/values.yaml")).toBeUndefined();
    expect(gatewayOrigins("helm/octogee-gateway/values.yaml")).toBeUndefined();
  });
});
