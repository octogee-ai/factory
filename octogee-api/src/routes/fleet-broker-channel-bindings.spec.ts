import { describe, expect, it } from "vitest";

import { collectChannelBindings } from "./fleet-broker.js";

function channel(id: string, channelId: string) {
  return { id, data: () => ({ kind: id, mattermost: { channelId } }) };
}

describe("collectChannelBindings", () => {
  it("uses each primary project channel once for fleet membership even when legacy aliases are stored", async () => {
    const workspaceChannels = [channel("general", "workspace-primary")];
    const projectChannels = [
      {
        ...channel("general", "project-primary"),
        data: () => ({
          kind: "general",
          mattermost: { channelId: "project-primary", activityChannelId: "legacy-sibling" },
        }),
      },
    ];
    const db = {
      collection: () => ({
        doc: () => ({
          collection: (name: string) => ({
            get: async () => name === "channels"
              ? { docs: workspaceChannels }
              : {
                  docs: [{
                    id: "orbit",
                    ref: { collection: () => ({ get: async () => ({ docs: projectChannels }) }) },
                  }],
                },
          }),
        }),
      }),
    } as never;

    await expect(collectChannelBindings(db, "alice")).resolves.toEqual({
      bindings: [
        { scope: "workspace", kind: "general", channelId: "workspace-primary" },
        { scope: "project", projectId: "orbit", kind: "general", channelId: "project-primary" },
      ],
      projectMemberships: [{ projectId: "orbit", channelIds: ["project-primary"] }],
    });
  });
});
