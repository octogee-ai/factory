import { describe, it, expect, vi } from "vitest";
import {
  wireDefaultAgentMattermostBindings,
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

describe("wireDefaultAgentMattermostBindings", () => {
  it("writes bindings only for the user-facing agent and General channels", () => {
    const config: any = { bindings: [] };
    wireDefaultAgentMattermostBindings(config, AGENT_ID, SLUG, mkMmUpdate());
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
    wireDefaultAgentMattermostBindings(config, AGENT_ID, SLUG, mkMmUpdate());
    expect(config.bindings).toHaveLength(2);
    for (const b of config.bindings) {
      expect(b.match.accountId).toBe(ACCOUNT_ID);
    }
  });

  it("is idempotent on re-provision (same binding written twice yields one entry per channel)", () => {
    const config: any = { bindings: [] };
    wireDefaultAgentMattermostBindings(config, AGENT_ID, SLUG, mkMmUpdate());
    wireDefaultAgentMattermostBindings(config, AGENT_ID, SLUG, mkMmUpdate());
    expect(config.bindings).toHaveLength(2);
  });

  it("skips channels whose id is missing from mmUpdate", () => {
    const config: any = { bindings: [] };
    wireDefaultAgentMattermostBindings(config, AGENT_ID, SLUG, {
      "mattermost.channelId": "ch-coach-dm",
    });
    expect(config.bindings).toHaveLength(1);
    expect(config.bindings[0].match.peer.id).toBe("ch-coach-dm");
  });
});
