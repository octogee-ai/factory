import { describe, expect, it } from "vitest";
import { buildRemoveCustomerPatch } from "./provisionSteps.js";

describe("buildRemoveCustomerPatch", () => {
  const current = {
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

  it("removes the customer's coach AND project-agent bindings and nulls all their accounts", () => {
    const patch = buildRemoveCustomerPatch(current, "alice", "octogee-alice-coach");

    expect(patch.bindings.map((b) => b.agentId)).toEqual(["octogee-bob-coach"]);
    expect(patch.channels.mattermost.accounts).toEqual({
      "alice-coach": null,
      "alice-proj-orbit": null,
    });
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
