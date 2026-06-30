import { describe, expect, it } from "vitest";
import { customerChannelMembers } from "./channel-members.js";

const ids = {
  customerMmUserId: "mm-customer",
  coachMmUserId: "mm-coach",
  adminMmUserId: "mm-admin",
};

describe("customerChannelMembers", () => {
  it("includes customer, coach, and admin for customer-facing channels", () => {
    expect(customerChannelMembers("coach", ids)).toEqual(["mm-customer", "mm-coach", "mm-admin"]);
    expect(customerChannelMembers("general", ids)).toEqual(["mm-customer", "mm-coach", "mm-admin"]);
    expect(customerChannelMembers("project", ids)).toEqual(["mm-customer", "mm-coach", "mm-admin"]);
  });

  it("keeps the admin channel scoped to admin plus coach", () => {
    expect(customerChannelMembers("admin", ids)).toEqual(["mm-admin", "mm-coach"]);
  });

  it("filters empty ids and ignores unrelated fields", () => {
    expect(
      customerChannelMembers("general", {
        customerMmUserId: "mm-customer",
        coachMmUserId: "",
        adminMmUserId: null,
        botMmUserId: "mm-bot",
      } as never),
    ).toEqual(["mm-customer"]);
  });
});
