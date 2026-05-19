import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildCoachAgentEntry,
  buildCoachBindings,
  buildCoachAccountFragment,
  buildRemoveCustomerPatch,
  type ProvisioningContext,
} from "../lib/provisionSteps.js";

vi.mock("../lib/config.js", async () => {
  const actual: any = await vi.importActual("../lib/config.js");
  return { ...actual, log: vi.fn() };
});

const SLUG = "marie";
const AGENT_ID = `octogee-${SLUG}-coach`;
const ACCOUNT_ID = `${SLUG}-coach`;

function mkCtx(): ProvisioningContext {
  return {
    uid: "uid-marie",
    slug: SLUG,
    tier: "trial",
    ownerName: SLUG,
    customerDir: "/var/empty/customers/marie",
    today: "2026-04-16",
    username: SLUG,
    templateVars: {},
    userData: {},
  };
}

function mkMmUpdate(extra: Record<string, any> = {}): Record<string, any> {
  return {
    "mattermost.userId": "mm-marie",
    "mattermost.channelId": "ch-coach-dm",
    "mattermost.generalChannelId": "ch-general",
    "mattermost.adminChannelId": "ch-admin",
    _coachPersonalToken: "tok-marie",
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

describe("buildCoachAgentEntry", () => {
  it("produces an agent entry keyed by octogee-{slug}-coach", () => {
    const entry = buildCoachAgentEntry(mkCtx()) as Record<string, unknown>;
    expect(entry.id).toBe(AGENT_ID);
    expect(entry.workspace).toBe("/var/empty/customers/marie");
    expect((entry.identity as any).name).toBeTruthy();
    expect((entry.tools as any).fs.workspaceOnly).toBe(true);
  });

  it("is pure — repeated calls on the same ctx produce equal output", () => {
    const a = buildCoachAgentEntry(mkCtx());
    const b = buildCoachAgentEntry(mkCtx());
    expect(a).toEqual(b);
  });
});

describe("buildCoachBindings", () => {
  it("emits one binding per channel with accountId pinned to {slug}-coach", () => {
    const bindings = buildCoachBindings({ bindings: [] }, AGENT_ID, SLUG, mkMmUpdate());
    expect(bindings).toHaveLength(3);
    for (const b of bindings) {
      expect(b.agentId).toBe(AGENT_ID);
      expect(b.match.channel).toBe("mattermost");
      expect(b.match.accountId).toBe(ACCOUNT_ID);
      expect(b.match.peer.kind).toBe("group");
    }
  });

  it("preserves bindings for other agents", () => {
    const existing = {
      bindings: [
        { agentId: "octogee-other-coach", match: { channel: "mattermost", accountId: "other-coach", peer: { kind: "group", id: "other-ch" } } },
      ],
    };
    const bindings = buildCoachBindings(existing, AGENT_ID, SLUG, mkMmUpdate());
    const otherAgentEntries = bindings.filter((b: any) => b.agentId === "octogee-other-coach");
    expect(otherAgentEntries).toHaveLength(1);
    expect(existing.bindings).toHaveLength(1);
  });

  it("REPLACES a pre-existing binding that matches on (agentId, peer.id)", () => {
    const existing = {
      bindings: [
        { agentId: AGENT_ID, match: { channel: "mattermost", peer: { kind: "group", id: "ch-coach-dm" } } },
      ],
    };
    const bindings = buildCoachBindings(existing, AGENT_ID, SLUG, mkMmUpdate());
    const coachDmBindings = bindings.filter((b: any) => b.agentId === AGENT_ID && b.match?.peer?.id === "ch-coach-dm");
    expect(coachDmBindings).toHaveLength(1);
    expect(coachDmBindings[0].match.accountId).toBe(ACCOUNT_ID);
  });

  it("does not mutate the `current` snapshot", () => {
    const existing = { bindings: [] };
    buildCoachBindings(existing, AGENT_ID, SLUG, mkMmUpdate());
    expect(existing.bindings).toEqual([]);
  });
});

describe("buildCoachAccountFragment", () => {
  it("returns the account entry keyed by {slug}-coach with allowlist scoped to owner + admin", () => {
    const frag = buildCoachAccountFragment(SLUG, mkMmUpdate());
    expect(frag.accounts[ACCOUNT_ID]).toEqual({
      botToken: "tok-marie",
      groupPolicy: "allowlist",
      groupAllowFrom: ["mm-marie", "mm-admin"],
    });
    expect(frag.defaultAccount).toBe("default");
  });

  it("omits the account entry when no coach PAT is available", () => {
    const frag = buildCoachAccountFragment(SLUG, mkMmUpdate({ _coachPersonalToken: "" }));
    expect(frag.accounts).toEqual({});
    expect(frag.defaultAccount).toBe("default");
  });

  it("omits the account entry when the allowlist would be empty (no owner + no admin)", () => {
    delete process.env.MM_ADMIN_USER_ID;
    const frag = buildCoachAccountFragment(SLUG, mkMmUpdate({ "mattermost.userId": "" }));
    expect(frag.accounts).toEqual({});
  });
});

describe("buildRemoveCustomerPatch", () => {
  const SIBLING_AGENT = "octogee-zoe-coach";
  const SIBLING_ACCOUNT = "zoe-coach";

  function mkCurrent(): Record<string, any> {
    return {
      agents: {
        list: [
          { id: AGENT_ID, model: "anthropic/claude-sonnet-4-6" },
          { id: SIBLING_AGENT, model: "anthropic/claude-sonnet-4-6" },
        ],
      },
      bindings: [
        { agentId: AGENT_ID, match: { peer: { id: "ch-coach-dm" } } },
        { agentId: SIBLING_AGENT, match: { peer: { id: "ch-zoe-dm" } } },
      ],
      channels: {
        mattermost: {
          accounts: {
            [ACCOUNT_ID]: { botToken: "tok-marie", allowlist: ["mm-marie"] },
            [SIBLING_ACCOUNT]: { botToken: "tok-zoe", allowlist: ["mm-zoe"] },
          },
        },
      },
    };
  }

  it("deletes the coach MM account via an explicit null sentinel (merge-patch deletion)", () => {
    const patch = buildRemoveCustomerPatch(mkCurrent(), SLUG, AGENT_ID) as any;
    const accounts = patch.channels.mattermost.accounts;
    // RFC7386 merge-patch: only an explicit `null` deletes a key. An
    // omitted key is "leave unchanged" — that omission is the BenderEcho
    // zombie bug (account stayed connected to MM after unmount).
    expect(Object.prototype.hasOwnProperty.call(accounts, ACCOUNT_ID)).toBe(true);
    expect(accounts[ACCOUNT_ID]).toBeNull();
  });

  it("does NOT touch sibling accounts (no null, not even present in the fragment)", () => {
    const patch = buildRemoveCustomerPatch(mkCurrent(), SLUG, AGENT_ID) as any;
    // Siblings must be absent from the patch so merge-patch leaves them
    // intact; nulling or re-sending them would either delete or churn
    // other tenants' accounts.
    expect(Object.keys(patch.channels.mattermost.accounts)).toEqual([ACCOUNT_ID]);
  });

  it("ships bindings as the filtered wholesale array (no id → array-replace), preserving siblings", () => {
    const patch = buildRemoveCustomerPatch(mkCurrent(), SLUG, AGENT_ID) as any;
    expect(patch.bindings).toEqual([
      { agentId: SIBLING_AGENT, match: { peer: { id: "ch-zoe-dm" } } },
    ]);
  });

  it("does not emit agents.list — a filtered list is a no-op under mergeObjectArraysById", () => {
    const patch = buildRemoveCustomerPatch(mkCurrent(), SLUG, AGENT_ID) as any;
    expect(patch.agents).toBeUndefined();
  });

  it("is pure — does not mutate `current`", () => {
    const current = mkCurrent();
    buildRemoveCustomerPatch(current, SLUG, AGENT_ID);
    expect(current.bindings).toHaveLength(2);
    expect(Object.keys(current.channels.mattermost.accounts)).toEqual([
      ACCOUNT_ID,
      SIBLING_ACCOUNT,
    ]);
  });

  it("tolerates a sparse `current` (no bindings / no accounts)", () => {
    const patch = buildRemoveCustomerPatch({}, SLUG, AGENT_ID) as any;
    expect(patch.bindings).toEqual([]);
    expect(patch.channels.mattermost.accounts[ACCOUNT_ID]).toBeNull();
  });
});
