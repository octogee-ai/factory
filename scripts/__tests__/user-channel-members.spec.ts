import { describe, it, expect } from "vitest";
import { userChannelMembers } from "../lib/mattermost.js";

const IDS = {
  customerMmUserId: "u-user",
  defaultAgentMmUserId: "u-coach",
  adminMmUserId: "u-admin",
};

describe("userChannelMembers", () => {
  it("coach channel: user + coach + admin (never bot)", () => {
    expect(userChannelMembers("coach", IDS)).toEqual([
      "u-user",
      "u-coach",
      "u-admin",
    ]);
  });

  it("general channel: user + defaultAgent + admin (never bot)", () => {
    expect(userChannelMembers("general", IDS)).toEqual([
      "u-user",
      "u-coach",
      "u-admin",
    ]);
  });

  it("project channel: user + defaultAgent + admin (never bot)", () => {
    expect(userChannelMembers("project", IDS)).toEqual([
      "u-user",
      "u-coach",
      "u-admin",
    ]);
  });

  it("admin channel: admin + agent — user is NOT invited (#170)", () => {
    const members = userChannelMembers("admin", IDS);
    expect(members).toEqual(["u-admin", "u-coach"]);
    expect(members).not.toContain("u-user");
  });

  it("filters out null / empty ids cleanly", () => {
    expect(
      userChannelMembers("general", {
        customerMmUserId: "u-user",
        defaultAgentMmUserId: null,
        adminMmUserId: "",
      }),
    ).toEqual(["u-user"]);
  });

it.each([
    ["coach"],
    ["general"],
    ["project"],
    ["admin"],
  ] as const)(
    "%s: output never contains a bot-shaped id (multi-account invariant)",
    (kind) => {
      const members = userChannelMembers(kind, {
        ...IDS,
        // @ts-expect-error — any stray `botMmUserId` MUST be ignored by the

botMmUserId: "u-bot-should-not-appear",
      });
      expect(members).not.toContain("u-bot-should-not-appear");
    },
  );
});
