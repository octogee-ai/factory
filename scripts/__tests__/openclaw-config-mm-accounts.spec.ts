import { readFileSync } from "node:fs";

import { describe, it, expect, vi } from "vitest";
import {
  activeAgentProjectIds,
  buildCustomerAgent,
  buildMattermostAccounts,
  buildCustomerBindings,
  buildProjectAgentAccounts,
  buildProjectAgents,
  fetchCoachTokens,
  gatewayAgentRoster,
  gatewayAgentRosterBuilderSlug,
  mattermostAccountBindingsNeedActivation,
  mattermostAccountBindingsNeedingActivation,
  PRODUCTIVITY_TOOL_NAMES,
  PROJECT_AGENT_ALLOWED_TOOLS,
  PROJECT_AGENT_DENIED_TOOLS,
  SAFE_DEFAULT_AGENT_ID,
  type CoachTokenDeps,
} from "../lib/openclaw-config-builders.js";

const CHRIS_MM_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
const SAM_MM_ID = "cccccccccccccccccccccccccc";
const PAT_MM_ID = "dddddddddddddddddddddddddd";

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

  it("keeps productivity tools catalog-visible for the workspace coach", () => {
    const agent = buildCustomerAgent({
      uid: "uid-chris",
      slug: "chris",
      customerDir: "/customers/chris",
      agentDir: "/agents/octogee-chris-coach/agent",
      coach: { name: "Coach", emoji: "🤖", model: "house" },
      customerMmUserId: CHRIS_MM_ID,
    });

    expect(agent.tools).toMatchObject({ toolsBySender: {} });
    expect((agent.tools as { alsoAllow: string[] }).alsoAllow).toEqual(
      expect.arrayContaining(PRODUCTIVITY_TOOL_NAMES),
    );
  });

  it("allows workspace and project-scoped commits for the workspace coach", () => {
    const agent = buildCustomerAgent({
      uid: "uid-chris",
      slug: "chris",
      customerDir: "/customers/chris",
      agentDir: "/agents/octogee-chris-coach/agent",
      coach: { name: "Coach", emoji: "🤖", model: "house" },
    });

    expect((agent.tools as { alsoAllow: string[] }).alsoAllow).toEqual(
      expect.arrayContaining(["workspace_commit", "octogee_project_commit"]),
    );
  });

  it("gives project agents native directory listing without custom search or direct terminal access", () => {
    expect(PROJECT_AGENT_ALLOWED_TOOLS).toEqual(
      expect.arrayContaining(["read", "ls"]),
    );
    expect(PROJECT_AGENT_ALLOWED_TOOLS).not.toContain("grep");
    expect(PROJECT_AGENT_ALLOWED_TOOLS).not.toContain("find");
    expect(PROJECT_AGENT_DENIED_TOOLS).toEqual(expect.arrayContaining(["exec", "process"]));
  });

  it("exposes capability and isolated runs only through customer project lanes", () => {
    const coach = buildCustomerAgent({
      uid: "uid-chris",
      slug: "chris",
      customerDir: "/customers/chris",
      agentDir: "/agents/octogee-chris-coach/agent",
      coach: { name: "Coach", emoji: "🤖", model: "house" },
    });
    const runTools = ["octogee_project_capability", "octogee_project_build", "octogee_project_test", "octogee_project_preview", "octogee_project_run_status"];
    expect((coach.tools as { alsoAllow: string[] }).alsoAllow).toEqual(expect.arrayContaining(runTools));
    expect(PROJECT_AGENT_ALLOWED_TOOLS).toEqual(expect.arrayContaining(runTools));
    expect(PROJECT_AGENT_DENIED_TOOLS).not.toEqual(expect.arrayContaining(runTools));
  });

  it("keeps recipe and Board workflows available to coaches and project-locked agents", () => {
    const coach = buildCustomerAgent({
      uid: "uid-chris",
      slug: "chris",
      customerDir: "/customers/chris",
      agentDir: "/agents/octogee-chris-coach/agent",
      coach: { name: "Coach", emoji: "🤖", model: "house" },
    });
    const projectTools = [
      "octogee_project_set_recipe",
      "octogee_board_list",
      "octogee_board_card_read",
      "octogee_board_card_create",
      "octogee_board_card_update",
      "octogee_board_card_move",
      "octogee_board_card_comment",
    ];
    expect((coach.tools as { alsoAllow: string[] }).alsoAllow).toEqual(expect.arrayContaining(projectTools));
    expect(PROJECT_AGENT_ALLOWED_TOOLS).toEqual(expect.arrayContaining(projectTools));
    expect(PROJECT_AGENT_DENIED_TOOLS).not.toEqual(expect.arrayContaining(projectTools));
  });

  it("exposes publish only to the Workspace Coach", () => {
    const coach = buildCustomerAgent({
      uid: "uid-chris",
      slug: "chris",
      customerDir: "/customers/chris",
      agentDir: "/agents/octogee-chris-coach/agent",
      coach: { name: "Coach", emoji: "🤖", model: "house" },
    });
    expect((coach.tools as { alsoAllow: string[] }).alsoAllow).toContain("octogee_project_publish");
    expect(PROJECT_AGENT_ALLOWED_TOOLS).not.toContain("octogee_project_publish");
    expect(PROJECT_AGENT_DENIED_TOOLS).toContain("octogee_project_publish");
  });

  it("retires every in-gateway preview and publish tool", () => {
    const coach = buildCustomerAgent({
      uid: "uid-chris",
      slug: "chris",
      customerDir: "/customers/chris",
      agentDir: "/agents/octogee-chris-coach/agent",
      coach: { name: "Coach", emoji: "🤖", model: "house" },
    });
    const tools = coach.tools as { alsoAllow: string[]; deny: string[] };
    const retired = ["preview_start", "preview_stop", "preview_list", "octogee_publish"];
    expect(tools.alsoAllow).not.toEqual(expect.arrayContaining(retired));
    expect(tools.deny).toEqual(expect.arrayContaining(retired));
    expect(PROJECT_AGENT_DENIED_TOOLS).toEqual(expect.arrayContaining(retired));
  });

  it("keeps tool visibility independent of the inbound sender projection", () => {
    for (const customerMmUserId of [undefined, "mm-chris", "A".repeat(26)]) {
      const agent = buildCustomerAgent({
        uid: "uid-chris",
        slug: "chris",
        customerDir: "/customers/chris",
        agentDir: "/agents/octogee-chris-coach/agent",
        coach: { name: "Coach", emoji: "🤖", model: "house" },
        customerMmUserId,
      });
      expect(agent.tools).toMatchObject({ toolsBySender: {} });
      expect((agent.tools as { toolsBySender: Record<string, unknown> }).toolsBySender)
        .toEqual({});
    }
  });

  it("keeps the productivity policy synchronized with the connector manifest", () => {
    const manifest = JSON.parse(readFileSync(
      new URL(
        "../../infra/gateway/extensions/octogee-connector-tools/openclaw.plugin.json",
        import.meta.url,
      ),
      "utf8",
    )) as { contracts: { tools: string[] } };

    expect(PRODUCTIVITY_TOOL_NAMES).toHaveLength(29);
    expect([...PRODUCTIVITY_TOOL_NAMES].sort()).toEqual(manifest.contracts.tools.slice().sort());
  });
});

describe("gatewayAgentRoster", () => {
  it("uses a non-customer sentinel without a legacy default marker on a shared gateway", () => {
    const roster = gatewayAgentRoster([
      { id: "octogee-mike-coach", default: true },
      { id: "octogee-ceckert-coach" },
    ], "");

    expect(roster[0]).toMatchObject({
      id: SAFE_DEFAULT_AGENT_ID,
      heartbeat: { every: "0m" },
    });
    expect(roster[0]).not.toHaveProperty("default");
    expect(roster.slice(1)).toEqual([
      { id: "octogee-mike-coach" },
      { id: "octogee-ceckert-coach" },
    ]);
  });

  it("keeps a dedicated gateway free of legacy default markers", () => {
    expect(gatewayAgentRoster([
      { id: "octogee-mike-coach" },
      { id: "octogee-ceckert-coach" },
    ], "ceckert")).toEqual([
      { id: "octogee-mike-coach" },
      { id: "octogee-ceckert-coach" },
    ]);
  });

  it("strips retired default markers end to end", () => {
    expect(gatewayAgentRoster(
      [
        { id: "octogee-ops", default: true },
        { id: SAFE_DEFAULT_AGENT_ID, default: true },
      ],
      gatewayAgentRosterBuilderSlug({ GATEWAY_CLASS: "operator" }),
    )).toEqual([
      expect.objectContaining({ id: SAFE_DEFAULT_AGENT_ID }),
      { id: "octogee-ops" },
    ]);
  });

  it("treats shared class as authoritative over a stale Builder slug", () => {
    expect(gatewayAgentRosterBuilderSlug({
      GATEWAY_CLASS: "shared",
      GATEWAY_BUILDER_SLUG: "mike",
    })).toBe("");
  });

  it("fails a retired operator class closed to the shared routing sentinel", () => {
    expect(gatewayAgentRosterBuilderSlug({ GATEWAY_CLASS: "operator" })).toBe("");
  });
});

describe("mattermostAccountBindingsNeedActivation", () => {
  it("does not restart for a new peer channel once that account's stable route is already live", () => {
    const account = {
      agentId: "octogee-ceckert-coach",
      match: { channel: "mattermost" as const, accountId: "ceckert-coach" },
    };
    const newPeer = {
      agentId: "octogee-ceckert-coach",
      match: {
        channel: "mattermost" as const,
        accountId: "ceckert-coach",
        peer: { kind: "group" as const, id: "new-project-channel" },
      },
    };

    expect(mattermostAccountBindingsNeedActivation([account], [account, newPeer])).toBe(false);
  });

  it("requires activation when a new project bot account route is introduced", () => {
    const current = [{
      agentId: "octogee-ceckert-coach",
      match: { channel: "mattermost", accountId: "ceckert-coach" },
    }];
    const desired = buildCustomerBindings([{
      slug: "ceckert",
      channels: [],
      agentProjects: new Set(["gardyn"]),
    }]);

    expect(mattermostAccountBindingsNeedActivation(current, desired)).toBe(true);
  });

  it("requires activation when a foreign agent still owns a desired account route", () => {
    const desired = buildCustomerBindings([{
      slug: "ceckert",
      channels: [{ channelId: "gardyn" }],
    }]);
    const current = [
      ...desired,
      {
        agentId: "octogee-mike-coach",
        match: {
          channel: "mattermost",
          accountId: "ceckert-coach",
          peer: { kind: "group", id: "gardyn" },
        },
      },
    ];

    expect(mattermostAccountBindingsNeedActivation(current, desired)).toBe(true);
  });

  it("marks a still-configured foreign account when its poisoned customer route is removed", () => {
    const desired = buildCustomerBindings([{
      slug: "ceckert",
      channels: [{ channelId: "gardyn" }],
    }]);
    const current = [
      ...desired,
      {
        agentId: "octogee-mike-coach",
        match: { channel: "mattermost", accountId: "mike-coach" },
      },
      {
        agentId: "octogee-ceckert-coach",
        match: {
          channel: "mattermost",
          accountId: "mike-coach",
          peer: { kind: "group", id: "mike-general" },
        },
      },
      {
        agentId: "octogee-jack-coach",
        match: { channel: "mattermost", accountId: "jack-coach" },
      },
      {
        agentId: "octogee-ceckert-proj-retired-coach",
        match: {
          channel: "mattermost",
          accountId: "jack-coach",
          peer: { kind: "group", id: "jack-general" },
        },
      },
    ];

    expect(mattermostAccountBindingsNeedingActivation(current, desired)).toEqual([
      "jack-coach",
      "mike-coach",
    ]);
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
      [{ uid: "uid-a", slug: "chris", customerMmUserId: CHRIS_MM_ID }],
      new Map([["uid-a", "tok-chris"]]),
    );
    expect(accounts.admin).toBeUndefined();
  });

  it("lets channel members trigger ordinary work while reserving approvals and DMs for each owner", () => {
    const accounts = buildMattermostAccounts(
      [
        { uid: "uid-a", slug: "chris", customerMmUserId: CHRIS_MM_ID },
        { uid: "uid-b", slug: "sam", customerMmUserId: SAM_MM_ID },
      ],
      new Map([
        ["uid-a", "tok-chris"],
        ["uid-b", "tok-sam"],
      ]),
    );
    expect(accounts["chris-coach"]).toEqual({
      botToken: { source: "file", provider: "octogee-mattermost", id: "/chris-coach" },
      dmPolicy: "allowlist",
      allowFrom: [CHRIS_MM_ID],
      groupPolicy: "open",
      groups: null,
      commands: { native: false },
    });
    expect(accounts["sam-coach"]).toEqual({
      botToken: { source: "file", provider: "octogee-mattermost", id: "/sam-coach" },
      dmPolicy: "allowlist",
      allowFrom: [SAM_MM_ID],
      groupPolicy: "open",
      groups: null,
      commands: { native: false },
    });
  });

  it("OMITS customers without a PAT — never emits a null/empty botToken", () => {
    const accounts = buildMattermostAccounts(
      [
        { uid: "uid-a", slug: "chris", customerMmUserId: CHRIS_MM_ID },
        { uid: "uid-b", slug: "sam" },
      ],
      new Map([["uid-a", "tok-chris"]]),
    );
    expect(accounts["chris-coach"]).toMatchObject({
      botToken: { source: "file", provider: "octogee-mattermost", id: "/chris-coach" },
      groupPolicy: "open",
    });
    expect(accounts["sam-coach"]).toBeUndefined();
    expect(Object.values(accounts).every((a) => a.botToken.source === "file")).toBe(true);
  });

  it("routes tokens and owner approval ids per uid without cross-workspace bleed", () => {
    const accounts = buildMattermostAccounts(
      [
        { uid: "uid-a", slug: "chris", customerMmUserId: CHRIS_MM_ID },
        { uid: "uid-b", slug: "sam", customerMmUserId: SAM_MM_ID },
        { uid: "uid-c", slug: "pat", customerMmUserId: PAT_MM_ID },
      ],
      new Map([
        ["uid-a", "tok-A"],
        ["uid-b", "tok-B"],
        ["uid-c", "tok-C"],
      ]),
    );
    expect(accounts["chris-coach"].allowFrom).toEqual([CHRIS_MM_ID]);
    expect(accounts["sam-coach"].allowFrom).toEqual([SAM_MM_ID]);
    expect(accounts["pat-coach"].allowFrom).toEqual([PAT_MM_ID]);
    expect(Object.values(accounts).every((account) => account.groupPolicy === "open")).toBe(true);
  });

  it("skips the account when the owner Mattermost id is unavailable", () => {
    const warn = vi.fn();
    const accounts = buildMattermostAccounts(
      [{ uid: "uid-a", slug: "chris" }],
      new Map([["uid-a", "tok-chris"]]),
      warn,
    );
    expect(accounts).toEqual({});
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("owner Mattermost id is unavailable"));
  });

  it("clears mention overrides because project replies are blocked at dispatch", () => {
    const accounts = buildMattermostAccounts(
      [
        {
          uid: "uid-a",
          slug: "chris",
          customerMmUserId: CHRIS_MM_ID,
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

    expect(accounts["chris-coach"].groups).toBeNull();
    expect(JSON.stringify(accounts["chris-coach"])).not.toContain("enabled");
  });

  it("clears stale mention overrides even when no project agent remains active", () => {
    const accounts = buildMattermostAccounts(
      [
        {
          uid: "uid-a",
          slug: "chris",
          customerMmUserId: CHRIS_MM_ID,
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
  it("pins the customer account before its peer bindings so a new channel cannot fall through to another tenant", () => {
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
        },
      },
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
    const chrisBinding = bindings.find(
      (b) => "peer" in b.match && b.match.peer.id === "chris-general",
    );
    const samBinding = bindings.find(
      (b) => "peer" in b.match && b.match.peer.id === "sam-general",
    );
    expect(chrisBinding?.match.accountId).toBe("chris-coach");
    expect(samBinding?.match.accountId).toBe("sam-coach");
    expect(chrisBinding?.agentId).toBe("octogee-chris-coach");
    expect(samBinding?.agentId).toBe("octogee-sam-coach");
  });

  it("still pins a provisioned customer account when it has no discovered channels yet", () => {
    const bindings = buildCustomerBindings([
      { slug: "chris", channels: [] },
    ]);
    expect(bindings).toEqual([
      {
        agentId: "octogee-chris-coach",
        match: { channel: "mattermost", accountId: "chris-coach" },
      },
    ]);
  });

  it("leaves the retired Admin channel unbound while retaining the Builder Coach channel", () => {
    const bindings = buildCustomerBindings([
      {
        slug: "chris",
        channels: [
          { channelId: "ch-admin", scope: "workspace", kind: "admin" },
          { channelId: "ch-coach", scope: "workspace", kind: "coach-dm" },
        ],
      },
    ]);

    expect(bindings.map((binding) =>
      "peer" in binding.match ? binding.match.peer.id : null)).not.toContain("ch-admin");
    expect(bindings).toContainEqual({
      agentId: "octogee-chris-coach",
      match: {
        channel: "mattermost",
        accountId: "chris-coach",
        peer: { kind: "group", id: "ch-coach" },
      },
    });
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
  it("uses the project's identity independently of the workspace coach", () => {
    const [agent] = buildProjectAgents({ slug: "chris", customerDir: "/customers/chris", agentsDir: "/agents",
      coach: { name: "Piper", emoji: "🧭", model: "house" },
      projectAgents: [{ projectId: "fairway", enabled: true, token: "pat", mmUserId: "bot",
        identity: { name: "Chip", emoji: "⛳", persona: "Friendly caddie" } }],
    });
    expect(agent).toMatchObject({ name: "Chip (chris/fairway)", identity: { name: "Chip", emoji: "⛳" } });
  });

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
      ownerMmUserId: CHRIS_MM_ID,
    });

    expect(agents).toEqual([
      {
        id: "octogee-chris-proj-orbit-coach",
        name: "Orbit (chris/orbit)",
        workspace: "/customers/chris/projects/orbit",
        agentDir: "/agents/octogee-chris-proj-orbit-coach/agent",
        model: "anthropic/claude-sonnet-4-6",
        identity: { name: "Orbit", emoji: "🤖" },
        tools: {
          profile: "minimal",
          alsoAllow: PROJECT_AGENT_ALLOWED_TOOLS,
          deny: PROJECT_AGENT_DENIED_TOOLS,
          exec: { mode: "deny", host: "node" },
          fs: { workspaceOnly: true },
          toolsBySender: { "*": { deny: [...PRODUCTIVITY_TOOL_NAMES] } },
        },
      },
    ]);
    expect(agents[0].tools).toMatchObject({
      alsoAllow: expect.arrayContaining(["octogee_project_commit"]),
      deny: expect.arrayContaining([
        "exec",
        "process",
        "terminal",
        "subagents",
        "sessions_spawn",
        "preview_start",
        "octogee_publish",
        "bundle-mcp",
        "browser",
        "automations",
        "skill_workshop",
        "delegated_access",
        "octogee_status",
      ]),
    });
    expect(agents[0].tools.alsoAllow).not.toContain("workspace_commit");
    expect(agents[0].tools.deny).toContain("workspace_commit");
    expect(agents[0].tools.deny).not.toContain("octogee_project_commit");
  });

  it("lets project agents inherit the full-power tool policy on a Builder gateway", () => {
    const [agent] = buildProjectAgents({
      slug: "chris",
      customerDir: "/customers/chris",
      agentsDir: "/agents",
      coach: { name: "BenderEcho", emoji: "🤖", model: "anthropic/claude-sonnet-4-6" },
      projectAgents,
      ownerMmUserId: CHRIS_MM_ID,
      hostCode: "builder-full",
    });

    expect(agent).not.toHaveProperty("tools");
  });

});

describe("buildProjectAgentAccounts", () => {
  it("emits shared accounts only for active agents, keyed {slug}-proj-{pid}", () => {
    const accounts = buildProjectAgentAccounts("chris", [
      { projectId: "orbit", enabled: true, token: "pat-1", mmUserId: "bot-1" },
      { projectId: "unminted", enabled: true, token: null, mmUserId: null },
      { projectId: "retired", enabled: false, token: "pat-2", mmUserId: "bot-2" },
    ], CHRIS_MM_ID);

    expect(accounts).toEqual({
      "chris-proj-orbit": {
        botToken: { source: "file", provider: "octogee-mattermost", id: "/chris-proj-orbit" },
        allowFrom: [CHRIS_MM_ID],
        dmPolicy: "disabled",
        groupPolicy: "open",
        commands: { native: false },
      },
    });
  });

  it("disables project-agent DMs on Builder gateways while keeping owner approval identity", () => {
    const accounts = buildProjectAgentAccounts("chris", [
      { projectId: "orbit", enabled: true, token: "pat-1", mmUserId: "bot-1" },
    ], CHRIS_MM_ID);

    expect(accounts["chris-proj-orbit"].dmPolicy).toBe("disabled");
    expect(accounts["chris-proj-orbit"].allowFrom).toEqual([CHRIS_MM_ID]);
  });

  it("does not emit a project account without an exact owner Mattermost id", () => {
    const accounts = buildProjectAgentAccounts("chris", [
      { projectId: "orbit", enabled: true, token: "pat-1", mmUserId: "bot-1" },
    ]);

    expect(accounts).toEqual({});
  });
});

describe("buildCustomerBindings — Vegas partition", () => {
  const channels = [
    { channelId: "ws-general", scope: "workspace" as const },
    { channelId: "proj-orbit-gen", scope: "project" as const, projectId: "orbit" },
    { channelId: "proj-nova-gen", scope: "project" as const, projectId: "nova" },
  ];

  it("routes only workspace channels to the coach and leaves projects without an active agent unbound", () => {
    const bindings = buildCustomerBindings([
      { slug: "chris", channels, agentProjects: new Set(["orbit"]) },
    ]);

    expect(bindings).toEqual([
      {
        agentId: "octogee-chris-coach",
        match: { channel: "mattermost", accountId: "chris-coach" },
      },
      {
        agentId: "octogee-chris-proj-orbit-coach",
        match: { channel: "mattermost", accountId: "chris-proj-orbit" },
      },
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
    ]);
  });

  it("partition invariant: exactly one binding per channel; workspace channels never bind to a project agent", () => {
    const bindings = buildCustomerBindings([
      { slug: "chris", channels, agentProjects: new Set(["orbit", "nova"]) },
    ]);

    const byChannel = new Map<string, string[]>();
    for (const b of bindings) {
      if (!("peer" in b.match)) continue;
      const list = byChannel.get(b.match.peer.id) ?? [];
      list.push(b.agentId);
      byChannel.set(b.match.peer.id, list);
    }
    for (const agents of byChannel.values()) {
      expect(agents).toHaveLength(1);
    }
    expect(byChannel.get("ws-general")).toEqual(["octogee-chris-coach"]);
  });

  it("never falls back to the workspace coach for projects without an active agent", () => {
    const bindings = buildCustomerBindings([{ slug: "chris", channels }]);
    expect(bindings.flatMap(b => b.match.peer ? [b.match.peer.id] : [])).toEqual(["ws-general"]);
    for (const b of bindings) {
      expect(b.agentId).toBe("octogee-chris-coach");
      expect(b.match.accountId).toBe("chris-coach");
    }
  });

  it("pins every active project bot account even before its channel-specific binding is live", () => {
    const bindings = buildCustomerBindings([
      {
        slug: "chris",
        channels: [],
        agentProjects: new Set(["orbit", "nova"]),
      },
    ]);

    expect(bindings).toEqual([
      {
        agentId: "octogee-chris-coach",
        match: { channel: "mattermost", accountId: "chris-coach" },
      },
      {
        agentId: "octogee-chris-proj-nova-coach",
        match: { channel: "mattermost", accountId: "chris-proj-nova" },
      },
      {
        agentId: "octogee-chris-proj-orbit-coach",
        match: { channel: "mattermost", accountId: "chris-proj-orbit" },
      },
    ]);
  });
});

it('excludes an agent in error from all runtime accounts and bindings without using a fallback identity', () => {
  const projectAgents = [{ projectId: 'broken', enabled: true, status: 'error' as const, mmUserId: 'bot', token: 'pat' }];
  expect([...activeAgentProjectIds(projectAgents)]).toEqual([]);
  expect(buildProjectAgentAccounts('chris', projectAgents, CHRIS_MM_ID)).toEqual({});
  expect(buildProjectAgents({ slug: 'chris', customerDir: '/customers/chris', agentsDir: '/agents',
    coach: { name: 'Piper', emoji: '🤖', model: 'house' }, projectAgents })).toEqual([]);
});
