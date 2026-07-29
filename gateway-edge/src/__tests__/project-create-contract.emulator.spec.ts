import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getIdTokenForUid,
  setupEmulatorTest,
} from "@octogee/test-helpers/firestore-emulator";

const mockMmApi = vi.fn();
vi.mock("../lib/mattermost", () => ({
  mmApi: (...args: unknown[]) => mockMmApi(...args),
}));

const mockGetWorkspaceMmContext = vi.fn();
vi.mock("../lib/mattermost-context", () => ({
  getWorkspaceMmContext: (...args: unknown[]) => mockGetWorkspaceMmContext(...args),
}));

const mockInternalFetch = vi.fn();
vi.mock("../lib/internal-fetch", () => ({
  internalFetch: (...args: unknown[]) => mockInternalFetch(...args),
}));

vi.mock("../lib/gitea", () => ({
  giteaApi: vi.fn(),
  createProjectGiteaRepo: vi.fn(),
  giteaWriteFile: vi.fn(),
  giteaWriteFiles: vi.fn(),
}));

import { createApp } from "../index.js";
import { db } from "../lib/db.js";

setupEmulatorTest();

// SSR reader logic — must mirror
// site/src/pages/[workspaceSlug]/[projectSlug].astro (the workspace
// lookup → project lookup → visibility gate flow). Replicated here so
// a rename on either side (writer in lib/project-create-service.ts
// `createProjectForActor`, reader inline in the Astro page) fails this
// spec at PR time, not at deploy time.
interface ProjectReadOutcome {
  found: boolean;
  visibility?: string;
  provisioningState?: string;
  name?: string;
  slug?: string;
}

async function ssrReadProject(workspaceSlug: string, projectSlug: string): Promise<ProjectReadOutcome> {
  const wsSnap = await db.doc(`workspaces/${workspaceSlug}`).get();
  if (!wsSnap.exists) return { found: false };
  const ownerUid = wsSnap.data()?.ownerUid;
  if (!ownerUid) return { found: false };

  const projectSnap = await db
    .doc(`workspaces/${workspaceSlug}/projects/${projectSlug}`)
    .get();
  if (!projectSnap.exists) return { found: false };
  const p = projectSnap.data()!;

  // Visibility enforcement matches the Astro page: only 'public' or 'unlisted'
  // renders. Anything else (including undefined and 'private') → 404.
  if (p.visibility !== "public" && p.visibility !== "unlisted") {
    return {
      found: false,
      visibility: p.visibility,
      provisioningState: p.provisioningState,
    };
  }
  return {
    found: true,
    visibility: p.visibility,
    provisioningState: p.provisioningState,
    name: p.name,
    slug: p.slug,
  };
}

const CALLER_UID = "project-owner-uid";
const USERNAME = "projowner";
const ORIGINAL_FLEET_BROKER_URL = process.env.FLEET_BROKER_URL;

async function seedCaller(): Promise<void> {
  await db.collection("workspaces").doc(USERNAME).set({
    id: USERNAME,
    slug: USERNAME,
    ownerUid: CALLER_UID,
  });
  await db.collection("users").doc(CALLER_UID).set({
    uid: CALLER_UID,
    username: USERNAME,
    workspaceId: USERNAME,
    // Paid tier (unlimited projects) so the create-contract cases clear the
    // maxProjects gate; the gate is covered in project-create-service.spec.ts.
    subscription: { tier: "personal_pro_max", status: "active" },
  });
  await db
    .collection("users")
    .doc(CALLER_UID)
    .collection("system")
    .doc("config")
    .set({ role: "user" });
}

function mockProjectPairMattermost(): void {
  const channels = new Map<string, {
    id: string;
    name: string;
    team_id: string;
    type: "P" | "O";
    delete_at: number;
    members: Set<string>;
  }>();
  const notFound = (path: string) => {
    const error = new Error(`MM API 404: ${path} not found`) as Error & { status: number };
    error.status = 404;
    return error;
  };

  mockMmApi.mockImplementation(async (
    path: string,
    method?: string,
    body?: Record<string, unknown>,
  ) => {
    const verb = method ?? "GET";
    if (verb === "POST" && path === "/channels") {
      if (
        typeof body?.name !== "string"
        || typeof body.team_id !== "string"
        || (body.type !== "P" && body.type !== "O")
      ) {
        throw new Error("Mattermost channel fixture requires name, team_id, and type");
      }
      const id = body.name.endsWith("-activity") ? "ch-test-activity" : "ch-test-123";
      const created = {
        id,
        name: body.name,
        team_id: body.team_id,
        type: body.type,
        delete_at: 0,
        members: new Set<string>(),
      };
      channels.set(id, created);
      return created;
    }
    const channelRead = /^\/channels\/([^/?]+)$/.exec(path);
    if (verb === "GET" && channelRead) {
      const found = channels.get(channelRead[1]);
      if (!found) throw notFound(path);
      return found;
    }
    const channelLookup = /^\/teams\/([^/]+)\/channels\/name\/(.+)$/.exec(path);
    if (verb === "GET" && channelLookup) {
      const found = [...channels.values()].find((channel) =>
        channel.team_id === channelLookup[1] && channel.name === channelLookup[2]
      );
      if (!found) throw notFound(path);
      return found;
    }
    const memberList = /^\/channels\/([^/]+)\/members\?page=0&per_page=200$/.exec(path);
    if (verb === "GET" && memberList) {
      const found = channels.get(memberList[1]);
      if (!found) throw notFound(path);
      return [...found.members].map((userId) => ({ user_id: userId }));
    }
    const memberAdd = /^\/channels\/([^/]+)\/members$/.exec(path);
    if (verb === "POST" && memberAdd) {
      const found = channels.get(memberAdd[1]);
      if (!found) throw notFound(path);
      if (typeof body?.user_id !== "string") throw new Error("Mattermost member user_id is required");
      found.members.add(body.user_id);
      return { user_id: body.user_id, channel_id: found.id, roles: "channel_user" };
    }
    throw new Error(`Unexpected MM call: ${verb} ${path}`);
  });
}

function mockMmContextOk() {
  mockGetWorkspaceMmContext.mockResolvedValue({
    ownerUid: CALLER_UID,
    slug: USERNAME,
    teamId: "team-test",
    userId: "mm-user-test",
    username: "mm-username",
    coachUserId: "mm-coach-test",
    coachDmChannelId: null,
    generalChannelId: null,
    adminChannelId: null,
  });
  mockProjectPairMattermost();
}

let token = "";
beforeEach(async () => {
  mockMmApi.mockReset();
  mockGetWorkspaceMmContext.mockReset();
  mockInternalFetch.mockReset();
  mockInternalFetch.mockResolvedValue(new Response(JSON.stringify({ created: true }), { status: 200 }));
  process.env.FLEET_BROKER_URL = "http://octogee-api.test:3001";
  await seedCaller();
  token = await getIdTokenForUid(CALLER_UID);
});

afterEach(() => {
  if (ORIGINAL_FLEET_BROKER_URL === undefined) delete process.env.FLEET_BROKER_URL;
  else process.env.FLEET_BROKER_URL = ORIGINAL_FLEET_BROKER_URL;
});

describe("project create ↔ SSR project page read contract", () => {
  it("a successful POST /api/projects with visibility=public lands at workspaces/:slug/projects/:slug in the shape the SSR reader expects", async () => {
    mockMmContextOk();
    const app = createApp();

    const r = await request(app)
      .post("/api/projects")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Contract Project", slug: "mygame", visibility: "public" });
    expect(r.status, r.text).toBe(200);

    const ssr = await ssrReadProject(USERNAME, "mygame");
    expect(ssr.found).toBe(true);
    expect(ssr.visibility).toBe("public");
    expect(ssr.provisioningState).toBe("active");
    expect(ssr.name).toBe("Contract Project");
    expect(ssr.slug).toBe("mygame");
  });

  it("provisioning failure (MM unreachable) leaves the doc visibility=private so SSR returns 404 — no half-built leak", async () => {
    mockGetWorkspaceMmContext.mockResolvedValue({
      ownerUid: CALLER_UID,
      slug: USERNAME,
      teamId: "team-test",
      userId: "mm-user-test",
      username: "mm-username",
      coachUserId: "mm-coach-test",
      coachDmChannelId: null,
      generalChannelId: null,
      adminChannelId: null,
    });
    mockMmApi.mockRejectedValue(new Error("MM unreachable"));
    const app = createApp();

    const r = await request(app)
      .post("/api/projects")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Doomed Project", slug: "doomed", visibility: "public" });
    expect(r.status).toBe(502);

    const ssr = await ssrReadProject(USERNAME, "doomed");
    expect(ssr.found).toBe(false);
    expect(ssr.visibility).toBe("private");
    expect(ssr.provisioningState).toBe("failed");
  });

  it("visibility=private at create stays invisible to the SSR reader even after successful provisioning", async () => {
    mockMmContextOk();
    const app = createApp();

    const r = await request(app)
      .post("/api/projects")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Private Project", slug: "secret", visibility: "private" });
    expect(r.status).toBe(200);

    const ssr = await ssrReadProject(USERNAME, "secret");
    expect(ssr.found).toBe(false);
    expect(ssr.visibility).toBe("private");
  });
});

describe("github-backed project create", () => {
  const GH_REPO_SOURCE = { provider: "github", owner: "octogee-ai", repo: "octogee" };

  async function promoteToAdmin(): Promise<void> {
    await db
      .collection("users")
      .doc(CALLER_UID)
      .collection("system")
      .doc("config")
      .set({ role: "admin" });
  }

  it("rejects a caller without the GitHub project feature with 403 and writes no doc", async () => {
    mockMmContextOk();
    const app = createApp();

    const r = await request(app)
      .post("/api/projects")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Octogee", slug: "octogee", visibility: "private", repoSource: GH_REPO_SOURCE });
    expect(r.status, r.text).toBe(403);

    const snap = await db.doc(`workspaces/${USERNAME}/projects/octogee`).get();
    expect(snap.exists).toBe(false);
  });

  it("for an admin: stores repoSource and provisions the repo through the broker + chat", async () => {
    await promoteToAdmin();
    mockMmContextOk();
    const app = createApp();

    const r = await request(app)
      .post("/api/projects")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Octogee", slug: "octogee", visibility: "private", repoSource: GH_REPO_SOURCE });
    expect(r.status, r.text).toBe(200);

    const p = (await db.doc(`workspaces/${USERNAME}/projects/octogee`).get()).data()!;
    expect(p.repoSource).toEqual(GH_REPO_SOURCE);
    expect(typeof p.giteaRepoName).toBe("string");
    expect(p.provisioningState).toBe("active");

    expect(mockInternalFetch).toHaveBeenCalledWith(
      "http://octogee-api.test:3001/internal/gitea/provision-project-repo",
      expect.objectContaining({ method: "POST" }),
      { requireProjectedToken: true },
    );
    expect(mockMmApi).toHaveBeenCalled();
  });

  it("rejects an invalid repoSource (admin) with 400", async () => {
    await promoteToAdmin();
    mockMmContextOk();
    const app = createApp();

    const r = await request(app)
      .post("/api/projects")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Bad", slug: "badrepo", repoSource: { provider: "github", owner: "bad owner!", repo: "x" } });
    expect(r.status, r.text).toBe(400);
  });
});
