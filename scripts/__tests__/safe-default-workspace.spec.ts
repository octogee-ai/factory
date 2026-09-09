import { afterEach, expect, it, vi } from "vitest";
import { configuredBuilderPortableStatePlanFromConfig } from "@octogee/core/local-coach-wired";
import { buildSafeDefaultAgent, SAFE_DEFAULT_AGENT_ID } from "../lib/openclaw-config-builders.js";

afterEach(() => vi.unstubAllEnvs());

it.each(["/home/node/.openclaw", "/tmp/builder-state"])(
  "keeps the generated safe agent portable in a native roster rooted at %s without legacy default flags",
  (stateDir) => {
    vi.stubEnv("OPENCLAW_DIR", stateDir);
    const agent = buildSafeDefaultAgent();
    const plan = configuredBuilderPortableStatePlanFromConfig({
      agents: {
        defaults: { workspace: `${stateDir}/workspace` },
        entries: {
          main: { workspace: `${stateDir}/workspace` },
          [SAFE_DEFAULT_AGENT_ID]: agent,
        },
      },
    }, stateDir);
    expect(plan.paths).toContainEqual({
      relativePath: `workspace-${SAFE_DEFAULT_AGENT_ID}`,
      kind: "directory",
    });
  },
);
