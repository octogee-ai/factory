import { describe, it, expect, vi } from "vitest";
import {
  activeAgentProjectIds,
  buildCustomerAgent,
  buildMattermostAccounts,
  buildCustomerBindings,
  buildProjectAgentAccounts,
  buildProjectAgents,
  fetchCoachTokens,
  type CoachTokenDeps,
} from "../lib/openclaw-config-builders.js";

describe("buildCustomerAgent", () => {
  it("marks the isolated gateway Builder coach as OpenClaw's explicit default", () => {
    expect(buildCustomerAgent({
      uid: "uid-chris",
      slug: "chris",
      customerDir: "/customers/chris",
      agentDir: "/agents/octogee-chris-coach/agent",
      coach: { name: "Coach", emoji: "🤖", model: "house" },
      default: true,
    })).toMatchObject({ id: "octogee-chris-coach", default: true });
  });

  it("does not claim default routing for a shared-gateway customer", () => {
    expect(buildCustomerAgent({
      uid: "uid-sam",
      slug: "sam",
      customerDir: "/customers/sam",
      agentDir: "/agents/octogee-sam-coach/agent",
      coach: { name: "Coach", emoji: "🤖", model: "house" },
    })).not.toHaveProperty("default");
  });
});

describe("fetchCoachTokens", () => {
  function mkDeps(
    docs: Record<string, { personalToken?: string } | undefined>,
    logSpy = vi.fn(),
  ): CoachTokenDeps & { logs: ReturnType<typeof vi.fn> } {
    const db = {
      collection: (_users: string) => ({
        doc: (uid: string) => ({
          collection: (_secrets: string) => ({
            doc: (_coachMm: string) => ({
              get: async () => {
                const data = docs[uid];
                return { exists: !!data, data: () => data };
              },
            }),
          }),
        }),
      }),
    };
    return { db, log: logSpy, logs: logSpy };
  }

  it("reads users/{uid}/secrets/coachMattermost.personalToken and keys by uid", async () => {
    const deps = mkDeps({
      "uid-chris": { personalToken: "tok-chris-abc123" },
      "uid-sam": { personalToken: "tok-sam-def456" },
    });
    const result = await fetchCoachTokens(deps, [
      { uid: "uid-chris", slug: "chris-builds-a3f2" },
      { uid: "uid-sam", slug: "sam-cooks-b4g3" },
    ]);
    expect(result.get("uid-chris")).toBe("tok-chris-abc123");
    expect(result.get("uid-sam")).toBe("tok-sam-def456");
    expect(result.size).toBe(2);
  });

  it("omits customers with no secrets doc and logs a warning", async () => {
    const logSpy = vi.fn();
    const deps = mkDeps(
      { "uid-chris": { personalToken: "tok-chris" } },
      logSpy,
    );
    const result = await fetchCoachTokens(deps, [
      { uid: "uid-chris", slug: "chris-builds-a3f2" },
      { uid: "uid-sam", slug: "sam-cooks-b4g3" },
    ]);
    expect(result.has("uid-chris")).toBe(true);
    expect(result.has("uid-sam")).toBe(false);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("sam-cooks-b4g3"),
    );
  });

  it("omits entries when secrets doc exists but personalToken is empty", async () => {
    const logSpy = vi.fn();
    const deps = mkDeps({ "uid-chris": { personalToken: "" } }, logSpy);
    const result = await fetchCoachTokens(deps, [
      { uid: "uid-chris", slug: "chris-builds-a3f2" },
    ]);
    expect(result.has("uid-chris")).toBe(false);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("chris-builds-a3f2"),
    );
  });

  it("tolerates Firestore errors for a single customer (continues others)", async () => {
    const logSpy = vi.fn();
    const db = {
      collection: (_users: string) => ({
        doc: (uid: string) => ({
          collection: (_secrets: string) => ({
            doc: (_coachMm: string) => ({
              get: async () => {
                if (uid === "uid-broken") throw new Error("firestore hiccup");
                return { exists: true, data: () => ({ personalToken: "tok-ok" }) };
              },
            }),
          }),
        }),
      }),
    };
    const result = await fetchCoachTokens({ db, log: logSpy }, [
      { uid: "uid-broken", slug: "broken-a1b2" },
      { uid: "uid-ok", slug: "ok-c3d4" },
    ]);
    expect(result.has("uid-broken")).toBe(false);
    expect(result.get("uid-ok")).toBe("tok-ok");
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("broken-a1b2"));
  });
});

describe("buildMattermostAccounts", () => {
  it("emits NO entries on empty input — no admin, no placeholders", () => {
    const accounts = buildMattermostAccounts([], new Map());
    expect(accounts).toEqual({});
  });

  it("NEVER emits an `admin` account (root cause of silent channel-start failure)", () => {
    const accounts = buildMattermostAccounts(
      [{ uid: "uid-a", slug: "chris", customerMmUserId: "mm-chris" }],
      new Map([["uid-a", "tok-chris"]]),
      "mm-admin",
    );
    expect(accounts.admin).toBeUndefined();
  });

  it("adds `{slug}-coach` entries with groupPolicy `open` (membership-gated) + advisory (customer, admin) seed", () => {
    const accounts = buildMattermostAccounts(
      [
        { uid: "uid-a", slug: "chris", customerMmUserId: "mm-chris" },
        { uid: "uid-b", slug: "sam", customerMmUserId: "mm-sam" },
      ],
      new Map([
        ["uid-a", "tok-chris"],
        ["uid-b", "tok-sam"],
      ]),
      "mm-admin",
    );
    expect(accounts["chris-coach"]).toEqual({
      botToken: { source: "file", provider: "octogee-mattermost", id: "/chris-coach" },
      groupPolicy: "open",
      groupAllowFrom: ["mm-chris", "mm-admin"],
      commands: { native: false },
    });
    expect(accounts["sam-coach"]).toEqual({
      botToken: { source: "file", provider: "octogee-mattermost", id: "/sam-coach" },
      groupPolicy: "open",
      groupAllowFrom: ["mm-sam", "mm-admin"],
      commands: { native: false },
    });
  });

  it("OMITS customers without a PAT — never emits a null/empty botToken", () => {
    const accounts = buildMattermostAccounts(
      [
        { uid: "uid-a", slug: "chris", customerMmUserId: "mm-chris" },
        { uid: "uid-b", slug: "sam" },
      ],
      new Map([["uid-a", "tok-chris"]]),
      "mm-admin",
    );
    expect(accounts["chris-coach"]).toMatchObject({
      botToken: { source: "file", provider: "octogee-mattermost", id: "/chris-coach" },
      groupPolicy: "open",
    });
    expect(accounts["sam-coach"]).toBeUndefined();
    expect(Object.values(accounts).every((a) => a.botToken.source === "file")).toBe(true);
  });

  it("routes tokens + allowlists per-uid — no cross-workspace bleed", () => {
    const accounts = buildMattermostAccounts(
      [
        { uid: "uid-a", slug: "chris", customerMmUserId: "mm-chris" },
        { uid: "uid-b", slug: "sam", customerMmUserId: "mm-sam" },
        { uid: "uid-c", slug: "pat", customerMmUserId: "mm-pat" },
      ],
      new Map([
        ["uid-a", "tok-A"],
        ["uid-b", "tok-B"],
        ["uid-c", "tok-C"],
      ]),
      "mm-admin",
    );
    expect(accounts["chris-coach"].groupAllowFrom).toEqual(["mm-chris", "mm-admin"]);
    expect(accounts["sam-coach"].groupAllowFrom).toEqual(["mm-sam", "mm-admin"]);
    expect(accounts["pat-coach"].groupAllowFrom).toEqual(["mm-pat", "mm-admin"]);
  });

  it("when customerMmUserId is absent, the advisory seed is {admin} but the gate stays open (membership-gated)", () => {
    const accounts = buildMattermostAccounts(
      [{ uid: "uid-a", slug: "chris" }],
      new Map([["uid-a", "tok-chris"]]),
      "mm-admin",
    );
    expect(accounts["chris-coach"].groupPolicy).toBe("open");
    expect(accounts["chris-coach"].groupAllowFrom).toEqual(["mm-admin"]);
  });

  it("still emits an `open` account when both customerMmUserId and adminMmUserId are missing (no allowlist needed; no skip)", () => {
    const warn = vi.fn();
    const accounts = buildMattermostAccounts(
      [{ uid: "uid-a", slug: "chris" }],
      new Map([["uid-a", "tok-chris"]]),
      undefined,
      warn,
    );
    expect(accounts["chris-coach"]).toEqual({
      botToken: { source: "file", provider: "octogee-mattermost", id: "/chris-coach" },
      groupPolicy: "open",
      commands: { native: false },
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("mention-gates the workspace coach only in channels owned by active project agents", () => {
    const accounts = buildMattermostAccounts(
      [
        {
          uid: "uid-a",
          slug: "chris",
          channels: [
            { channelId: "ws-general", scope: "workspace" },
            { channelId: "proj-orbit", scope: "project", projectId: "orbit" },
            { channelId: "proj-nova", scope: "project", projectId: "nova" },
          ],
          agentProjects: new Set(["orbit"]),
        },
      ],
      new Map([["uid-a", "tok-chris"]]),
    );

    expect(accounts["chris-coach"].groups).toEqual({
      "proj-orbit": { requireMention: true },
    });
  });

  it("clears stale workspace coach mention gates when no project agent remains active", () => {
    const accounts = buildMattermostAccounts(
      [
        {
          uid: "uid-a",
          slug: "chris",
          channels: [{ channelId: "proj-orbit", scope: "project", projectId: "orbit" }],
          agentProjects: new Set(),
        },
      ],
      new Map([["uid-a", "tok-chris"]]),
    );

    expect(accounts["chris-coach"].groups).toBeNull();
  });
});

describe("buildCustomerBindings", () => {
  it("emits one binding per customer channel with accountId pinned to {slug}-coach", () => {
    const bindings = buildCustomerBindings([
      {
        slug: "chris",
        channels: [{ channelId: "ch-general-1" }, { channelId: "ch-coach-1" }],
      },
    ]);
    expect(bindings).toEqual([
      {
        agentId: "octogee-chris-coach",
        match: {
          channel: "mattermost",
          accountId: "chris-coach",
          peer: { kind: "group", id: "ch-general-1" },
        },
      },
      {
        agentId: "octogee-chris-coach",
        match: {
          channel: "mattermost",
          accountId: "chris-coach",
          peer: { kind: "group", id: "ch-coach-1" },
        },
      },
    ]);
  });

  it("NEVER emits a binding without accountId (multi-tenant isolation lock)", () => {
    const bindings = buildCustomerBindings([
      { slug: "chris", channels: [{ channelId: "ch-1" }] },
      { slug: "sam", channels: [{ channelId: "ch-2" }] },
    ]);
    for (const b of bindings) {
      expect(b.match.accountId).toBeTruthy();
      expect(b.match.accountId).toMatch(/-coach$/);
    }
  });

  it("routes each customer's channels to their own accountId — no cross-tenant bleed", () => {
    const bindings = buildCustomerBindings([
      { slug: "chris", channels: [{ channelId: "chris-general" }] },
      { slug: "sam", channels: [{ channelId: "sam-general" }] },
    ]);
    const chrisBinding = bindings.find((b) => b.match.peer.id === "chris-general");
    const samBinding = bindings.find((b) => b.match.peer.id === "sam-general");
    expect(chrisBinding?.match.accountId).toBe("chris-coach");
    expect(samBinding?.match.accountId).toBe("sam-coach");
    expect(chrisBinding?.agentId).toBe("octogee-chris-coach");
    expect(samBinding?.agentId).toBe("octogee-sam-coach");
  });

  it("returns [] when a customer has zero channels (not-yet-provisioned)", () => {
    const bindings = buildCustomerBindings([
      { slug: "chris", channels: [] },
    ]);
    expect(bindings).toEqual([]);
  });
});

describe("activeAgentProjectIds", () => {
  it("selects only enabled agents that hold a minted token", () => {
    expect(
      activeAgentProjectIds([
        { projectId: "orbit", enabled: true, token: "pat-1", mmUserId: "bot-1" },
        { projectId: "unminted", enabled: true, token: null, mmUserId: null },
        { projectId: "retired", enabled: false, token: "pat-2", mmUserId: "bot-2" },
      ]),
    ).toEqual(new Set(["orbit"]));
  });
});

describe("buildProjectAgents", () => {
  const projectAgents = [
    { projectId: "orbit", enabled: true, token: "pat-1", mmUserId: "bot-1" },
    { projectId: "unminted", enabled: true, token: null, mmUserId: null },
    { projectId: "retired", enabled: false, token: "pat-2", mmUserId: "bot-2" },
  ];

  it("emits one agent entry per ACTIVE project agent, workspace pinned to the project clone", () => {
    const agents = buildProjectAgents({
      slug: "chris",
      customerDir: "/customers/chris",
      agentsDir: "/agents",
      coach: { name: "BenderEcho", emoji: "🤖", model: "anthropic/claude-sonnet-4-6" },
      projectAgents,
    });

    expect(agents).toEqual([
      {
        id: "octogee-chris-proj-orbit-coach",
        name: "BenderEcho (chris/orbit)",
        workspace: "/customers/chris/projects/orbit",
        agentDir: "/agents/octogee-chris-proj-orbit-coach/agent",
        model: "anthropic/claude-sonnet-4-6",
        identity: { name: "BenderEcho", emoji: "🤖" },
        tools: { fs: { workspaceOnly: true } },
      },
    ]);
  });
});

describe("buildProjectAgentAccounts", () => {
  it("emits accounts only for active agents, keyed {slug}-proj-{pid}", () => {
    const accounts = buildProjectAgentAccounts("chris", [
      { projectId: "orbit", enabled: true, token: "pat-1", mmUserId: "bot-1" },
      { projectId: "unminted", enabled: true, token: null, mmUserId: null },
      { projectId: "retired", enabled: false, token: "pat-2", mmUserId: "bot-2" },
    ]);

    expect(accounts).toEqual({
      "chris-proj-orbit": {
        botToken: { source: "file", provider: "octogee-mattermost", id: "/chris-proj-orbit" },
        groupPolicy: "open",
        commands: { native: false },
      },
    });
  });
});

describe("buildCustomerBindings — Vegas partition", () => {
  const channels = [
    { channelId: "ws-general", scope: "workspace" as const },
    { channelId: "proj-orbit-gen", scope: "project" as const, projectId: "orbit" },
    { channelId: "proj-nova-gen", scope: "project" as const, projectId: "nova" },
  ];

  it("routes agent-enabled project channels to the project agent, everything else to the coach", () => {
    const bindings = buildCustomerBindings([
      { slug: "chris", channels, agentProjects: new Set(["orbit"]) },
    ]);

    expect(bindings).toEqual([
      {
        agentId: "octogee-chris-coach",
        match: {
          channel: "mattermost",
          accountId: "chris-coach",
          peer: { kind: "group", id: "ws-general" },
        },
      },
      {
        agentId: "octogee-chris-proj-orbit-coach",
        match: {
          channel: "mattermost",
          accountId: "chris-proj-orbit",
          peer: { kind: "group", id: "proj-orbit-gen" },
        },
      },
      {
        agentId: "octogee-chris-coach",
        match: {
          channel: "mattermost",
          accountId: "chris-coach",
          peer: { kind: "group", id: "proj-nova-gen" },
        },
      },
    ]);
  });

  it("partition invariant: exactly one binding per channel; workspace channels never bind to a project agent", () => {
    const bindings = buildCustomerBindings([
      { slug: "chris", channels, agentProjects: new Set(["orbit", "nova"]) },
    ]);

    const byChannel = new Map<string, string[]>();
    for (const b of bindings) {
      const list = byChannel.get(b.match.peer.id) ?? [];
      list.push(b.agentId);
      byChannel.set(b.match.peer.id, list);
    }
    for (const agents of byChannel.values()) {
      expect(agents).toHaveLength(1);
    }
    expect(byChannel.get("ws-general")).toEqual(["octogee-chris-coach"]);
  });

  it("without agentProjects everything binds to the coach (pre-Vegas behavior)", () => {
    const bindings = buildCustomerBindings([{ slug: "chris", channels }]);
    for (const b of bindings) {
      expect(b.agentId).toBe("octogee-chris-coach");
      expect(b.match.accountId).toBe("chris-coach");
    }
  });
});
