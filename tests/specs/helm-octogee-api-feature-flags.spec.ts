import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { findDoc, useUmbrellaChart } from "./helpers/umbrella-chart";

const chart = useUmbrellaChart("octogee-api-feature-flags-");

interface EnvVar {
  name: string;
  value?: string;
}

function apiEnv(extraValues?: string): EnvVar[] {
  const deployment = findDoc(chart.helmTemplate({ extraValues }), "Deployment", "octogee-api");
  expect(deployment, "the kind values render the octogee-api Deployment").not.toBeNull();
  const parsed = parse(deployment!) as { spec: { template: { spec: { containers: { env: EnvVar[] }[] } } } };
  return parsed.spec.template.spec.containers[0].env;
}

describe("octogee-api feature flags", () => {
  it("sets no ENABLED_FEATURE_FLAGS when the values enable none", () => {
    expect(apiEnv().find((entry) => entry.name === "ENABLED_FEATURE_FLAGS")).toBeUndefined();
  });

  it("passes the enabled flags to octogee-api as one comma-separated list", () => {
    const env = apiEnv([
      "octogee-api:",
      "  featureFlags:",
      "    enabled:",
      "      - release-agent-import",
      "      - release-voice-talk",
    ].join("\n"));

    expect(env.filter((entry) => entry.name === "ENABLED_FEATURE_FLAGS"))
      .toEqual([{ name: "ENABLED_FEATURE_FLAGS", value: "release-agent-import,release-voice-talk" }]);
  });
});
