import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import { CUSTOMER_CODE_DENIED_TOOLS } from "../../core/src/system-config-invariants";

const repoRoot = path.resolve(__dirname, "../..");

type Template = {
  gateway: { terminal?: { enabled?: boolean } } & Record<string, unknown>;
  tools: Record<string, unknown>;
  plugins: { allow: string[]; entries: Record<string, Record<string, unknown>> };
  commands: Record<string, unknown>;
  cron?: unknown;
  skills?: unknown;
} & Record<string, unknown>;

function read(name: string): Template {
  return JSON.parse(readFileSync(path.join(repoRoot, "infra/gateway", name), "utf8")) as Template;
}

const BUILDER_OWNED_TOP_LEVEL = new Set([
  "browser",
  "tools",
  "plugins",
  "commands",
  "cron",
  "skills",
  "gateway",
]);

describe("infra/gateway/openclaw.builder.template.json — the Builder seed boots on the slim runtime", () => {
  const shared = read("openclaw.template.json");
  const builder = read("openclaw.builder.template.json");

  it("shares every platform wiring section byte-for-byte with the shared template", () => {
    for (const key of Object.keys(shared)) {
      if (BUILDER_OWNED_TOP_LEVEL.has(key)) continue;
      expect(builder[key], key).toEqual(shared[key]);
    }
    const { terminal: _sharedTerminal, ...sharedGateway } = shared.gateway;
    const { terminal: _builderTerminal, ...builderGateway } = builder.gateway;
    expect(builderGateway).toEqual(sharedGateway);
    expect(Object.keys(builder).sort()).toEqual(
      [...Object.keys(shared).filter((key) => key !== "cron" && key !== "skills"), "browser"].sort(),
    );
  });

  it("drops host-code fences while keeping the unavailable managed browser disabled", () => {
    expect(builder.tools).toEqual({
      profile: shared.tools.profile,
      alsoAllow: [...shared.tools.alsoAllow as string[], "browser"],
      web: shared.tools.web,
    });
    for (const tool of CUSTOMER_CODE_DENIED_TOOLS.filter((tool) => tool !== "browser")) {
      expect(JSON.stringify(builder.tools)).not.toContain(`"${tool}"`);
    }
    expect(builder.browser).toEqual({
      enabled: false,
      defaultProfile: "openclaw",
      headless: true,
      noSandbox: true,
      evaluateEnabled: true,
      executablePath: "/usr/bin/chromium",
    });
    expect(builder.gateway.terminal).toEqual({ enabled: true });
    for (const command of ["bash", "config", "mcp", "plugins", "debug"]) {
      expect(builder.commands).not.toHaveProperty(command);
    }
    expect(builder).not.toHaveProperty("cron");
    expect(builder).not.toHaveProperty("skills");
  });

  it("keeps the core plugin surface while leaving browser and Codex payloads out of boot", () => {
    expect(builder.plugins.allow).toEqual([...shared.plugins.allow, "browser"]);
    expect(builder.plugins.entries.browser).toEqual({ enabled: false });
    expect(builder.plugins.entries).not.toHaveProperty("codex");
    const { codex: _sharedCodex, browser: _sharedBrowser, ...sharedEntries } = shared.plugins.entries;
    const { codex: _builderCodex, browser: _builderBrowser, ...builderEntries } = builder.plugins.entries;
    expect(builderEntries).toEqual(sharedEntries);
  });
});
