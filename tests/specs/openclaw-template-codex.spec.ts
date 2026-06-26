import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "../..");

function readTemplate() {
  return JSON.parse(
    readFileSync(path.join(repoRoot, "infra/gateway/openclaw.template.json"), "utf8"),
  );
}

describe("infra/gateway/openclaw.template.json — standard gateway exec-off posture", () => {
  it("denies exec for standard agents and subagents", () => {
    const template = readTemplate();

    expect(template.tools.deny).toEqual(["exec", "process"]);
    expect(template.tools.exec).toEqual({ mode: "deny" });
    expect(template.tools.subagents.tools.deny).toEqual(["exec", "process"]);
  });

  it("scopes session tools to the owning agent (visibility=agent) so a coach reaches all its own channels but no other tenant's sessions", () => {
    const template = readTemplate();

    expect(template.tools.sessions).toEqual({ visibility: "agent" });
  });

  it("disables the Codex plugin and removes the gpt-5.5 Codex runtime route", () => {
    const template = readTemplate();

    expect(template.plugins.allow).not.toContain("codex");
    expect(template.plugins.entries.codex).toEqual({ enabled: false });
    expect(template.agents.defaults.models["openai/gpt-5.5"]).toBeUndefined();
    expect(template.auth.profiles["openai-codex:default"]).toBeUndefined();
  });
});
