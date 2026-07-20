import { describe, expect, it } from "vitest";

import {
  AgentImportConfigError,
  buildAgentImportApprovalInput,
  buildAgentImportConfigArtifacts,
  classifyAgentImportArchivePath,
  planAgentImportConfig,
  validateAgentImportConfigArtifacts,
} from "./agent-import.js";

const SECRET = "sk-ant-definitely-not-for-octogee";

function sourceConfig(): Record<string, unknown> {
  return {
    meta: { lastTouchedVersion: "2025.4.3", lastTouchedAt: "2025-04-03T00:00:00Z" },
    env: { ANTHROPIC_API_KEY: SECRET },
    agents: {
      defaults: {
        heartbeat: { every: "2h", lightContext: true },
        timeoutSeconds: 120,
      },
      list: [
        { id: "other", name: "Other" },
        {
          id: "moof",
          name: "Moof",
          persona: "Helpful, curious, and a little strange.",
          workspace: "C:\\Users\\jack\\.openclaw\\workspace",
          agentDir: "C:\\Users\\jack\\.openclaw\\agents\\moof",
          identity: { name: "Moof", emoji: "🐮" },
          heartbeat: {
            every: "30m",
            activeHours: { start: "08:00", end: "22:00", timezone: "America/Chicago" },
            lightContext: false,
          },
          bootstrapMaxChars: 24_000,
          bootstrapTotalMaxChars: 80_000,
          thinkingDefault: "high",
          verboseDefault: "on",
          timeoutSeconds: 300,
          model: { primary: "anthropic/claude-sonnet", fallbacks: ["openai/gpt-5"] },
          tools: { exec: { host: "gateway" }, elevated: { enabled: true } },
          futureSetting: { enabled: true },
        },
      ],
    },
    channels: { discord: { token: SECRET, accountId: "jack" } },
    gateway: { auth: { token: SECRET }, port: 18789 },
  };
}

describe("agent import config artifacts", () => {
  it("selects one agent, emits only portable values, and inventories unsafe paths without values", () => {
    const artifacts = buildAgentImportConfigArtifacts(sourceConfig(), "moof");

    expect(artifacts.portableAgent).toEqual({
      sourceAgentId: "moof",
      sourceOpenClawVersion: "2025.4.3",
      name: "Moof",
      persona: "Helpful, curious, and a little strange.",
      identity: { name: "Moof", emoji: "🐮" },
      heartbeat: {
        every: "30m",
        activeHours: { start: "08:00", end: "22:00", timezone: "America/Chicago" },
        lightContext: false,
      },
      bootstrapMaxChars: 24_000,
      bootstrapTotalMaxChars: 80_000,
      thinkingDefault: "high",
      verboseDefault: "on",
      timeoutSeconds: 300,
      requestedModel: {
        primary: "anthropic/claude-sonnet",
        fallbacks: ["openai/gpt-5"],
      },
    });
    expect(artifacts.doctorCandidate).toEqual({
      meta: { lastTouchedVersion: "2025.4.3" },
      agents: { list: [expect.objectContaining({ id: "moof", name: "Moof" })] },
    });
    expect(artifacts.configInventory).toContainEqual({
      path: "channels.discord.token",
      valueType: "string",
      classification: "credential",
      sourceAgent: false,
    });
    expect(artifacts.configInventory).toContainEqual({
      path: "agents.list[1].futureSetting.enabled",
      valueType: "boolean",
      classification: "unknown",
      sourceAgent: true,
    });
    expect(JSON.stringify(artifacts)).not.toContain(SECRET);
    expect(JSON.stringify(artifacts)).not.toContain("C:\\Users\\jack");
  });

  it("rejects a missing or duplicate selected agent id", () => {
    expect(() => buildAgentImportConfigArtifacts(sourceConfig(), "missing")).toThrowError(
      expect.objectContaining({ code: "source_agent_not_found" }),
    );
    const source = sourceConfig();
    (source.agents as { list: unknown[] }).list.push({ id: "moof" });
    expect(() => buildAgentImportConfigArtifacts(source, "moof")).toThrowError(
      expect.objectContaining({ code: "source_agent_ambiguous" }),
    );
  });

  it("server-validates the exact artifact shape and rejects credential-shaped injections", () => {
    const artifacts = buildAgentImportConfigArtifacts(sourceConfig(), "moof");
    expect(validateAgentImportConfigArtifacts(artifacts)).toEqual(artifacts);

    expect(() => validateAgentImportConfigArtifacts({
      ...artifacts,
      doctorCandidate: { ...artifacts.doctorCandidate, apiKey: SECRET },
    })).toThrowError(expect.objectContaining({ code: "unsafe_config_artifact" }));
    expect(() => validateAgentImportConfigArtifacts({ ...artifacts, extra: true }))
      .toThrowError(AgentImportConfigError);
  });
});

describe("agent import config plan", () => {
  it("applies doctor-validated customer fields, routes models to reauth, and drops unsafe inventory", () => {
    const artifacts = buildAgentImportConfigArtifacts(sourceConfig(), "moof");
    const plan = planAgentImportConfig(artifacts, { doctorOutcome: "migrated" });

    expect(plan.identity).toEqual({
      name: "Moof",
      persona: "Helpful, curious, and a little strange.",
      emoji: "🐮",
    });
    expect(plan.runtimePatch).toMatchObject({
      heartbeat: { every: "30m", lightContext: false },
      timeoutSeconds: 300,
    });
    expect(plan.decisions).toContainEqual(expect.objectContaining({
      path: "model.primary",
      disposition: "reauth_then_apply",
    }));
    expect(plan.decisions).toContainEqual(expect.objectContaining({
      path: "channels.discord.token",
      disposition: "drop_platform",
    }));
    expect(plan.decisions).toContainEqual(expect.objectContaining({
      path: "agents.list[1].futureSetting.enabled",
      disposition: "drop_unsupported",
    }));
  });

  it("keeps runtime config on the safe baseline when doctor cannot validate the source", () => {
    const artifacts = buildAgentImportConfigArtifacts(sourceConfig(), "moof");
    const plan = planAgentImportConfig(artifacts, { doctorOutcome: "unsupported" });

    expect(plan.runtimePatch).toEqual({});
    expect(plan.effectiveOutcome).toBe("safe_baseline");
    expect(plan.decisions).toContainEqual(expect.objectContaining({
      path: "heartbeat.every",
      disposition: "manual_review",
    }));
  });
});

describe("agent import transport contracts", () => {
  it("allows only normalized workspace and safe git database entries", () => {
    expect(classifyAgentImportArchivePath("workspace/MEMORY.md")).toBe("workspace");
    expect(classifyAgentImportArchivePath("git/objects/aa/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")).toBe("git");
    expect(classifyAgentImportArchivePath("git/refs/heads/main")).toBe("git");
    expect(classifyAgentImportArchivePath("git/shallow")).toBeNull();
    expect(classifyAgentImportArchivePath("git/config")).toBeNull();
    expect(classifyAgentImportArchivePath("workspace/.env")).toBeNull();
    expect(classifyAgentImportArchivePath("workspace/credentials/provider.json")).toBeNull();
    expect(classifyAgentImportArchivePath("workspace/credentials.json")).toBeNull();
    expect(classifyAgentImportArchivePath("workspace/.npmrc")).toBeNull();
    expect(classifyAgentImportArchivePath("workspace/../openclaw.json")).toBeNull();
    expect(classifyAgentImportArchivePath("workspace/MEMORY\nsecret.md")).toBeNull();
  });

  it("canonicalizes the approval-bound preview inputs independent of object insertion order", () => {
    const left = buildAgentImportApprovalInput({
      source: { kind: "github", owner: "jack", repo: "moof", head: "a".repeat(40) },
      destinationHead: "b".repeat(40),
      workspaceDigest: `sha256:${"c".repeat(64)}`,
      configDigest: `sha256:${"d".repeat(64)}`,
      resolutions: { "SOUL.md": "source", "README.md": "destination" },
    });
    const right = buildAgentImportApprovalInput({
      resolutions: { "README.md": "destination", "SOUL.md": "source" },
      configDigest: `sha256:${"d".repeat(64)}`,
      workspaceDigest: `sha256:${"c".repeat(64)}`,
      destinationHead: "b".repeat(40),
      source: { head: "a".repeat(40), repo: "moof", owner: "jack", kind: "github" },
    });
    expect(left).toBe(right);
  });
});
