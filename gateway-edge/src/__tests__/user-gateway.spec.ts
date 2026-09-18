import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  users: new Map<string, Record<string, unknown> | null>(),
}));

vi.mock("../lib/db.js", () => ({
  db: {
    collection: (name: string) => {
      if (name !== "users") throw new Error(`unexpected collection ${name}`);
      return {
        doc: (uid: string) => ({
          get: async () => {
            const data = h.users.get(uid);
            return {
              exists: data !== undefined && data !== null,
              data: () => data,
            };
          },
        }),
      };
    },
  },
}));

const { resolveUserGateway } = await import("../lib/user-gateway.js");

describe("resolveUserGateway", () => {
  beforeEach(() => {
    h.users.clear();
  });

  it("returns null for missing users or users without an assigned gateway", async () => {
    h.users.set("no-gateway", { username: "mira", provisioning: { openclaw: {} } });

    await expect(resolveUserGateway("missing")).resolves.toBeNull();
    await expect(resolveUserGateway("no-gateway")).resolves.toBeNull();
  });

  it("returns the primary workspace slug and assigned gateway id", async () => {
    h.users.set("u-1", {
      username: "fallback",
      provisioning: { openclaw: { slug: "mira", gatewayId: "gw-1" } },
    });

    await expect(resolveUserGateway("u-1")).resolves.toEqual({
      slug: "mira",
      gatewayId: "gw-1",
      agentIds: ["octogee-mira-coach"],
    });
  });

  it("rosters the coach first plus this workspace's own safe agent ids", async () => {
    h.users.set("u-2", {
      provisioning: {
        openclaw: {
          slug: "mira",
          gatewayId: "gw-1",
          agentIds: [
            "octogee-mira-proj-golf-coach",
            "octogee-mira-coach",
            "octogee-other-coach",
            "octogee-mira-../etc",
            42,
          ],
        },
      },
    });

    await expect(resolveUserGateway("u-2")).resolves.toMatchObject({
      agentIds: ["octogee-mira-coach", "octogee-mira-proj-golf-coach"],
    });
  });
});
