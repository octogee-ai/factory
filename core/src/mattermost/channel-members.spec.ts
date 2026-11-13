import { describe, expect, it } from "vitest";
import { userChannelMembers } from "./channel-members.js";

const ids = {
  customerMmUserId: "mm-user",
  defaultAgentMmUserId: "mm-coach",
  adminMmUserId: "mm-admin",
};

describe("userChannelMembers", () => {
  it("includes user, defaultAgent, and admin for user-facing channels", () => {
    expect(userChannelMembers("coach", ids)).toEqual(["mm-user", "mm-coach", "mm-admin"]);
    expect(userChannelMembers("general", ids)).toEqual(["mm-user", "mm-coach", "mm-admin"]);
    expect(userChannelMembers("project", ids)).toEqual(["mm-user", "mm-coach", "mm-admin"]);
  });

  it("keeps the admin channel scoped to admin plus agent", () => {
    expect(userChannelMembers("admin", ids)).toEqual(["mm-admin", "mm-coach"]);
  });

  it("filters empty ids and ignores unrelated fields", () => {
    expect(
      userChannelMembers("general", {
        customerMmUserId: "mm-user",
        defaultAgentMmUserId: "",
        adminMmUserId: null,
        botMmUserId: "mm-bot",
      } as never),
    ).toEqual(["mm-user"]);
  });
});
