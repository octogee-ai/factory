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
      agents: {
        defaults: expect.objectContaining({ timeoutSeconds: 120 }),
        list: [expect.objectContaining({
          id: "moof",
          name: "Moof",
          futureSetting: { enabled: true },
        })],
      },
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
    expect(JSON.stringify(artifacts.doctorCandidate)).not.toContain('"tools"');
  });

  it("preserves value-bearing legacy agent fields for current Doctor migration", () => {
    const artifacts = buildAgentImportConfigArtifacts({
      meta: { lastTouchedVersion: "2026.5.5" },
      agents: {
        defaults: { llm: "openai-codex/gpt-5.5" },
        list: [{ id: "moof", legacyRuntimeSetting: { enabled: true } }],
      },
    }, "moof");

    expect(artifacts.doctorCandidate).toEqual({
      meta: { lastTouchedVersion: "2026.5.5" },
      agents: {
        defaults: { llm: "openai-codex/gpt-5.5" },
        list: [{ id: "moof", legacyRuntimeSetting: { enabled: true } }],
      },
    });
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

  it.each(["key", "authKey", "sharedKey", "passphrase"])(
    "rejects the common credential field %s before it enters an import artifact",
    (field) => {
      const source = sourceConfig();
      const selected = (source.agents as { list: Array<Record<string, unknown>> }).list[1];
      selected[field] = "short-but-still-a-secret";

      const artifacts = buildAgentImportConfigArtifacts(source, "moof");

      expect(JSON.stringify(artifacts.doctorCandidate)).not.toContain(field);
      expect(artifacts.configInventory).toContainEqual(expect.objectContaining({
        path: `agents.list[1].${field}`,
        classification: "credential",
      }));
    },
  );

  it("rejects credential values hidden inside portable free-form fields", () => {
    const artifacts = buildAgentImportConfigArtifacts({
      agents: {
        list: [{
          id: "moof",
          name: "Moof",
          persona: "Use sk-ant-api03-0123456789abcdefghijklmnop for emergencies",
        }],
      },
    }, "moof");

    expect(() => validateAgentImportConfigArtifacts(artifacts))
      .toThrowError(expect.objectContaining({ code: "unsafe_config_artifact" }));
  });

  it("never transports credentials or email addresses used as config map keys", () => {
    const dynamicMapKey = "sk-project-AbCdEfGhIjKlMnOpQrStUvWxYz012345";
    const artifacts = buildAgentImportConfigArtifacts({
      agents: { list: [{ id: "moof" }] },
      providers: { accounts: {
        [dynamicMapKey]: { enabled: true },
        "jack@example.com": { enabled: true },
      } },
    }, "moof");

    expect(JSON.stringify(artifacts)).not.toContain(dynamicMapKey);
    expect(JSON.stringify(artifacts)).not.toContain("jack@example.com");
    expect(artifacts.configInventory).toContainEqual(expect.objectContaining({
      path: "providers.accounts.$key.enabled",
      classification: "credential",
    }));

    const injected = structuredClone(artifacts);
    injected.configInventory[0] = { ...injected.configInventory[0], path: `providers.accounts.${dynamicMapKey}` };
    expect(() => validateAgentImportConfigArtifacts(injected))
      .toThrowError(expect.objectContaining({ code: "unsafe_config_artifact" }));
    injected.configInventory[0] = { ...injected.configInventory[0], path: "providers.accounts.jack@example.com.enabled" };
    expect(() => validateAgentImportConfigArtifacts(injected))
      .toThrowError(expect.objectContaining({ code: "unsafe_config_artifact" }));
  });

  it("calls out unsupported leaves nested under otherwise portable sections", () => {
    const artifacts = buildAgentImportConfigArtifacts({
      agents: {
        list: [{
          id: "moof",
          identity: { name: "Moof", avatarUrl: "https://example.test/moof.png" },
          heartbeat: { every: "30m", legacyMode: true },
        }],
      },
    }, "moof");

    const plan = planAgentImportConfig(artifacts, {
      doctorOutcome: "unchanged",
      workspacePolicy: { preserveConvergedContextFiles: false },
    });

    expect(plan.decisions).toContainEqual({
      path: "agents.list[0].identity.avatarUrl",
      disposition: "drop_unsupported",
      reason: "field is not in the portable allowlist",
    });
    expect(plan.decisions).toContainEqual({
      path: "agents.list[0].heartbeat.legacyMode",
      disposition: "drop_unsupported",
      reason: "field is not in the portable allowlist",
    });
    expect(plan.decisions).toContainEqual(expect.objectContaining({ path: "identity.name", disposition: "apply" }));
    expect(plan.decisions).toContainEqual(expect.objectContaining({ path: "heartbeat.every", disposition: "apply" }));
  });

  it("strips common camelCase credential fields from Doctor input", () => {
    const artifacts = buildAgentImportConfigArtifacts({
      agents: { list: [{
        id: "moof",
        legacyProvider: {
          clientSecret: "short-client-secret",
          accessToken: "short-access-token",
          refreshToken: "short-refresh-token",
          webhookSecret: "short-webhook-secret",
          label: "Jack's provider",
        },
      }] },
    }, "moof");

    expect(JSON.stringify(artifacts.doctorCandidate)).not.toContain("short-");
    expect(artifacts.doctorCandidate).toMatchObject({
      agents: { list: [{ id: "moof", legacyProvider: { label: "Jack's provider" } }] },
    });
    expect(artifacts.configInventory).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "agents.list[0].legacyProvider.clientSecret", classification: "credential" }),
      expect.objectContaining({ path: "agents.list[0].legacyProvider.accessToken", classification: "credential" }),
      expect.objectContaining({ path: "agents.list[0].legacyProvider.refreshToken", classification: "credential" }),
      expect.objectContaining({ path: "agents.list[0].legacyProvider.webhookSecret", classification: "credential" }),
    ]));
  });
});

describe("agent import config plan", () => {
  it("applies doctor-validated customer fields, routes models to reauth, and drops unsafe inventory", () => {
    const artifacts = buildAgentImportConfigArtifacts(sourceConfig(), "moof");
    const plan = planAgentImportConfig(artifacts, {
      doctorOutcome: "migrated",
      workspacePolicy: { preserveConvergedContextFiles: false },
    });

    expect(plan.identity).toEqual({
      name: "Moof",
      persona: "Helpful, curious, and a little strange.",
      emoji: "🐮",
    });
    expect(plan.runtimePatch).toMatchObject({
      heartbeat: { every: "30m", lightContext: false },
      timeoutSeconds: 300,
    });
    expect(plan.workspaceRuntimePatch).toEqual({ skipBootstrap: true });
    expect(plan.decisions).toContainEqual({
      path: "skipBootstrap",
      disposition: "apply",
      reason: "Builder-owned context files must not be recreated after import",
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
    const plan = planAgentImportConfig(artifacts, {
      doctorOutcome: "unsupported",
      workspacePolicy: { preserveConvergedContextFiles: false },
    });

    expect(plan.workspaceRuntimePatch).toEqual({ skipBootstrap: true });
    expect(plan.runtimePatch).toEqual({});
    expect(plan.effectiveOutcome).toBe("safe_baseline");
    expect(plan.decisions).toContainEqual(expect.objectContaining({
      path: "heartbeat.every",
      disposition: "manual_review",
    }));
  });

  it("reports an unchanged config when there is no portable runtime delta", () => {
    const artifacts = buildAgentImportConfigArtifacts({
      agents: { list: [{ id: "moof", name: "Moof" }] },
    }, "moof");

    const plan = planAgentImportConfig(artifacts, {
      doctorOutcome: "unchanged",
      workspacePolicy: { preserveConvergedContextFiles: false },
    });

    expect(plan.workspaceRuntimePatch).toEqual({ skipBootstrap: true });
    expect(plan.runtimePatch).toEqual({});
    expect(plan.effectiveOutcome).toBe("unchanged");
  });

  it("keeps OpenClaw bootstrap convergence enabled for house-only workspaces", () => {
    const artifacts = buildAgentImportConfigArtifacts({
      agents: { list: [{ id: "moof", name: "Moof" }] },
    }, "moof");

    const plan = planAgentImportConfig(artifacts, {
      doctorOutcome: "unchanged",
      workspacePolicy: { preserveConvergedContextFiles: true },
    });

    expect(plan.workspaceRuntimePatch).toEqual({ skipBootstrap: false });
    expect(plan.decisions).toContainEqual({
      path: "skipBootstrap",
      disposition: "apply",
      reason: "OpenClaw converges house-only context files",
    });
  });
});

describe("agent import transport contracts", () => {
  it("caps configuration inventory below the Firestore record and UI rendering limit", () => {
    const base = buildAgentImportConfigArtifacts({ agents: { list: [{ id: "moof" }] } }, "moof");
    expect(() => validateAgentImportConfigArtifacts({
      ...base,
      configInventory: Array.from({ length: 501 }, (_, index) => ({
        path: `plugins.item${index}`,
        valueType: "string",
        classification: "unknown",
        sourceAgent: false,
      })),
    })).toThrow(/bounded array/);
  });

  it("summarizes oversized source config instead of blocking safe workspace import", () => {
    const artifacts = buildAgentImportConfigArtifacts({
      agents: { list: [{ id: "moof" }] },
      plugins: Object.fromEntries(Array.from({ length: 600 }, (_, index) => [`plugin${index}`, { enabled: true }])),
    }, "moof");

    expect(artifacts.configInventory).toHaveLength(500);
    expect(artifacts.configInventory.at(-1)?.path).toMatch(/^\$inventory\.truncated\[/);
    expect(() => validateAgentImportConfigArtifacts(artifacts)).not.toThrow();
  });

  it("allows only normalized workspace and safe git database entries", () => {
    expect(classifyAgentImportArchivePath("workspace/MEMORY.md")).toBe("workspace");
    expect(classifyAgentImportArchivePath("git/objects/aa/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")).toBe("git");
    expect(classifyAgentImportArchivePath("git/refs/heads/main")).toBe("git");
    expect(classifyAgentImportArchivePath("git/shallow")).toBeNull();
    expect(classifyAgentImportArchivePath("git/config")).toBeNull();
    expect(classifyAgentImportArchivePath("workspace/.env")).toBeNull();
    expect(classifyAgentImportArchivePath("workspace/openclaw-workspace-state.json")).toBeNull();
    expect(classifyAgentImportArchivePath("workspace/.openclaw/workspace-state.json")).toBeNull();
    expect(classifyAgentImportArchivePath("workspace/credentials/provider.json")).toBeNull();
    expect(classifyAgentImportArchivePath("workspace/credentials.json")).toBeNull();
    expect(classifyAgentImportArchivePath("workspace/.npmrc")).toBeNull();
    expect(classifyAgentImportArchivePath("workspace/backup/credentials/custom.key")).toBeNull();
    expect(classifyAgentImportArchivePath("workspace/foo/sessions/session.json")).toBeNull();
    expect(classifyAgentImportArchivePath("workspace/archive/openclaw.json.bak")).toBeNull();
    expect(classifyAgentImportArchivePath("workspace/nested/.KUBE/config")).toBeNull();
    expect(classifyAgentImportArchivePath("workspace/.docker/config.json")).toBeNull();
    expect(classifyAgentImportArchivePath("workspace/.config/gcloud/application_default_credentials.json")).toBeNull();
    expect(classifyAgentImportArchivePath("workspace/nested/.GIT-CREDENTIALS")).toBeNull();
    expect(classifyAgentImportArchivePath("workspace/../openclaw.json")).toBeNull();
    expect(classifyAgentImportArchivePath("workspace/MEMORY\nsecret.md")).toBeNull();
  });

  it("does not reject ordinary source paths merely named auth, token, or state", () => {
    expect(classifyAgentImportArchivePath("workspace/src/auth.ts")).toBe("workspace");
    expect(classifyAgentImportArchivePath("workspace/src/token-counter.ts")).toBe("workspace");
    expect(classifyAgentImportArchivePath("workspace/src/state.ts")).toBe("workspace");
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
