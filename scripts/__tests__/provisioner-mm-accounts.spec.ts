/**
 * Unit tests for the provisioner-side multi-account MM wiring.
 *
 * Boot-sync (`scripts/boot-sync.ts`) rebuilds `channels.mattermost.accounts`
 * + `bindings[].match.accountId` from Firestore on every gateway restart —
 * but that path only runs when at least one customer is already assigned to
 * the gateway at boot. A fresh signup happens AFTER the gateway is up, and
 * the provisioner (`scripts/lib/provisionSteps.ts`) writes openclaw.json
 * incrementally from inside the running process. Without a parallel multi-
 * account code path here, a freshly-provisioned customer ends up with the
 * old single-token shape and their `{slug}-coach` WS never connects (coach
 * stays offline, silent in every channel) — observed in #560 testing.
 *
 * Two helpers are tested:
 *   - `wireCoachMattermostBindings(config, agentId, slug, mmUpdate)` —
 *     now writes `match.accountId: "{slug}-coach"` on every binding and
 *     REPLACES any legacy accountId-less binding in place.
 *   - `wireCoachMattermostAccount(config, slug, mmUpdate)` — upserts
 *     `channels.mattermost.accounts.{slug}-coach.botToken` from the
 *     ephemeral `mmUpdate._coachPersonalToken`, ensures the `admin`
 *     account + `defaultAccount` are present, and SKIPS when no PAT is
 *     available (never writes a null/empty botToken).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  wireCoachMattermostBindings,
  wireCoachMattermostAccount,
} from "../lib/provisionSteps.js";

// `log` in provisionSteps comes from scripts/lib/config.ts and goes to
// stderr. Silence it in tests.
vi.mock("../lib/config.js", async () => {
  const actual: any = await vi.importActual("../lib/config.js");
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

// ── wireCoachMattermostBindings ─────────────────────────────────────────────

describe("wireCoachMattermostBindings", () => {
  it("writes one binding per channel with accountId pinned to {slug}-coach", () => {
    const config: any = { bindings: [] };
    wireCoachMattermostBindings(config, AGENT_ID, SLUG, mkMmUpdate());
    expect(config.bindings).toHaveLength(3);
    for (const b of config.bindings) {
      expect(b.agentId).toBe(AGENT_ID);
      expect(b.match.channel).toBe("mattermost");
      expect(b.match.accountId).toBe(ACCOUNT_ID);
      expect(b.match.peer.kind).toBe("group");
    }
    const channelIds = config.bindings.map((b: any) => b.match.peer.id).sort();
    expect(channelIds).toEqual(["ch-admin", "ch-coach-dm", "ch-general"]);
  });

  // Regression guard for the production bug observed in #560: a legacy
  // binding written by the pre-multi-account provisioner (no accountId) was
  // preserved by the old `some(...)` dedup check, leaving a stale
  // accountId-less binding in place. Events then resolved on the admin WS
  // and bypassed tenant isolation. The fix switches to `findIndex` + replace.
  it("REPLACES a legacy accountId-less binding in place (does not leave stale entries)", () => {
    const config: any = {
      bindings: [
        {
          agentId: AGENT_ID,
          match: {
            channel: "mattermost",
            peer: { kind: "group", id: "ch-coach-dm" },
            // no accountId — legacy shape
          },
        },
      ],
    };
    wireCoachMattermostBindings(config, AGENT_ID, SLUG, mkMmUpdate());
    // 3 total (1 replaced + 2 new), NOT 4 (which would mean the legacy
    // accountId-less binding was left alongside the new one).
    expect(config.bindings).toHaveLength(3);
    for (const b of config.bindings) {
      expect(b.match.accountId).toBe(ACCOUNT_ID);
    }
  });

  it("is idempotent on re-provision (same binding written twice yields one entry per channel)", () => {
    const config: any = { bindings: [] };
    wireCoachMattermostBindings(config, AGENT_ID, SLUG, mkMmUpdate());
    wireCoachMattermostBindings(config, AGENT_ID, SLUG, mkMmUpdate());
    expect(config.bindings).toHaveLength(3);
  });

  it("skips channels whose id is missing from mmUpdate", () => {
    const config: any = { bindings: [] };
    wireCoachMattermostBindings(config, AGENT_ID, SLUG, {
      "mattermost.channelId": "ch-coach-dm",
      // general + admin missing (early short-circuit path)
    });
    expect(config.bindings).toHaveLength(1);
    expect(config.bindings[0].match.peer.id).toBe("ch-coach-dm");
  });
});

// ── wireCoachMattermostAccount ──────────────────────────────────────────────

describe("wireCoachMattermostAccount", () => {
  let logSpy: ReturnType<typeof vi.fn>;
  beforeEach(async () => {
    const cfgMod: any = await import("../lib/config.js");
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

  it("ensures admin account + defaultAccount are present (self-bootstraps a legacy config)", () => {
    const config: any = {
      channels: {
        mattermost: {
          // legacy single-token shape — NO accounts map, NO defaultAccount
          botToken: "legacy-top-level-token",
          baseUrl: "http://mm.svc.cluster.local:8065",
          chatmode: "onmessage",
        },
      },
    };
    wireCoachMattermostAccount(config, SLUG, mkMmUpdate());
    expect(config.channels.mattermost.accounts.admin).toEqual({
      botToken: "${MM_BOT_TOKEN}",
    });
    expect(config.channels.mattermost.defaultAccount).toBe("admin");
    // Legacy siblings preserved (the MM plugin still reads them as fallback
    // defaults until OpenClaw is upgraded everywhere) — upsert MUST NOT
    // strip them mid-flight.
    expect(config.channels.mattermost.botToken).toBe("legacy-top-level-token");
    expect(config.channels.mattermost.baseUrl).toBe(
      "http://mm.svc.cluster.local:8065",
    );
    expect(config.channels.mattermost.chatmode).toBe("onmessage");
  });

  it("preserves an existing admin account entry + defaultAccount", () => {
    const config: any = {
      channels: {
        mattermost: {
          accounts: { admin: { botToken: "${MM_BOT_TOKEN}" } },
          defaultAccount: "admin",
        },
      },
    };
    wireCoachMattermostAccount(config, SLUG, mkMmUpdate());
    expect(config.channels.mattermost.accounts.admin).toEqual({
      botToken: "${MM_BOT_TOKEN}",
    });
    expect(config.channels.mattermost.defaultAccount).toBe("admin");
    expect(config.channels.mattermost.accounts[ACCOUNT_ID]).toEqual({
      botToken: "tok-ceckert-abc123",
      groupPolicy: "allowlist",
      groupAllowFrom: ["mm-ceckert", "mm-admin"],
    });
  });

  // Critical invariant: a missing PAT MUST NOT produce
  // `{ botToken: "" }` or `{ botToken: undefined }` — OpenClaw rejects the
  // plugin config on load and the gateway comes up with ZERO MM channels
  // wired, bricking every tenant. Silent skip + warning is safer.
  it("SKIPS the accounts upsert when _coachPersonalToken is missing", () => {
    const config: any = {};
    wireCoachMattermostAccount(
      config,
      SLUG,
      mkMmUpdate({ _coachPersonalToken: undefined }),
    );
    expect(config.channels.mattermost.accounts[ACCOUNT_ID]).toBeUndefined();
    // Admin entry still ensured so the gateway boots with a valid config.
    expect(config.channels.mattermost.accounts.admin).toBeDefined();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining(SLUG),
    );
  });

  it("SKIPS the accounts upsert when _coachPersonalToken is an empty string", () => {
    const config: any = {};
    wireCoachMattermostAccount(config, SLUG, mkMmUpdate({ _coachPersonalToken: "" }));
    expect(config.channels.mattermost.accounts[ACCOUNT_ID]).toBeUndefined();
    expect(config.channels.mattermost.accounts.admin).toBeDefined();
  });

  it("per-customer account upsert is scoped by slug — no cross-tenant clobber", () => {
    const config: any = {
      channels: {
        mattermost: {
          accounts: {
            admin: { botToken: "${MM_BOT_TOKEN}" },
            "sam-coach": { botToken: "tok-sam-preexisting" },
          },
        },
      },
    };
    wireCoachMattermostAccount(config, SLUG, mkMmUpdate()); // ceckert
    expect(config.channels.mattermost.accounts["sam-coach"]).toEqual({
      botToken: "tok-sam-preexisting",
    } as any);
    expect(config.channels.mattermost.accounts[ACCOUNT_ID]).toEqual({
      botToken: "tok-ceckert-abc123",
      groupPolicy: "allowlist",
      groupAllowFrom: ["mm-ceckert", "mm-admin"],
    });
  });
});
