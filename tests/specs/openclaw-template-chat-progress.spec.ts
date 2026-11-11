import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "../..");

type Template = {
  agents: { defaults: { verboseDefault?: string } };
  channels?: { mattermost?: { streaming?: unknown } };
};

function read(name: string): Template {
  return JSON.parse(readFileSync(path.join(repoRoot, "infra/gateway", name), "utf8")) as Template;
}

describe("gateway templates — chat progress surface", () => {
  it.each(["openclaw.template.json", "openclaw.isolated.template.json"])(
    "%s keeps native verbose tool summaries out of chat",
    (name) => {
      expect(read(name).agents.defaults.verboseDefault).toBe("off");
    },
  );

  it("keeps the Mattermost draft preview carrying tool progress during a run", () => {
    expect(read("openclaw.template.json").channels?.mattermost?.streaming).toEqual({
      mode: "progress",
      preview: { toolProgress: true },
      progress: { toolProgress: true },
    });
  });
});
