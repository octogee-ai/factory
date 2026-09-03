import { describe, expect, it, vi } from "vitest";
import { createActivityMmClientFactory } from "../mm-client.js";

function post(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "post-1",
    channel_id: "channel-1",
    root_id: "root-1",
    create_at: 10,
    edit_at: 0,
    delete_at: 0,
    props: {},
    file_ids: [],
    ...overrides,
  };
}

function clientFor(value: Record<string, unknown>) {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
  return createActivityMmClientFactory({ baseUrl: "https://chat.example", fetchImpl })("token");
}

describe("Activity Mattermost post revisions", () => {
  it("normalizes validated create, edit, and delete timestamps", async () => {
    await expect(clientFor(post()).getPost("post-1")).resolves.toMatchObject({
      createAt: 10,
      editAt: 0,
      deleteAt: 0,
    });
  });

  it.each(["create_at", "edit_at", "delete_at"])(
    "rejects a malformed %s revision",
    async (field) => {
      await expect(clientFor(post({ [field]: "0" })).getPost("post-1"))
        .rejects.toThrow("MM getPost returned a malformed post");
    },
  );
});
