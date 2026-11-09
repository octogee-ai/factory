import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  workspaceCoachChannelName,
  workspaceGeneralChannelName,
} from "@octogee/shared/types/identity";

const h = vi.hoisted(() => {
  let docs: Record<string, unknown> = {};
  const setSpy = vi.fn(async () => {});
  const docRef = (p: string) => ({
    get: async () => ({ exists: docs[p] !== undefined, data: () => docs[p] }),
    set: setSpy,
    collection: (sub: string) => collRef(`${p}/${sub}`),
  });
  const collRef = (p: string) => ({ doc: (id: string) => docRef(`${p}/${id}`) });
  const mattermostOf = (path: string) => (docs[path] as { mattermost?: Record<string, string> } | undefined)?.mattermost;
  const secretPut = vi.fn(async () => {});
  const store = {
    builders: {
      records: {
        get: async (uid: string) =>
          docs[`users/${uid}`] ? { mattermostUserId: mattermostOf(`users/${uid}`)?.userId ?? null } : null,
      },
    },
    secrets: {
      get: async (uid: string, secretId: string) => {
        const secret = docs[`users/${uid}/secrets/${secretId}`] as { personalToken: string } | undefined;
        return secret ? { kind: "coach-mattermost", secretId, ...secret } : null;
      },
      put: secretPut,
    },
    workspaces: {
      records: {
        get: async (slug: string) =>
          docs[`workspaces/${slug}`] ? { mattermostTeamId: mattermostOf(`workspaces/${slug}`)?.teamId ?? null } : null,
      },
      channels: {
        get: async (scope: { workspaceSlug: string }, channelId: string) => {
          const path = `workspaces/${scope.workspaceSlug}/channels/${channelId}`;
          return docs[path] ? { mattermostChannelId: mattermostOf(path)?.channelId ?? null } : null;
        },
      },
      agentIdentities: {
        get: async (uid: string) =>
          docs[`agents/${uid}`] ? { mattermostUserId: mattermostOf(`agents/${uid}`)?.userId ?? null } : null,
      },
    },
  };
  return {
    db: { collection: (n: string) => collRef(n), doc: (p: string) => docRef(p) },
    store,
    secretPut,
    setSpy,
    setDocs: (d: Record<string, unknown>) => {
      docs = d;
    },
    mmApiCall: vi.fn(),
    mintAndPersistCoachToken: vi.fn(),
    mmUploadAvatar: vi.fn(),
  };
});

vi.mock("../firebase.js", () => ({ db: h.db, platformStateStore: h.store }));
vi.mock("../mattermost/coach-pat.js", () => ({
  mintAndPersistCoachToken: h.mintAndPersistCoachToken,
}));
vi.mock("../mattermost/avatars.js", () => ({ mmUploadAvatar: h.mmUploadAvatar }));

import { createMattermostChannelHost } from "../channel-host/mattermost.js";
import { provisionMattermostUser } from "../mattermost/provision.js";

const host = createMattermostChannelHost({
  baseUrl: "http://mm.test",
  adminToken: "admin",
  fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
    const endpoint = String(input).replace("http://mm.test/api/v4", "");
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const result = await h.mmApiCall(init?.method ?? "GET", endpoint, body);
    return result === null || result === undefined
      ? new Response("", { status: 404 })
      : new Response(JSON.stringify(result), { status: 200 });
  }) as typeof fetch,
});

interface ProvisionInput {
  uid: string;
  slug: string;
  firstName: string;
  email: string;
  vibe?: string | null;
  lastName?: string;
  photoURL?: string;
}

const call = (i: ProvisionInput) => provisionMattermostUser(i, host);

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
const createdChannelNames = () =>
  h.mmApiCall.mock.calls
    .filter(([m, e]: [string, string]) => m === "POST" && e === "/channels")
    .map(([, , body]: [string, string, { name: string }]) => body.name);

beforeEach(() => {
  vi.clearAllMocks();
  h.setDocs({ "users/u1": {} });
  h.mmApiCall.mockImplementation(async (method: string, endpoint: string, body?: { name?: string }) => {
    if (method === "POST" && endpoint === "/users") return { id: "builder-1", delete_at: 0 };
    if (method === "POST" && endpoint === "/teams") return { id: "team-1" };
    if (method === "POST" && endpoint === "/channels") return { id: `ch:${body?.name}` };
    if (method === "POST" && endpoint === "/bots") return { user_id: "coach-1" };
    if (method === "POST" && endpoint === "/users/builder-1/tokens") return { token: "builder-token" };
    if (method === "GET" && endpoint.includes("/channels/name/")) return null;
    return {};
  });
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
    expect(result).not.toHaveProperty("mattermost.adminChannelId");
    expect(createdChannelNames()).toEqual([
      workspaceCoachChannelName("acme"),
      workspaceGeneralChannelName("acme"),
    ]);
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
    expect(h.secretPut).toHaveBeenCalledWith("u1", {
      kind: "builder-mattermost",
      secretId: "mattermost",
      projectId: null,
      personalToken: "builder-token",
      mattermostUserId: null,
      createdAt: { serverNow: true },
      rotatedAt: null,
    });
    expect(h.setSpy).not.toHaveBeenCalled();
  });

  it("never reads MM_COMMUNITY_TEAM_ID — community membership is reconciled separately, not during MM account provisioning", async () => {
    process.env.MM_COMMUNITY_TEAM_ID = "legacy-community-team";
    try {
      await call(HAPPY);
    } finally {
      delete process.env.MM_COMMUNITY_TEAM_ID;
    }

    expect(seq()).not.toContain("POST /teams/legacy-community-team/members");
  });
});

describe("provisionMattermostUser — already provisioned (idempotent backfill)", () => {
  beforeEach(() => {
    h.setDocs({
      "users/u1": {
        mattermost: {
          userId: "existing-builder",
          username: "acme",
          teamId: "existing-team",
          coachUserId: "existing-coach",
        },
      },
      "workspaces/acme": { mattermost: { teamId: "existing-team" } },
      "workspaces/acme/channels/coach-dm": {
        name: "acme-coach",
        mattermost: { channelId: "existing-coach-ch" },
      },
      "workspaces/acme/channels/general": { mattermost: { channelId: "existing-general-ch" } },
      "workspaces/acme/channels/admin": { mattermost: { channelId: "existing-admin-ch" } },
      "users/u1/secrets/coachMattermost": { personalToken: "existing-coach-pat" },
    });
  });

  it("returns the complete persisted topology without creating a new user or team", async () => {
    const result = await call(HAPPY);
    expect(result["mattermost.userId"]).toBe("existing-builder");
    expect(result["mattermost.teamId"]).toBe("existing-team");
    expect(result["mattermost.coachUserId"]).toBe("existing-coach");
    expect(result["mattermost.channelId"]).toBe("existing-coach-ch");
    expect(result["mattermost.generalChannelId"]).toBe("existing-general-ch");
    expect(result["mattermost.adminChannelId"]).toBe("existing-admin-ch");
    expect(result["_coachPersonalToken"]).toBe("existing-coach-pat");
    expect(seq()).not.toContain("POST /users");
    expect(seq()).not.toContain("POST /teams");
  });

  it("keeps a new-style topology without an Admin channel idempotent", async () => {
    h.setDocs({
      "users/u1": {
        mattermost: {
          userId: "existing-builder",
          username: "acme",
          teamId: "existing-team",
          coachUserId: "existing-coach",
        },
      },
      "workspaces/acme": { mattermost: { teamId: "existing-team" } },
      "workspaces/acme/channels/coach-dm": {
        name: "acme-coach",
        mattermost: { channelId: "existing-coach-ch" },
      },
      "workspaces/acme/channels/general": { mattermost: { channelId: "existing-general-ch" } },
      "users/u1/secrets/coachMattermost": { personalToken: "existing-coach-pat" },
    });

    const result = await call(HAPPY);

    expect(result["mattermost.channelId"]).toBe("existing-coach-ch");
    expect(result["mattermost.generalChannelId"]).toBe("existing-general-ch");
    expect(result).not.toHaveProperty("mattermost.adminChannelId");
    expect(seq()).not.toContain("POST /users");
    expect(seq()).not.toContain("POST /teams");
  });

  it("re-enters provisioning when the persisted topology has no team", async () => {
    h.setDocs({
      "users/u1": { mattermost: { userId: "existing-builder", username: "acme" } },
      "workspaces/acme/channels/coach-dm": { mattermost: { channelId: "existing-coach-ch" } },
    });

    const result = await call(HAPPY);

    expect(result["mattermost.teamId"]).toBe("team-1");
    expect(seq()).toContain("POST /teams");
  });

  it("re-enters provisioning when a persisted team is missing canonical channels", async () => {
    h.setDocs({
      "users/u1": {
        mattermost: { userId: "existing-builder", username: "acme", teamId: "existing-team" },
      },
      "workspaces/acme": { mattermost: { teamId: "existing-team" } },
      "workspaces/acme/channels/coach-dm": { mattermost: { channelId: "existing-coach-ch" } },
    });

    const result = await call(HAPPY);

    expect(result["mattermost.teamId"]).toBe("team-1");
    expect(seq()).toContain("POST /teams");
  });
});

describe("provisionMattermostUser — degraded paths", () => {
  it("reactivates and re-patches a soft-deleted user found by email", async () => {
    h.mmApiCall.mockImplementation(async (method: string, endpoint: string, body?: { name?: string }) => {
      if (method === "POST" && endpoint === "/users") return null; // create conflicts
      if (method === "POST" && endpoint === "/channels") return { id: `ch:${body?.name}` };
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
