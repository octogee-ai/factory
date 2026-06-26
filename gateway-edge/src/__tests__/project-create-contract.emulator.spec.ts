import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

const mockCreateProjectGiteaRepo = vi.fn();
const mockGiteaWriteFile = vi.fn();
const mockGiteaApi = vi.fn();
vi.mock("../lib/gitea", () => ({
  giteaApi: (...args: unknown[]) => mockGiteaApi(...args),
  createProjectGiteaRepo: (...args: unknown[]) => mockCreateProjectGiteaRepo(...args),
  giteaWriteFile: (...args: unknown[]) => mockGiteaWriteFile(...args),
}));

import { createApp } from "../index.js";
import { db } from "../lib/db.js";

setupEmulatorTest();

// SSR reader logic — must mirror
// site/src/pages/[workspaceSlug]/[projectSlug].astro (the workspace
// lookup → project lookup → visibility gate flow). Replicated here so
// a rename on either side (writer in projects/create.ts, reader inline
// in the Astro page) fails this spec at PR time, not at deploy time.
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
  });
  await db
    .collection("users")
    .doc(CALLER_UID)
    .collection("system")
    .doc("config")
    .set({ role: "user" });
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
  mockMmApi.mockResolvedValue({ id: "ch-test-123" });
}

let token = "";
beforeEach(async () => {
  mockMmApi.mockReset();
  mockGetWorkspaceMmContext.mockReset();
  mockCreateProjectGiteaRepo.mockReset();
  mockCreateProjectGiteaRepo.mockResolvedValue(undefined);
  mockGiteaWriteFile.mockReset();
  mockGiteaWriteFile.mockResolvedValue(undefined);
  mockGiteaApi.mockReset();
  await seedCaller();
  token = await getIdTokenForUid(CALLER_UID);
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

  it("rejects a non-admin caller (Phase 1 is operator-only) with 403 and writes no doc", async () => {
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

  it("for an admin: stores repoSource and still provisions the Gitea system repo + chat", async () => {
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

    expect(mockCreateProjectGiteaRepo).toHaveBeenCalled();
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
