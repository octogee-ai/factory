import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(__dirname, "../..");
const script = path.join(repoRoot, "infra/gateway/apply-gateway-class-policy.mjs");
const workflowTools = [
  "preview_start",
  "preview_stop",
  "preview_list",
  "octogee_publish",
  "octogee_project_create",
  "octogee_project_commit",
  "octogee_project_list",
  "workspace_commit",
  "octogee_chat_search",
  "octogee_chat_history",
  "octogee_chat_set_identity",
];

function runPolicy(gatewayClass: string, config: Record<string, unknown>) {
  const dir = mkdtempSync(path.join(tmpdir(), "octogee-gateway-class-"));
  const file = path.join(dir, "openclaw.json");
  writeFileSync(file, JSON.stringify(config, null, 2));
  const result = spawnSync("node", [script], {
    encoding: "utf8",
    env: {
      ...process.env,
      OPENCLAW_DIR: dir,
      GATEWAY_CLASS: gatewayClass,
      GATEWAY_PROFILE: "",
    },
  });
  if (result.status !== 0) {
    throw new Error(
      `class policy failed (${result.status})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return JSON.parse(readFileSync(file, "utf8")) as any;
}

describe("infra/gateway/apply-gateway-class-policy.mjs", () => {
  it("shared class denies exec/process/subagents and keeps Octogee workflow tools model-visible", () => {
    const out = runPolicy("shared", {
      agents: {
        defaults: {
          subagents: { maxConcurrent: 8, model: "anthropic/claude-sonnet-4-6" },
        },
      },
      tools: {
        deny: ["read"],
        subagents: { tools: { deny: ["write"] } },
      },
      plugins: {
        allow: ["codex", "octogee-connector-tools"],
        entries: {
          codex: { enabled: true, config: { appServer: { sandbox: "danger-full-access" } } },
          "octogee-connector-tools": { enabled: true },
        },
      },
    });

    expect(out.tools.deny).toEqual(["read", "exec", "process", "subagents", "sessions_spawn"]);
    expect(out.tools.alsoAllow).toEqual(workflowTools);
    expect(out.tools.exec).toEqual({ mode: "deny" });
    expect(out.tools.subagents.tools.deny).toEqual(["write", "exec", "process"]);
    expect(out.agents.defaults.subagents).toBeUndefined();
    expect(out.plugins.allow).toEqual(["codex", "octogee-project-tools"]);
    expect(out.plugins.entries.codex.config.appServer.sandbox).toBe("workspace-write");
    expect(out.plugins.entries.codex.config.appServer.approvalPolicy).toBe("never");
    expect(out.plugins.entries["octogee-connector-tools"].enabled).toBe(false);
    expect(out.plugins.entries["octogee-project-tools"].enabled).toBe(true);
  });

  it("builder class enables OpenClaw exec/process/subagents plus runtime plugins", () => {
    const out = runPolicy("builder", {
      auth: { profiles: {} },
      agents: {
        defaults: {
          models: {},
          subagents: { maxConcurrent: 8, model: "anthropic/claude-sonnet-4-6" },
        },
      },
      tools: {
        deny: ["exec", "process", "subagents", "sessions_spawn", "read"],
        exec: { mode: "deny" },
        subagents: { tools: { deny: ["exec", "process", "write"] } },
      },
      plugins: {
        allow: ["codex", "octogee-connector-tools"],
        entries: {
          codex: { enabled: true },
          "octogee-connector-tools": {
            enabled: false,
            config: { timeoutMs: 1500, baseUrl: "http://connector-tools" },
          },
        },
      },
    });

    expect(out.tools.deny).toEqual(["read"]);
    expect(out.tools.alsoAllow).toEqual(workflowTools);
    expect(out.tools.exec).toBeUndefined();
    expect(out.tools.subagents.tools.deny).toEqual(["write"]);
    expect(out.agents.defaults.subagents).toEqual({
      maxConcurrent: 8,
      model: "anthropic/claude-sonnet-4-6",
    });
    expect(out.plugins.allow).toEqual(["codex", "octogee-connector-tools", "octogee-project-tools"]);
    expect(out.plugins.entries.codex.enabled).toBe(true);
    expect(out.plugins.entries.codex.config.appServer).toEqual({
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    });
    expect(out.plugins.entries["octogee-connector-tools"]).toEqual({
      enabled: true,
      config: { timeoutMs: 1500, baseUrl: "http://connector-tools" },
    });
    expect(out.plugins.entries["octogee-project-tools"]).toEqual({
      enabled: true,
      config: {},
    });
    expect(out.auth.profiles["openai-codex:default"]).toEqual({
      provider: "openai-codex",
      mode: "oauth",
    });
    expect(out.agents.defaults.models["openai/gpt-5.5"]).toEqual({
      agentRuntime: { id: "codex" },
    });
  });

  it("operator class leaves the config untouched for the operator-image patcher", () => {
    const config = {
      tools: { deny: ["exec"], exec: { mode: "deny" } },
      plugins: { allow: ["codex"], entries: { codex: { enabled: true } } },
    };
    const out = runPolicy("operator", config);
    expect(out).toEqual(config);
  });
});
