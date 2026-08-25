import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  wireCoachMattermostBindings,
  wireCoachMattermostAccount,
} from "../provisionSteps.js";

vi.mock("../config.js", async () => {
  const actual: any = await vi.importActual("../config.js");
  return { ...actual, log: vi.fn() };
});

const SLUG = "ceckert";
const AGENT_ID = `octogee-${SLUG}-coach`;
const ACCOUNT_ID = `${SLUG}-coach`;

function mkMmUpdate(extra: Record<string, any> = {}): Record<string, any> {
  return {
    "mattermost.userId": "mm-ceckert",
    "mattermost.channelId": "ch-coach-dm",
    "mattermost.generalChannelId": "ch-general",
    "mattermost.adminChannelId": "ch-admin",
    _coachPersonalToken: "tok-ceckert-abc123",
    ...extra,
  };
}

const ORIG_ADMIN_ID = process.env.MM_ADMIN_USER_ID;
beforeEach(() => {
  process.env.MM_ADMIN_USER_ID = "mm-admin";
});
afterEach(() => {
  if (ORIG_ADMIN_ID === undefined) delete process.env.MM_ADMIN_USER_ID;
  else process.env.MM_ADMIN_USER_ID = ORIG_ADMIN_ID;
});

describe("wireCoachMattermostBindings", () => {
  it("writes bindings only for the Builder-facing Coach and General channels", () => {
    const config: any = { bindings: [] };
    wireCoachMattermostBindings(config, AGENT_ID, SLUG, mkMmUpdate());
    expect(config.bindings).toHaveLength(2);
    for (const b of config.bindings) {
      expect(b.agentId).toBe(AGENT_ID);
      expect(b.match.channel).toBe("mattermost");
      expect(b.match.accountId).toBe(ACCOUNT_ID);
      expect(b.match.peer.kind).toBe("group");
    }
    const channelIds = config.bindings.map((b: any) => b.match.peer.id).sort();
    expect(channelIds).toEqual(["ch-coach-dm", "ch-general"]);
  });

  it("REPLACES a legacy accountId-less binding in place (does not leave stale entries)", () => {
    const config: any = {
      bindings: [
        {
          agentId: AGENT_ID,
          match: {
            channel: "mattermost",
            peer: { kind: "group", id: "ch-coach-dm" },
          },
        },
      ],
    };
    wireCoachMattermostBindings(config, AGENT_ID, SLUG, mkMmUpdate());
    expect(config.bindings).toHaveLength(2);
    for (const b of config.bindings) {
      expect(b.match.accountId).toBe(ACCOUNT_ID);
    }
  });

  it("is idempotent on re-provision (same binding written twice yields one entry per channel)", () => {
    const config: any = { bindings: [] };
    wireCoachMattermostBindings(config, AGENT_ID, SLUG, mkMmUpdate());
    wireCoachMattermostBindings(config, AGENT_ID, SLUG, mkMmUpdate());
    expect(config.bindings).toHaveLength(2);
  });

  it("skips channels whose id is missing from mmUpdate", () => {
    const config: any = { bindings: [] };
    wireCoachMattermostBindings(config, AGENT_ID, SLUG, {
      "mattermost.channelId": "ch-coach-dm",
    });
    expect(config.bindings).toHaveLength(1);
    expect(config.bindings[0].match.peer.id).toBe("ch-coach-dm");
  });
});

describe("wireCoachMattermostAccount", () => {
  let logSpy: ReturnType<typeof vi.fn>;
  beforeEach(async () => {
    const cfgMod: any = await import("../config.js");
    logSpy = cfgMod.log as any;
    (logSpy as any).mockClear?.();
  });

  it("upserts accounts.{slug}-coach with allowlist scoped to (customer, admin)", () => {
    const config: any = {};
    wireCoachMattermostAccount(config, SLUG, mkMmUpdate());
    expect(config.channels.mattermost.accounts[ACCOUNT_ID]).toEqual({
      botToken: "tok-ceckert-abc123",
      groupPolicy: "allowlist",
      groupAllowFrom: ["mm-ceckert", "mm-admin"],
    });
  });

  it("does NOT set top-level groupPolicy=\"open\" (OpenClaw flags this as CRITICAL and refuses to start)", () => {
    const config: any = {};
    wireCoachMattermostAccount(config, SLUG, mkMmUpdate());
    expect(config.channels.mattermost.groupPolicy).toBeUndefined();
    expect(config.channels.mattermost.allowFrom).toBeUndefined();
  });

  it("does NOT emit an `admin` account (root cause of silent channel-start failure)", () => {
    const config: any = {};
    wireCoachMattermostAccount(config, SLUG, mkMmUpdate());
    expect(config.channels.mattermost.accounts.admin).toBeUndefined();
  });

  it("sets defaultAccount to \"default\" on a fresh config (not \"admin\")", () => {
    const config: any = {};
    wireCoachMattermostAccount(config, SLUG, mkMmUpdate());
    expect(config.channels.mattermost.defaultAccount).toBe("default");
  });

  it("preserves an existing defaultAccount (does not overwrite with \"default\")", () => {
    const config: any = {
      channels: {
        mattermost: {
          accounts: { "some-custom": { botToken: "tok" } },
          defaultAccount: "some-custom",
        },
      },
    };
    wireCoachMattermostAccount(config, SLUG, mkMmUpdate());
    expect(config.channels.mattermost.defaultAccount).toBe("some-custom");
    expect(config.channels.mattermost.accounts[ACCOUNT_ID]).toEqual({
      botToken: "tok-ceckert-abc123",
      groupPolicy: "allowlist",
      groupAllowFrom: ["mm-ceckert", "mm-admin"],
    });
  });

  it("preserves legacy top-level botToken / baseUrl / chatmode (OpenClaw migrates botToken at load time)", () => {
    const config: any = {
      channels: {
        mattermost: {
          botToken: "legacy-top-level-token",
          baseUrl: "http://mm.svc.cluster.local:8065",
          chatmode: "onmessage",
        },
      },
    };
    wireCoachMattermostAccount(config, SLUG, mkMmUpdate());
    expect(config.channels.mattermost.botToken).toBe("legacy-top-level-token");
    expect(config.channels.mattermost.baseUrl).toBe(
      "http://mm.svc.cluster.local:8065",
    );
    expect(config.channels.mattermost.chatmode).toBe("onmessage");
  });

  it("SKIPS the accounts upsert when _coachPersonalToken is missing", () => {
    const config: any = {};
    wireCoachMattermostAccount(
      config,
      SLUG,
      mkMmUpdate({ _coachPersonalToken: undefined }),
    );
    expect(config.channels.mattermost.accounts[ACCOUNT_ID]).toBeUndefined();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining(SLUG),
    );
  });

  it("SKIPS the accounts upsert when _coachPersonalToken is an empty string", () => {
    const config: any = {};
    wireCoachMattermostAccount(config, SLUG, mkMmUpdate({ _coachPersonalToken: "" }));
    expect(config.channels.mattermost.accounts[ACCOUNT_ID]).toBeUndefined();
  });

  it("fails closed when both customerMmUserId and MM_ADMIN_USER_ID are missing", () => {
    delete process.env.MM_ADMIN_USER_ID;
    const config: any = {};
    wireCoachMattermostAccount(
      config,
      SLUG,
      mkMmUpdate({ "mattermost.userId": undefined }),
    );
    expect(config.channels.mattermost.accounts[ACCOUNT_ID]).toBeUndefined();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("no authorized coach sender"));
  });

  it("per-customer account upsert is scoped by slug — no cross-tenant clobber", () => {
    const config: any = {
      channels: {
        mattermost: {
          accounts: {
            "sam-coach": { botToken: "tok-sam-preexisting" },
          },
        },
      },
    };
    wireCoachMattermostAccount(config, SLUG, mkMmUpdate());
    expect(config.channels.mattermost.accounts["sam-coach"]).toEqual({
      botToken: "tok-sam-preexisting",
    });
    expect(config.channels.mattermost.accounts[ACCOUNT_ID]).toEqual({
      botToken: "tok-ceckert-abc123",
      groupPolicy: "allowlist",
      groupAllowFrom: ["mm-ceckert", "mm-admin"],
    });
  });
});
