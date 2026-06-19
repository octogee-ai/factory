import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  workspaceCoachChannelName,
  workspaceGeneralChannelName,
  workspaceAdminChannelName,
} from "../../shared/types/identity.js";

const h = vi.hoisted(() => {
  let docs: Record<string, unknown> = {};
  const setSpy = vi.fn(async () => {});
  const docRef = (p: string) => ({
    get: async () => ({ exists: docs[p] !== undefined, data: () => docs[p] }),
    set: setSpy,
    collection: (sub: string) => collRef(`${p}/${sub}`),
  });
  const collRef = (p: string) => ({ doc: (id: string) => docRef(`${p}/${id}`) });
  return {
    db: { collection: (n: string) => collRef(n), doc: (p: string) => docRef(p) },
    setSpy,
    setDocs: (d: Record<string, unknown>) => {
      docs = d;
    },
    mmApiCall: vi.fn(),
    mintAndPersistCoachToken: vi.fn(),
    createOrRestoreChannel: vi.fn(),
    mmUploadAvatar: vi.fn(),
  };
});

vi.mock("../lib/firebase.js", () => ({ db: h.db }));
vi.mock("../lib/mattermost/client.js", () => ({
  mmApiCall: h.mmApiCall,
  assertMattermostConfigured: vi.fn(),
}));
vi.mock("../lib/mattermost/coach-pat.js", () => ({
  mintAndPersistCoachToken: h.mintAndPersistCoachToken,
}));
vi.mock("../lib/mattermost/channels.js", () => ({
  createOrRestoreChannel: h.createOrRestoreChannel,
}));
vi.mock("../lib/mattermost/community.js", () => ({ communityChannelIds: [] }));
vi.mock("../lib/mattermost/avatars.js", () => ({ mmUploadAvatar: h.mmUploadAvatar }));

import { provisionMattermostUser } from "../lib/mattermost/provision.js";

interface ProvisionInput {
  uid: string;
  slug: string;
  firstName: string;
  email: string;
  vibe?: string | null;
  lastName?: string;
  photoURL?: string;
}

const call = (i: ProvisionInput) => provisionMattermostUser(i);

const HAPPY: ProvisionInput = {
  uid: "u1",
  slug: "acme",
  firstName: "Ada",
  email: "ada@example.com",
  vibe: "builder",
  lastName: "Lovelace",
  photoURL: "",
};

const seq = () => h.mmApiCall.mock.calls.map(([m, e]: [string, string]) => `${m} ${e}`);

beforeEach(() => {
  vi.clearAllMocks();
  h.setDocs({ "users/u1": {} });
  h.mmApiCall.mockImplementation(async (method: string, endpoint: string) => {
    if (method === "POST" && endpoint === "/users") return { id: "builder-1", delete_at: 0 };
    if (method === "POST" && endpoint === "/teams") return { id: "team-1" };
    if (method === "POST" && endpoint === "/bots") return { user_id: "coach-1" };
    if (method === "POST" && endpoint === "/users/builder-1/tokens") return { token: "builder-token" };
    if (method === "GET" && endpoint.includes("/channels/name/")) return null;
    return {};
  });
  h.createOrRestoreChannel.mockImplementation(async (_teamId: string, name: string) => ({ id: `ch:${name}` }));
  h.mintAndPersistCoachToken.mockResolvedValue({ token: "coach-pat" });
  h.mmUploadAvatar.mockResolvedValue(true);
});

describe("provisionMattermostUser — new builder (happy path)", () => {
  it("creates builder, team, coach bot and returns the mattermost update map", async () => {
    const result = await call(HAPPY);

    expect(result["mattermost.userId"]).toBe("builder-1");
    expect(result["mattermost.username"]).toBe("acme");
    expect(result["mattermost.teamId"]).toBe("team-1");
    expect(result["mattermost.coachUserId"]).toBe("coach-1");
    expect(result["_coachPersonalToken"]).toBe("coach-pat");
    expect(result["mattermost.channelId"]).toBe(`ch:${workspaceCoachChannelName("acme")}`);
    expect(result["mattermost.dmChannelId"]).toBe(`ch:${workspaceCoachChannelName("acme")}`);
    expect(result["mattermost.generalChannelId"]).toBe(`ch:${workspaceGeneralChannelName("acme")}`);
    expect(result["mattermost.adminChannelId"]).toBe(`ch:${workspaceAdminChannelName("acme")}`);
  });

  it("creates the builder MM user with the least-privilege system_user role", async () => {
    await call(HAPPY);
    const userCreate = h.mmApiCall.mock.calls.find(
      ([m, e]: [string, string]) => m === "POST" && e === "/users",
    );
    expect(userCreate?.[2]).toMatchObject({ username: "acme", roles: "system_user" });
  });

  it("creates the coach as a bot (POST /bots) and mints+persists its PAT", async () => {
    await call(HAPPY);
    expect(seq()).toContain("POST /bots");
    expect(seq()).toContain("POST /teams");
    expect(h.mintAndPersistCoachToken).toHaveBeenCalledWith(expect.anything(), "u1", "coach-1");
  });

  it("persists the builder personal token to the user's mattermost secret", async () => {
    await call(HAPPY);
    expect(h.setSpy).toHaveBeenCalledWith(
      expect.objectContaining({ personalToken: "builder-token" }),
    );
  });
});

describe("provisionMattermostUser — already provisioned (idempotent backfill)", () => {
  beforeEach(() => {
    h.setDocs({
      "users/u1": { mattermost: { userId: "existing-builder", username: "acme" } },
      "workspaces/acme/channels/coach-dm": { mattermost: { channelId: "existing-ch" } },
      "users/u1/secrets/coachMattermost": { personalToken: "existing-coach-pat" },
    });
  });

  it("returns the existing identifiers without creating a new user or team", async () => {
    const result = await call(HAPPY);
    expect(result["mattermost.userId"]).toBe("existing-builder");
    expect(result["mattermost.channelId"]).toBe("existing-ch");
    expect(result["_coachPersonalToken"]).toBe("existing-coach-pat");
    expect(seq()).not.toContain("POST /users");
    expect(seq()).not.toContain("POST /teams");
  });
});

describe("provisionMattermostUser — degraded paths", () => {
  it("reactivates and re-patches a soft-deleted user found by email", async () => {
    h.mmApiCall.mockImplementation(async (method: string, endpoint: string) => {
      if (method === "POST" && endpoint === "/users") return null; // create conflicts
      if (method === "GET" && endpoint.startsWith("/users/username/")) return null; // username miss
      if (method === "GET" && endpoint.startsWith("/users/email/")) return { id: "builder-existing", delete_at: 5 };
      if (method === "POST" && endpoint === "/teams") return { id: "team-1" };
      if (method === "POST" && endpoint === "/bots") return { user_id: "coach-1" };
      if (method === "POST" && endpoint === "/users/builder-existing/tokens") return { token: "tok" };
      if (method === "GET" && endpoint.includes("/channels/name/")) return null;
      return {};
    });

    const result = await call(HAPPY);

    expect(result["mattermost.userId"]).toBe("builder-existing");
    expect(seq()).toContain("PUT /users/builder-existing/active");
    expect(seq()).toContain("PUT /users/builder-existing/patch");
  });

  it("keeps coachUserId but omits the coach token when the PAT mint fails", async () => {
    h.mintAndPersistCoachToken.mockResolvedValue(null);

    const result = await call(HAPPY);

    expect(result["mattermost.coachUserId"]).toBe("coach-1");
    expect(result).not.toHaveProperty("_coachPersonalToken");
  });
});
