import { describe, it, expect, vi } from "vitest";
import {
  byotSnapshotProjectionFromSystemConfig,
  byotSystemConfigFromDoc,
  deriveSlug,
  mapUserDocToSnapshot,
  mapWorkspaceChannelDoc,
  mapProjectChannelDoc,
  mapProjectAgentState,
  collectProjectAgentStates,
} from "./customer-snapshot-mapping.js";

describe("deriveSlug", () => {
  it("prefers provisioning.openclaw.slug, falls back to username", () => {
    expect(deriveSlug("u", { provisioning: { openclaw: { slug: "fromOC" } }, username: "fromName" })).toBe("fromOC");
    expect(deriveSlug("u", { username: "fromName" })).toBe("fromName");
  });
  it("throws (identifiable message) when neither is set — orchestrator must not proceed", () => {
    expect(() => deriveSlug("u9", { tier: "pro" })).toThrow(
      /\[load:u9\] cannot derive slug/,
    );
  });
});

describe("mapUserDocToSnapshot — users/{uid} doc → UserSnapshot", () => {
  const ch: never[] = [];

  it("maps a fully-populated doc verbatim", () => {
    const snap = mapUserDocToSnapshot(
      "u1",
      {
        username: "acme",
        displayName: "Acme Inc",
        tier: "pro",
        mattermost: { userId: "mm-1" },
        provisioning: {
          openclaw: {
            slug: "acme",
            gatewayId: "gw-3",
            status: "complete",
            agentIds: ["octogee-acme-coach"],
          },
          git: { repoUrl: "git@x:acme.git" },
        },
      },
      ch,
    );
    expect(snap).toEqual({
      uid: "u1",
      slug: "acme",
      tier: "pro",
      gatewayId: "gw-3",
      status: "complete",
      agentIds: ["octogee-acme-coach"],
      repoUrl: "git@x:acme.git",
      mattermostUserId: "mm-1",
      channels: ch,
      ownerName: "Acme Inc",
      byotActive: false,
    });
  });

  it("byotActive mirrors Boolean(data.byotActive) — the mount re-assert reads it to avoid clobbering BYOT", () => {
    expect(mapUserDocToSnapshot("u", { username: "a", byotActive: true }, ch).byotActive).toBe(true);
    expect(mapUserDocToSnapshot("u", { username: "a", byotActive: false }, ch).byotActive).toBe(false);
    expect(mapUserDocToSnapshot("u", { username: "a" }, ch).byotActive).toBe(false);
  });

  it("tier fallback chain: tier → subscription.tier → 'trial'", () => {
    expect(mapUserDocToSnapshot("u", { username: "a", tier: "pro" }, ch).tier).toBe("pro");
    expect(mapUserDocToSnapshot("u", { username: "a", subscription: { tier: "team" } }, ch).tier).toBe("team");
    expect(mapUserDocToSnapshot("u", { username: "a" }, ch).tier).toBe("trial");
  });

  it("ownerName fallback: displayName → username → slug", () => {
    expect(mapUserDocToSnapshot("u", { username: "acme", displayName: "Acme" }, ch).ownerName).toBe("Acme");
    expect(mapUserDocToSnapshot("u", { username: "acme" }, ch).ownerName).toBe("acme");
    expect(mapUserDocToSnapshot("u", { provisioning: { openclaw: { slug: "sluggy" } } }, ch).ownerName).toBe("sluggy");
  });

  it("defaults: gatewayId '', status '', agentIds [], repoUrl '', mattermostUserId null", () => {
    const s = mapUserDocToSnapshot("u", { username: "a" }, ch);
    expect(s.gatewayId).toBe("");
    expect(s.status).toBe("");
    expect(s.agentIds).toEqual([]);
    expect(s.repoUrl).toBe("");
    expect(s.mattermostUserId).toBeNull();
  });


  it("passes channels through unchanged and throws on no-slug", () => {
    const channels = [{ scope: "workspace" as const, kind: "general", channelId: "C1" }];
    expect(mapUserDocToSnapshot("u", { username: "a" }, channels).channels).toBe(channels);
    expect(() => mapUserDocToSnapshot("u2", {}, ch)).toThrow(/cannot derive slug/);
  });

  it("carries every plan-resolution input, including the immutable trial grant", () => {
    const trialGrant = {
      schemaVersion: 3,
      offerId: "builder-signup",
      offerVersion: 1,
      personalTier: "personal",
      builderTier: "hobby",
      configHash: "config-a",
      claimedAt: "2026-07-08T00:00:00.000Z",
      endsAt: "2026-07-15T00:00:00.000Z",
    };
    const snap = mapUserDocToSnapshot(
      "u1",
      {
        username: "acme",
        tier: "personal_free",
        selectedTier: "personal_pro",
        subscription: { tier: "personal_pro", status: "active" },
        builderSubscription: { tier: "hobby", status: "active" },
        trialGrant,
      },
      ch,
    );
    expect(snap.selectedTier).toBe("personal_pro");
    expect(snap.subscription).toEqual({ tier: "personal_pro", status: "active" });
    expect(snap.builderSubscription).toEqual({ tier: "hobby", status: "active" });
    expect(snap.trialGrant).toBe(trialGrant);
  });

  it("keeps absent plan inputs absent (no undefined keys written into the snapshot)", () => {
    const snap = mapUserDocToSnapshot("u", { username: "a" }, ch);
    expect("selectedTier" in snap).toBe(false);
    expect("subscription" in snap).toBe(false);
    expect("builderSubscription" in snap).toBe(false);
    expect("trialGrant" in snap).toBe(false);
  });
});

describe("channel-doc shaping (workspaces/{slug} producer → UserSnapshot.channels consumer)", () => {
  it("workspace channel: requires mattermost.channelId; kind defaults to 'general'", () => {
    expect(mapWorkspaceChannelDoc({ kind: "files", mattermost: { channelId: "C1" } })).toEqual({
      scope: "workspace",
      kind: "files",
      channelId: "C1",
    });
    expect(mapWorkspaceChannelDoc({ mattermost: { channelId: "C2" } })).toEqual({
      scope: "workspace",
      kind: "general",
      channelId: "C2",
    });
    expect(mapWorkspaceChannelDoc({ kind: "files" })).toBeNull(); 
  });

  it("project channel: requires mattermost.channelId; carries projectId; kind defaults to 'default'", () => {
    expect(mapProjectChannelDoc("p1", { mattermost: { channelId: "C3" } })).toEqual({
      scope: "project",
      projectId: "p1",
      kind: "default",
      channelId: "C3",
    });
    expect(mapProjectChannelDoc("p1", { kind: "x" })).toBeNull();
  });
});

describe("byotSystemConfigFromDoc — users/{uid}/system/config → snapshot.systemConfig", () => {
  it("projects active modelCredential into the byot-shaped mount snapshot", () => {
    expect(
      byotSystemConfigFromDoc({
        modelCredential: {
          active: true,
          provider: "openai-codex",
          mode: "oauth",
          status: "active",
          reasonCode: "ok",
          secretName: "byosub-uid-openai",
          model: "openai/gpt-5.5",
        },
      }),
    ).toEqual({ byot: { provider: "openai-codex", model: "openai/gpt-5.5" } });
  });

  it("reports active from modelCredential so callers no longer need users/{uid}.byotActive", () => {
    expect(
      byotSnapshotProjectionFromSystemConfig({
        modelCredential: {
          active: true,
          provider: "anthropic",
          mode: "api_key",
          status: "active",
          reasonCode: "ok",
          secretName: "byok-acme-anthropic",
          fingerprint: "sk-ant...1234",
        },
      }),
    ).toEqual({
      byotActive: true,
      systemConfig: { byot: { provider: "anthropic" } },
    });
  });

  it("treats inactive modelCredential as authoritative over stale legacy byot", () => {
    expect(
      byotSnapshotProjectionFromSystemConfig({
        modelCredential: {
          active: false,
          provider: "openai",
          mode: "api_key",
          status: "missing",
          reasonCode: "missing_credential",
          secretName: "byok-acme-openai",
        },
        byot: { provider: "openai", model: "gpt-4o" },
      }),
    ).toEqual({ byotActive: false });
  });

  it("projects the byot provider/baseUrl/model the in-pod re-assert needs", () => {
    expect(
      byotSystemConfigFromDoc({ byot: { provider: "openai", baseUrl: "https://x", model: "gpt-4o" } }),
    ).toEqual({ byot: { provider: "openai", baseUrl: "https://x", model: "gpt-4o" } });
  });

  it("drops non-string fields and keeps only what is present", () => {
    expect(byotSystemConfigFromDoc({ byot: { provider: "anthropic", model: 123 } })).toEqual({
      byot: { provider: "anthropic" },
    });
  });

  it("returns undefined when there is no usable byot config (so the snapshot stays lean)", () => {
    expect(byotSystemConfigFromDoc(undefined)).toBeUndefined();
    expect(byotSystemConfigFromDoc({})).toBeUndefined();
    expect(byotSystemConfigFromDoc({ byot: {} })).toBeUndefined();
    expect(byotSystemConfigFromDoc({ byot: null as unknown as Record<string, unknown> })).toBeUndefined();
  });
});

describe("mapProjectAgentState", () => {
  it("maps a project agent with its minted secret", () => {
    expect(
      mapProjectAgentState(
        "orbit",
        { agent: { activationId: "activation-1", status: "provisioning" } },
        { mmUserId: "bot-1", personalToken: "pat-1" },
      ),
    ).toEqual({ projectId: "orbit", enabled: true, mmUserId: "bot-1", token: "pat-1", activationId: "activation-1", status: "provisioning" });
  });

  it("maps an unminted agent with null credentials", () => {
    expect(mapProjectAgentState("orbit", { agent: {} }, undefined)).toEqual({
      projectId: "orbit",
      enabled: true,
      mmUserId: null,
      token: null, activationId: null, status: null,
    });
  });

  it("projects an archived project's agent as retire-pending instead of runnable", () => {
    expect(
      mapProjectAgentState(
        "orbit",
        {
          agent: {},
          commercialLifecycle: { status: "archived" },
        },
        { mmUserId: "bot-1", personalToken: "pat-1" },
      ),
    ).toEqual({
      projectId: "orbit",
      enabled: false,
      mmUserId: "bot-1",
      token: "pat-1", activationId: null, status: null,
    });
  });

  it("keeps an archived entry while a secret lingers (retire pending)", () => {
    expect(
      mapProjectAgentState("orbit", { agent: {}, commercialLifecycle: { status: "archived" } }, { mmUserId: "bot-1", personalToken: "pat-1" }),
    ).toEqual({ projectId: "orbit", enabled: false, mmUserId: "bot-1", token: "pat-1", activationId: null, status: null });
  });

  it("returns null when the project has no agent state at all (snapshot stays lean)", () => {
    expect(mapProjectAgentState("orbit", {}, undefined)).toBeNull();
    expect(mapProjectAgentState("orbit", { agent: {}, commercialLifecycle: { status: "archived" } }, undefined)).toBeNull();
  });

  it("treats malformed agent/secret shapes as absent", () => {
    expect(mapProjectAgentState("orbit", { agent: "yes" }, undefined)).toBeNull();
    expect(
      mapProjectAgentState("orbit", { agent: {} }, { mmUserId: 7, personalToken: null }),
    ).toEqual({ projectId: "orbit", enabled: true, mmUserId: null, token: null, activationId: null, status: null });
  });
});

describe("collectProjectAgentStates", () => {
  function fakeDb(
    projects: Array<{ id: string; data: Record<string, unknown> }>,
    secrets: Record<string, Record<string, unknown>>,
  ) {
    const secretReads: string[] = [];
    const db = {
      collection: (_name: string) => ({
        doc: (id: string) => ({
          get: async () => ({ data: () => secrets[id] }),
          collection: (sub: string) =>
            sub === "projects"
              ? { doc: () => { throw new Error("unused"); }, get: async () => ({ docs: projects.map((p) => ({ id: p.id, data: () => p.data })) }) }
              : {
                  doc: (secretId: string) => {
                    secretReads.push(secretId);
                    return {
                      get: async () => ({ data: () => secrets[secretId] }),
                      collection: () => { throw new Error("unused"); },
                    };
                  },
                  get: async () => ({
                    docs: Object.entries(secrets).map(([id, data]) => ({ id, data: () => data })),
                  }),
                },
        }),
        get: async () => { throw new Error("unused"); },
      }),
    };
    return { db, secretReads };
  }

  it("collects live and retire-pending agents, skipping untouched projects without secret reads", async () => {
    const { db, secretReads } = fakeDb(
      [
        { id: "orbit", data: { agent: {} } },
        { id: "plain", data: {} },
        { id: "old", data: { agent: {}, commercialLifecycle: { status: "archived" } } },
      ],
      {
        "projectAgentMattermost-orbit": { mmUserId: "bot-1", personalToken: "pat-1" },
        "projectAgentMattermost-old": { mmUserId: "bot-2", personalToken: "pat-2" },
      },
    );

    const states = await collectProjectAgentStates(db, "uid-1", "alice");

    expect(states).toEqual([
      { projectId: "orbit", enabled: true, mmUserId: "bot-1", token: "pat-1", activationId: null, status: null },
      { projectId: "old", enabled: false, mmUserId: "bot-2", token: "pat-2", activationId: null, status: null },
    ]);
    expect(secretReads).toEqual(["projectAgentMattermost-orbit", "projectAgentMattermost-old"]);
  });

  it("quarantines a malformed identity without blocking healthy projects or retiring its bot", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db } = fakeDb([
      { id: "broken", data: { agent: { identity: { name: "Broken" }, kickoff: { status: "pending" } } } },
      { id: "healthy", data: { agent: { identity: { name: "Chip", emoji: "⛳", persona: "Caddie" } } } },
    ], {
      "projectAgentMattermost-broken": { mmUserId: "bot-broken", personalToken: "pat-broken" },
      "projectAgentMattermost-healthy": { mmUserId: "bot-healthy", personalToken: "pat-healthy" },
    });
    try {
      const states = await collectProjectAgentStates(db, "uid-1", "alice");
      expect(states).toHaveLength(2);
      expect(states[0]).toEqual({ projectId: "broken", enabled: true, mmUserId: "bot-broken", token: "pat-broken", status: "error", activationId: null });
      expect(states[1]).toMatchObject({ projectId: "healthy", identity: { name: "Chip", emoji: "⛳", persona: "Caddie" } });
      expect(JSON.parse(String(error.mock.calls[0][0]))).toMatchObject({ severity: "ERROR", message: "Project agent identity rejected", projectId: "broken", error: "Invalid project agent identity" });
    } finally { error.mockRestore(); }
  });

  it("drops fully-settled archived agents (no secret left)", async () => {
    const { db } = fakeDb([{ id: "old", data: { agent: {}, commercialLifecycle: { status: "archived" } } }], {});

    expect(await collectProjectAgentStates(db, "uid-1", "alice")).toEqual([]);
  });
});

describe("collectProjectAgentStates — orphaned secrets (deleted projects)", () => {
  it("emits a retire-pending state for a projectAgentMattermost-* secret whose project doc is gone", async () => {
    const projects: Array<{ id: string; data: Record<string, unknown> }> = [];
    const secrets: Record<string, Record<string, unknown>> = {
      "projectAgentMattermost-ghost": { mmUserId: "bot-ghost", personalToken: "pat-ghost" },
      coachMattermost: { personalToken: "coach-pat" },
    };
    const db = {
      collection: (_name: string) => ({
        doc: (_id: string) => ({
          get: async () => ({ data: () => undefined }),
          collection: (sub: string) =>
            sub === "projects"
              ? {
                  doc: () => { throw new Error("unused"); },
                  get: async () => ({ docs: projects.map((p) => ({ id: p.id, data: () => p.data })) }),
                }
              : {
                  doc: (secretId: string) => ({
                    get: async () => ({ data: () => secrets[secretId] }),
                    collection: () => { throw new Error("unused"); },
                  }),
                  get: async () => ({
                    docs: Object.entries(secrets).map(([id, data]) => ({ id, data: () => data })),
                  }),
                },
        }),
        get: async () => { throw new Error("unused"); },
      }),
    };

    const states = await collectProjectAgentStates(db, "uid-1", "alice");

    expect(states).toEqual([
      { projectId: "ghost", enabled: false, mmUserId: "bot-ghost", token: "pat-ghost", activationId: null, status: null },
    ]);
  });
});

describe("agent-model selections ride the snapshot regardless of byot state", () => {
  const AGENT_MODELS = {
    "octogee-acme-coach": {
      primary: "platform-openrouter/z-ai/glm-5.2",
      fallbacks: ["anthropic/claude-haiku-4-5"],
    },
  };

  it("projects agentModels alongside an active modelCredential", () => {
    expect(
      byotSnapshotProjectionFromSystemConfig({
        modelCredential: { active: true, provider: "anthropic" },
        agentModels: AGENT_MODELS,
      }).systemConfig,
    ).toEqual({ byot: { provider: "anthropic" }, agentModels: AGENT_MODELS });
  });

  it("projects agentModels even when no credential exists (platform customer picks)", () => {
    expect(byotSystemConfigFromDoc({ agentModels: AGENT_MODELS })).toEqual({
      agentModels: AGENT_MODELS,
    });
    expect(
      byotSnapshotProjectionFromSystemConfig({
        modelCredential: { active: false, provider: "openai" },
        agentModels: AGENT_MODELS,
      }).systemConfig,
    ).toEqual({ agentModels: AGENT_MODELS });
  });

  it("drops malformed selections at the projection boundary", () => {
    expect(
      byotSystemConfigFromDoc({
        agentModels: { "octogee-acme-coach": { primary: "no-slash" }, junk: 42 },
      }),
    ).toBeUndefined();
  });
});
