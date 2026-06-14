import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "../lib/db.js";
import {
  setupEmulatorTest,
  getIdTokenForUid,
} from "@shared/test-helpers/firestore-emulator.js";

// Positional mock for the Sudo client: giteaApiAsUser(sudoUser, org, path, method, body).
// c[0]=sudoUser (was token in the PAT era), c[2]=path, c[3]=method, c[4]=body.
const mockGiteaApiAs = vi.fn();
vi.mock("../lib/gitea", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/gitea.js")>();
  return {
    ...actual,
    giteaApiAsUser: (...args: unknown[]) => mockGiteaApiAs(...args),
    giteaApiAsUserAllowNotFound: (...args: unknown[]) => mockGiteaApiAs(...args),
  };
});

const mockGithubGet = vi.fn();
const mockGithubPut = vi.fn();
vi.mock("../lib/github", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/github.js")>();
  return {
    ...actual,
    githubContentsApi: (...args: unknown[]) => mockGithubGet(...args),
    githubContentsPut: (...args: unknown[]) => mockGithubPut(...args),
  };
});

const mockReadConnectorAccessToken = vi.hoisted(() => vi.fn());
vi.mock("../lib/connector-tokens", () => ({
  readConnectorAccessToken: mockReadConnectorAccessToken,
}));

vi.mock("../lib/kms", () => ({
  decryptSecret: async (s: string) => s.replace(/^enc:/, ""),
  encryptSecret: async (s: string) => `enc:${s}`,
}));

import { createApp } from "../index.js";

setupEmulatorTest();

const ALICE_UID = "alice-uid";
const BOB_UID = "bob-uid";
const CARL_UID = "carl-uid";
const DORA_UID = "dora-uid";

async function authHeader(uid: string): Promise<{ Authorization: string }> {
  const token = await getIdTokenForUid(uid);
  return { Authorization: `Bearer ${token}` };
}

async function seedUser(
  uid: string,
  username: string,
  displayName: string,
  email: string,
): Promise<void> {
  await db.collection("users").doc(uid).set({
    username,
    displayName,
    email,
    workspaceId: username,
    provisioning: { openclaw: { slug: username } },
  });
  await db.doc(`users/${uid}/system/config`).set({ role: "user" });
  await db.doc(`users/${uid}/secrets/gitea`).set({ token: `${username}-gitea-token` });
}

async function seedAll(): Promise<void> {
  await seedUser(ALICE_UID, "alice", "Alice A", "alice@x.test");
  await seedUser(BOB_UID, "bob", "Bob B", "bob@x.test");
  await seedUser(CARL_UID, "carl", "Carl C", "carl@x.test");
  await seedUser(DORA_UID, "dora", "Dora D", "dora@x.test");
  await db.doc(`users/${DORA_UID}/secrets/gitea`).delete();

  // Workspace docs — bob is a member of alice's workspace; carl is not.
  await db.doc("workspaces/alice").set({ slug: "alice", ownerUid: ALICE_UID });
  await db.doc(`workspaces/alice/members/${BOB_UID}`).set({ role: "member" });
  await db.doc("workspaces/carl").set({ slug: "carl", ownerUid: CARL_UID });
  // dora's workspace: bob is a member, but dora has no gitea token to broker.
  await db.doc("workspaces/dora").set({ slug: "dora", ownerUid: DORA_UID });
  await db.doc(`workspaces/dora/members/${BOB_UID}`).set({ role: "member" });

  // Gitea-backed project owned by alice; bob is a member.
  await db.doc("workspaces/alice/projects/zine").set({
    slug: "zine",
    ownerUid: ALICE_UID,
    canvasFile: "README.md",
  });
  await db.doc(`workspaces/alice/projects/zine/members/${BOB_UID}`).set({ role: "member" });

  // GitHub-backed project owned by alice (connected); bob is a member.
  await db.doc("workspaces/alice/projects/octogee").set({
    slug: "octogee",
    ownerUid: ALICE_UID,
    canvasFile: "docs/home.md",
    repoSource: { provider: "github", owner: "octogee-ai", repo: "octogee" },
  });
  await db.doc(`workspaces/alice/projects/octogee/members/${BOB_UID}`).set({ role: "member" });
  await db.doc(`users/${ALICE_UID}/secrets/github`).set({
    tokens: { encryptedAccessToken: "enc:gh-tok" },
  });

  // GitHub-backed project whose owner (carl) never connected GitHub; bob is a member.
  await db.doc("workspaces/carl/projects/ghost").set({
    slug: "ghost",
    ownerUid: CARL_UID,
    canvasFile: "README.md",
    repoSource: { provider: "github", owner: "carl-org", repo: "ghost" },
  });
  await db.doc(`workspaces/carl/projects/ghost/members/${BOB_UID}`).set({ role: "member" });
}

beforeEach(async () => {
  mockGiteaApiAs.mockReset();
  mockGithubGet.mockReset();
  mockGithubPut.mockReset();
  mockReadConnectorAccessToken.mockReset();
  mockReadConnectorAccessToken.mockImplementation(async (uid: string) =>
    uid === ALICE_UID ? "gh-tok" : null,
  );
  await seedAll();
});

const app = createApp();

describe("POST /api/workspace/save — gitea targets", () => {
  it("saves a new workspace note as a contents PUT with the caller as author", async () => {
    mockGiteaApiAs.mockImplementation(async (_tok, _org, _path, method) => {
      if (method === undefined || method === "GET") throw new Error("Gitea API 404");
      return { content: { sha: "gitea-sha-1" } };
    });

    const res = await request(app)
      .post("/api/workspace/save")
      .set(await authHeader(ALICE_UID))
      .send({ slug: "alice", path: "notes/idea.md", content: "# Idea\n" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, sha: "gitea-sha-1", provider: "gitea" });

    const put = mockGiteaApiAs.mock.calls.find((c) => c[3] === "PUT");
    expect(put).toBeDefined();
    const [sudoUser, org, apiPath, , body] = put as [string, string, string, string, Record<string, unknown>];
    expect(sudoUser).toBe("ws-alice");
    expect(org).toBe("alice");
    expect(apiPath).toBe("workspace/contents/notes/idea.md");
    expect(body.content).toBe(Buffer.from("# Idea\n", "utf8").toString("base64"));
    expect(body.message).toBe("notes: edit notes/idea.md — Alice A via Octogee Canvas");
    expect(body.author).toEqual({ name: "Alice A", email: "alice@x.test" });
    expect("sha" in body).toBe(false);
  });

  it("passes the existing sha through on update", async () => {
    mockGiteaApiAs.mockImplementation(async (_tok, _org, _path, method) => {
      if (method === undefined || method === "GET") return { sha: "existing-sha" };
      return { content: { sha: "gitea-sha-2" } };
    });

    const res = await request(app)
      .post("/api/workspace/save")
      .set(await authHeader(ALICE_UID))
      .send({ slug: "alice", path: "notes/idea.md", content: "# Updated" });

    expect(res.status).toBe(200);
    const put = mockGiteaApiAs.mock.calls.find((c) => c[3] === "PUT")!;
    expect((put[4] as Record<string, unknown>).sha).toBe("existing-sha");
  });

  it("rejects a caller who is neither owner nor member on a workspace target", async () => {
    const res = await request(app)
      .post("/api/workspace/save")
      .set(await authHeader(CARL_UID))
      .send({ slug: "alice", path: "notes/idea.md", content: "x" });

    expect(res.status).toBe(403);
    expect(mockGiteaApiAs).not.toHaveBeenCalled();
  });

  it("lets a project member save a note with their own authorship", async () => {
    mockGiteaApiAs.mockImplementation(async (_tok, _org, _path, method) => {
      if (method === undefined || method === "GET") throw new Error("Gitea API 404");
      return { content: { sha: "gitea-sha-3" } };
    });

    const res = await request(app)
      .post("/api/workspace/save")
      .set(await authHeader(BOB_UID))
      .send({ slug: "alice", project: "zine", path: "notes/from-bob.md", content: "hi" });

    expect(res.status).toBe(200);
    const put = mockGiteaApiAs.mock.calls.find((c) => c[3] === "PUT")!;
    expect(put[1]).toBe("alice");
    expect(put[2]).toBe("zine/contents/notes/from-bob.md");
    expect((put[4] as Record<string, unknown>).author).toEqual({ name: "Bob B", email: "bob@x.test" });
    // Project members hold real collaborator ACL — impersonate their OWN gitea identity.
    expect(put[0]).toBe("ws-bob");
  });

  it("allows gitea saves outside notes/ (the files surface already does)", async () => {
    mockGiteaApiAs.mockImplementation(async (_tok, _org, _path, method) => {
      if (method === undefined || method === "GET") throw new Error("Gitea API 404");
      return { content: { sha: "gitea-sha-4" } };
    });

    const res = await request(app)
      .post("/api/workspace/save")
      .set(await authHeader(ALICE_UID))
      .send({ slug: "alice", path: "docs/plan.md", content: "p" });

    expect(res.status).toBe(200);
  });
});

describe("POST /api/workspace/save — github targets (brokered, allowlisted)", () => {
  it("saves a flat note via the owner-brokered token with the editing member as author", async () => {
    mockGithubGet.mockRejectedValue(new Error("GitHub API 404"));
    mockGithubPut.mockResolvedValue({ content: { sha: "gh-sha-1" } });

    const res = await request(app)
      .post("/api/workspace/save")
      .set(await authHeader(BOB_UID))
      .send({ slug: "alice", project: "octogee", path: "notes/wild-card.md", content: "# WC" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, sha: "gh-sha-1", provider: "github" });
    expect(mockGithubPut).toHaveBeenCalledTimes(1);
    const [owner, repo, path, token, body] = mockGithubPut.mock.calls[0] as [
      string, string, string, string, Record<string, unknown>,
    ];
    expect([owner, repo, path, token]).toEqual(["octogee-ai", "octogee", "notes/wild-card.md", "gh-tok"]);
    expect(mockReadConnectorAccessToken).toHaveBeenCalledWith(ALICE_UID, "github", {
      kind: "project",
      requestingUid: BOB_UID,
      workspaceSlug: "alice",
      projectSlug: "octogee",
    });
    expect(body.message).toBe("notes: edit notes/wild-card.md — Bob B via Octogee Canvas");
    expect(body.author).toEqual({ name: "Bob B", email: "bob@x.test" });
    expect(body.contentBase64).toBe(Buffer.from("# WC", "utf8").toString("base64"));
    expect("sha" in body).toBe(false);
  });

  it("updates with the existing sha when the note already exists", async () => {
    mockGithubGet.mockResolvedValue({ sha: "gh-old" });
    mockGithubPut.mockResolvedValue({ content: { sha: "gh-sha-2" } });

    const res = await request(app)
      .post("/api/workspace/save")
      .set(await authHeader(ALICE_UID))
      .send({ slug: "alice", project: "octogee", path: "notes/wild-card.md", content: "v2" });

    expect(res.status).toBe(200);
    expect((mockGithubPut.mock.calls[0][4] as Record<string, unknown>).sha).toBe("gh-old");
  });

  it("allows the configured canvas home file", async () => {
    mockGithubGet.mockResolvedValue({ sha: "home-old" });
    mockGithubPut.mockResolvedValue({ content: { sha: "gh-sha-3" } });

    const res = await request(app)
      .post("/api/workspace/save")
      .set(await authHeader(ALICE_UID))
      .send({ slug: "alice", project: "octogee", path: "docs/home.md", content: "home" });

    expect(res.status).toBe(200);
    const body = mockGithubPut.mock.calls[0][4] as Record<string, unknown>;
    expect(body.message).toBe("canvas: edit docs/home.md — Alice A via Octogee Canvas");
  });

  it("403s any path outside notes/*.md + canvasFile (code writes stay merge-gated)", async () => {
    const res = await request(app)
      .post("/api/workspace/save")
      .set(await authHeader(ALICE_UID))
      .send({ slug: "alice", project: "octogee", path: "src/index.ts", content: "evil" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("PATH_NOT_WRITABLE");
    expect(mockGithubPut).not.toHaveBeenCalled();
  });

  it("403s a nested notes path (flat-only)", async () => {
    const res = await request(app)
      .post("/api/workspace/save")
      .set(await authHeader(ALICE_UID))
      .send({ slug: "alice", project: "octogee", path: "notes/sub/x.md", content: "x" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("PATH_NOT_WRITABLE");
  });

  it("422s when the owner has not connected GitHub", async () => {
    const res = await request(app)
      .post("/api/workspace/save")
      .set(await authHeader(BOB_UID))
      .send({ slug: "carl", project: "ghost", path: "notes/x.md", content: "x" });

    expect(res.status).toBe(422);
    expect(res.body.reason).toBe("owner_github_not_connected");
  });
});

describe("POST /api/workspace/save — input validation", () => {
  it("400s path traversal", async () => {
    const res = await request(app)
      .post("/api/workspace/save")
      .set(await authHeader(ALICE_UID))
      .send({ slug: "alice", path: "notes/../secret.md", content: "x" });
    expect(res.status).toBe(400);
  });

  it("400s non-text files", async () => {
    const res = await request(app)
      .post("/api/workspace/save")
      .set(await authHeader(ALICE_UID))
      .send({ slug: "alice", path: "notes/pic.png", content: "x" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("NOT_TEXT");
  });

  it("400s a missing content body", async () => {
    const res = await request(app)
      .post("/api/workspace/save")
      .set(await authHeader(ALICE_UID))
      .send({ slug: "alice", path: "notes/x.md" });
    expect(res.status).toBe(400);
  });
});

describe("workspace targets — member access, brokered through the owner's token", () => {
  it("lets a workspace member list notes via the owner's gitea token", async () => {
    mockGiteaApiAs.mockImplementation(async (_tok, _org, apiPath) => {
      if (String(apiPath).endsWith("contents/notes")) {
        return [
          { name: "welcome.md", path: "notes/welcome.md", type: "file", size: 1 },
        ];
      }
      throw new Error("Gitea API 404");
    });

    const res = await request(app)
      .get("/api/workspace/files?slug=alice&path=notes")
      .set(await authHeader(BOB_UID));

    expect(res.status).toBe(200);
    expect(res.body.files.map((f: { name: string }) => f.name)).toEqual(["welcome.md"]);
    const listCall = mockGiteaApiAs.mock.calls.find((c) => String(c[2]).endsWith("contents/notes"))!;
    expect(listCall[0]).toBe("ws-alice");
  });

  it("lets a member read a note, marked writable", async () => {
    mockGiteaApiAs.mockResolvedValue({
      content: Buffer.from("# W", "utf8").toString("base64"),
      sha: "s",
      encoding: "base64",
    });

    const res = await request(app)
      .get("/api/workspace/file?slug=alice&path=notes/welcome.md")
      .set(await authHeader(BOB_UID));

    expect(res.status).toBe(200);
    expect(res.body.content).toBe("# W");
    expect(res.body.writable).toBe(true);
    expect(mockGiteaApiAs.mock.calls[0][0]).toBe("ws-alice");
  });

  it("marks the canvas home writable for a member but other paths read-only", async () => {
    mockGiteaApiAs.mockResolvedValue({
      content: Buffer.from("x", "utf8").toString("base64"),
      sha: "s",
      encoding: "base64",
    });

    const home = await request(app)
      .get("/api/workspace/file?slug=alice&path=README.md")
      .set(await authHeader(BOB_UID));
    expect(home.status).toBe(200);
    expect(home.body.writable).toBe(true);

    const other = await request(app)
      .get("/api/workspace/file?slug=alice&path=docs/plan.md")
      .set(await authHeader(BOB_UID));
    expect(other.status).toBe(200);
    expect(other.body.writable).toBe(false);
  });

  it("saves a member's note through the owner's token with the member as author", async () => {
    mockGiteaApiAs.mockImplementation(async (_tok, _org, _path, method) => {
      if (method === undefined || method === "GET") throw new Error("Gitea API 404");
      return { content: { sha: "ws-sha-1" } };
    });

    const res = await request(app)
      .post("/api/workspace/save")
      .set(await authHeader(BOB_UID))
      .send({ slug: "alice", path: "notes/from-bob.md", content: "# Bob's idea" });

    expect(res.status).toBe(200);
    const put = mockGiteaApiAs.mock.calls.find((c) => c[3] === "PUT")!;
    // Workspace member: brokered as the OWNER (ws-alice — no member ACL on the workspace repo)…
    expect(put[0]).toBe("ws-alice");
    expect(put[2]).toBe("workspace/contents/notes/from-bob.md");
    // …but still authored as the editing member.
    expect((put[4] as Record<string, unknown>).author).toEqual({ name: "Bob B", email: "bob@x.test" });
  });

  it("lets a member edit the canvas home file", async () => {
    mockGiteaApiAs.mockImplementation(async (_tok, _org, _path, method) => {
      if (method === undefined || method === "GET") return { sha: "old" };
      return { content: { sha: "ws-sha-2" } };
    });

    const res = await request(app)
      .post("/api/workspace/save")
      .set(await authHeader(BOB_UID))
      .send({ slug: "alice", path: "README.md", content: "# Home v2" });

    expect(res.status).toBe(200);
  });

  it("403s a member save outside the knowledge-store allowlist", async () => {
    const res = await request(app)
      .post("/api/workspace/save")
      .set(await authHeader(BOB_UID))
      .send({ slug: "alice", path: "docs/plan.md", content: "p" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("PATH_NOT_WRITABLE");
    expect(mockGiteaApiAs).not.toHaveBeenCalled();
  });

  it("still 403s a non-member on workspace files", async () => {
    const read = await request(app)
      .get("/api/workspace/file?slug=alice&path=notes/welcome.md")
      .set(await authHeader(CARL_UID));
    expect(read.status).toBe(403);

    const save = await request(app)
      .post("/api/workspace/save")
      .set(await authHeader(CARL_UID))
      .send({ slug: "alice", path: "notes/x.md", content: "x" });
    expect(save.status).toBe(403);
  });

  it("keeps upload owner-only — membership does not widen other write routes", async () => {
    const res = await request(app)
      .post("/api/workspace/upload")
      .set(await authHeader(BOB_UID))
      .send({ slug: "alice", files: [{ name: "x.md", content: "eA==" }] });

    expect(res.status).toBe(403);
  });

  it("403s a malformed slug at the member boundary instead of touching odd doc paths", async () => {
    const res = await request(app)
      .get("/api/workspace/file?slug=alice/projects/zine&path=notes/x.md")
      .set(await authHeader(BOB_UID));
    expect(res.status).toBe(403);

    const res2 = await request(app)
      .post("/api/workspace/save")
      .set(await authHeader(BOB_UID))
      .send({ slug: "alice/projects", path: "notes/x.md", content: "x" });
    expect(res2.status).toBe(403);
  });

  it("a member saves even when the owner has NO per-user token — the Sudo broker needs none (bug class retired)", async () => {
    // dora's workspace owner has no users/{uid}/secrets/gitea token. Under the old PAT
    // model this 422'd (owner_gitea_not_provisioned — the ceckert/Bender incident).
    // Sudo rides the platform admin token, so membership alone is enough.
    mockGiteaApiAs.mockImplementation(async (_sudo, _org, _path, method) => {
      if (method === undefined || method === "GET") throw new Error("Gitea API 404");
      return { content: { sha: "dora-sha" } };
    });

    const res = await request(app)
      .post("/api/workspace/save")
      .set(await authHeader(BOB_UID))
      .send({ slug: "dora", path: "notes/x.md", content: "x" });

    expect(res.status).toBe(200);
    const put = mockGiteaApiAs.mock.calls.find((c) => c[3] === "PUT")!;
    expect(put[0]).toBe("ws-dora");
  });
});

describe("GET /api/workspace/file — the writable signal", () => {
  it("marks gitea targets writable", async () => {
    mockGiteaApiAs.mockResolvedValue({
      content: Buffer.from("# Home", "utf8").toString("base64"),
      sha: "s1",
      encoding: "base64",
    });

    const res = await request(app)
      .get("/api/workspace/file?slug=alice&path=README.md")
      .set(await authHeader(ALICE_UID));

    expect(res.status).toBe(200);
    expect(res.body.writable).toBe(true);
  });

  it("marks a github note writable when the owner token resolves", async () => {
    mockGithubGet.mockResolvedValue({
      content: Buffer.from("# N", "utf8").toString("base64"),
      sha: "s2",
    });

    const res = await request(app)
      .get("/api/workspace/file?slug=alice&path=notes/x.md&project=octogee")
      .set(await authHeader(BOB_UID));

    expect(res.status).toBe(200);
    expect(res.body.writable).toBe(true);
  });

  it("marks github paths outside the allowlist read-only", async () => {
    mockGithubGet.mockResolvedValue({
      content: Buffer.from("code", "utf8").toString("base64"),
      sha: "s3",
    });

    const res = await request(app)
      .get("/api/workspace/file?slug=alice&path=src/index.ts&project=octogee")
      .set(await authHeader(BOB_UID));

    expect(res.status).toBe(200);
    expect(res.body.writable).toBe(false);
  });
});
