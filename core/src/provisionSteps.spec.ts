import { describe, expect, it } from "vitest";
import {
  buildRemoveCustomerConfig,
  buildRemoveCustomerPatch,
} from "./provisionSteps.js";

describe("buildRemoveCustomerPatch", () => {
  const current = {
    agents: {
      list: [
        { id: "octogee-alice-coach" },
        { id: "octogee-alice-proj-orbit-coach" },
        { id: "octogee-bob-coach" },
      ],
    },
    bindings: [
      { agentId: "octogee-alice-coach" },
      { agentId: "octogee-alice-proj-orbit-coach" },
      { agentId: "octogee-bob-coach" },
    ],
    channels: {
      mattermost: {
        accounts: {
          "alice-coach": { botToken: "x" },
          "alice-proj-orbit": { botToken: "y" },
          "bob-coach": { botToken: "z" },
          default: { botToken: "d" },
        },
      },
    },
  };

  it("builds a merge patch that removes bindings and accounts without replacing the redacted agent list", () => {
    const patch = buildRemoveCustomerPatch(current, "alice", "octogee-alice-coach");

    expect(patch).not.toHaveProperty("agents");
    expect(patch.bindings.map((b) => b.agentId)).toEqual(["octogee-bob-coach"]);
    expect(patch.channels.mattermost.accounts).toEqual({
      "alice-coach": null,
      "alice-proj-orbit": null,
    });
  });

  it("removes the customer's complete footprint from an unredacted full config without shifting sibling secrets", () => {
    const raw = {
      ...current,
      agents: {
        list: [
          {
            id: "octogee-alice-coach",
            memorySearch: { embedding: { apiKey: { source: "env", id: "ALICE_KEY" } } },
          },
          { id: "octogee-alice-proj-orbit-coach" },
          {
            id: "octogee-bob-coach",
            memorySearch: { embedding: { apiKey: { source: "env", id: "BOB_KEY" } } },
          },
        ],
      },
      untouched: { nested: ["keep", "all", "of", "this"] },
    };

    const config = buildRemoveCustomerConfig(raw, "alice", "octogee-alice-coach");

    expect(config.agents?.list).toEqual([
      {
        id: "octogee-bob-coach",
        memorySearch: { embedding: { apiKey: { source: "env", id: "BOB_KEY" } } },
      },
    ]);
    expect(config.bindings?.map((binding) => binding.agentId)).toEqual(["octogee-bob-coach"]);
    expect(config.channels?.mattermost?.accounts).toEqual({
      "bob-coach": { botToken: "z" },
      default: { botToken: "d" },
    });
    expect(config).toHaveProperty("untouched.nested", ["keep", "all", "of", "this"]);
    expect(raw.agents.list).toHaveLength(3);
    expect(raw.channels.mattermost.accounts).toHaveProperty("alice-coach");
  });

  it("does not null a hyphenated sibling's project accounts", () => {
    const patch = buildRemoveCustomerPatch(
      {
        bindings: [],
        channels: {
          mattermost: {
            accounts: { "alice-b-proj-x": { botToken: "s" }, "alice-proj-y": { botToken: "t" } },
          },
        },
      },
      "alice",
      "octogee-alice-coach",
    );
    expect(patch.channels.mattermost.accounts).toEqual({
      "alice-coach": null,
      "alice-proj-y": null,
    });
  });
});
