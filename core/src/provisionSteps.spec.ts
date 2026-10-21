import { describe, expect, it } from "vitest";
import { FieldValue } from "firebase-admin/firestore";
import {
  buildCoachAgentDoc,
  buildProvisioningContext,
  buildRemoveCustomerConfig,
  buildUserOperationalFields,
} from "./provisionSteps.js";

describe("buildUserOperationalFields", () => {
  it("binds the provisioned user to the workspace used by agent tools", () => {
    const ctx = buildProvisioningContext("uid-1", {
      username: "octogeedemo",
      tier: "trial",
    });

    expect(
      buildUserOperationalFields(
        ctx,
        { status: "complete", slug: "octogeedemo", agentIds: ["octogee-octogeedemo-coach"] },
        { "mattermost.teamId": "team-1" },
      ),
    ).not.toHaveProperty("provisioning.openclaw.status");

    expect(
      buildUserOperationalFields(
        ctx,
        { status: "complete", slug: "octogeedemo", agentIds: ["octogee-octogeedemo-coach"] },
        { "mattermost.teamId": "team-1" },
      ),
    ).toMatchObject({
      workspaceId: "octogeedemo",
      tier: "trial",
      "provisioning.openclaw.slug": "octogeedemo",
      "mattermost.teamId": "team-1",
    });
  });
});

describe("buildRemoveCustomerConfig", () => {
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

  it("does not remove a hyphenated sibling's project accounts", () => {
    const config = buildRemoveCustomerConfig(
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
    expect(config.channels?.mattermost?.accounts).toEqual({
      "alice-b-proj-x": { botToken: "s" },
    });
  });
});

describe("buildCoachAgentDoc", () => {
  it("gives every new coach the Octo identity with the coral Octo look", () => {
    const doc = buildCoachAgentDoc("uid-1", "mm-coach-1");
    expect(doc).toMatchObject({
      id: "uid-1",
      name: "Octo",
      persona: "",
      avatarEmoji: "🐙",
      look: { style: "octo", color: "#e74e3c" },
      mattermost: { userId: "mm-coach-1" },
    });
    expect(doc.createdAt).toEqual(FieldValue.serverTimestamp());
    expect(doc.updatedAt).toEqual(FieldValue.serverTimestamp());
  });
});
