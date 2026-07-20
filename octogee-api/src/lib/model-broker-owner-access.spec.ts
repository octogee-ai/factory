import { describe, expect, it } from "vitest";
import { createModelBrokerOwnerAccessResolver } from "./model-broker-owner-access.js";

function fakeDb(seed: Record<string, Record<string, unknown>>) {
  return {
    collection: (collection: string) => ({
      doc: (id: string) => ({
        get: async () => ({
          exists: seed[`${collection}/${id}`] !== undefined,
          data: () => seed[`${collection}/${id}`],
        }),
      }),
    }),
  };
}

describe("createModelBrokerOwnerAccessResolver", () => {
  it("allows an active token owner", async () => {
    const resolve = createModelBrokerOwnerAccessResolver(fakeDb({
      "users/uid-1": { accountLifecycle: { status: "active" } },
    }));
    await expect(resolve({ gatewayId: "gw-1", ownerUid: "uid-1" })).resolves.toBe(true);
  });

  it.each(["suspended", "deletion_scheduled", "erasing"])(
    "denies a %s token owner",
    async (status) => {
      const resolve = createModelBrokerOwnerAccessResolver(fakeDb({
        "users/uid-1": { accountLifecycle: { status } },
      }));
      await expect(resolve({ gatewayId: "gw-1", ownerUid: "uid-1" })).resolves.toBe(false);
    },
  );

  it("resolves the owner from a single-tenant gateway when the token has no ownerUid", async () => {
    const resolve = createModelBrokerOwnerAccessResolver(fakeDb({
      "gateways/gw-1": { ownerUid: "uid-1" },
      "users/uid-1": { username: "alice" },
    }));
    await expect(resolve({ gatewayId: "gw-1", ownerUid: null })).resolves.toBe(true);
  });

  it("fails closed when either owner identity or user data is missing", async () => {
    const resolve = createModelBrokerOwnerAccessResolver(fakeDb({}));
    await expect(resolve({ gatewayId: "gw-1", ownerUid: null })).resolves.toBe(false);
  });
});
