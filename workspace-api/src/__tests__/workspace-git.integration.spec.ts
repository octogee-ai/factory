import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const firestoreData: Record<string, any> = {};

vi.mock("../lib/db", () => ({
  auth: {
    verifyIdToken: vi.fn().mockResolvedValue({ uid: "caller-uid" }),
  },
  db: {
    doc: function makeDocRef(p: string): any {
      return {
        get: async () => {
          const data = firestoreData[p];
          return { exists: !!data, data: () => data };
        },
        collection: (sub: string) => ({
          doc: (subId: string) => ({
            get: async () => {
              const key = `${p}/${sub}/${subId}`;
              return { exists: !!firestoreData[key], data: () => firestoreData[key] };
            },
          }),
        }),
      };
    },
    collection: (name: string) => ({
      doc: (id: string) => ({
        get: async () => {
          const data = firestoreData[`${name}/${id}`];
          return { exists: !!data, data: () => data };
        },
        collection: (sub: string) => ({
          doc: (subId: string) => ({
            get: async () => {
              const key = `${name}/${id}/${sub}/${subId}`;
              return { exists: !!firestoreData[key], data: () => firestoreData[key] };
            },
          }),
        }),
      }),
    }),
  },
  FieldValue: { serverTimestamp: () => ({}) },
  Timestamp: { fromDate: (d: Date) => ({ toDate: () => d }) },
}));

vi.mock("../lib/mattermost", () => ({
  mmApi: vi.fn(),
  MM_URL: "http://mattermost-test:8065",
}));

vi.mock("../lib/gitea", () => ({
  giteaApi: vi.fn(),
  giteaApiAllowNotFound: vi.fn(),
  giteaApiAs: vi.fn(),
  giteaApiAsAllowNotFound: vi.fn(),
  GITEA_ORG: "octogee-test",
}));

vi.mock("../lib/stripe", () => ({
  getStripe: () => ({ webhooks: { constructEvent: vi.fn() } }),
  getWebhookSecret: () => "whsec_test",
}));

import { createApp } from "../index";

function gitInit(dir: string): void {
  spawnSync("git", ["init", "--initial-branch=main"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "test@x.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "test"], { cwd: dir });
}

function gitAddCommit(dir: string, msg: string): void {
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync("git", ["commit", "-m", msg], { cwd: dir });
}

let customersRoot: string;
const SLUG = "joe42";

beforeAll(async () => {
  customersRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wsroot-int-"));
  process.env.CUSTOMERS_DIR = customersRoot;
  const slugDir = path.join(customersRoot, SLUG);
  await fs.mkdir(slugDir);
  gitInit(slugDir);
  await fs.writeFile(path.join(slugDir, "README.md"), "hello\n");
  gitAddCommit(slugDir, "initial");
});

afterAll(async () => {
  await fs.rm(customersRoot, { recursive: true, force: true });
});

beforeEach(() => {
  for (const k of Object.keys(firestoreData)) delete firestoreData[k];
  firestoreData[`users/caller-uid`] = { uid: "caller-uid", username: SLUG, workspaceId: SLUG };
  firestoreData[`users/caller-uid/system/config`] = { role: "user" };
  firestoreData[`workspaces/${SLUG}`] = { id: SLUG, ownerUid: "caller-uid", slug: SLUG };
});

describe("GET /api/workspace/git/status", () => {
  it("returns clean tree as empty entries", async () => {
    const app = createApp();
    const res = await request(app)
      .get(`/api/workspace/git/status?slug=${SLUG}`)
      .set("Authorization", "Bearer caller-idtoken");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ entries: [] });
  });

  it("returns modified file when working tree has changes", async () => {
    await fs.writeFile(path.join(customersRoot, SLUG, "README.md"), "modified\n");
    const app = createApp();
    const res = await request(app)
      .get(`/api/workspace/git/status?slug=${SLUG}`)
      .set("Authorization", "Bearer caller-idtoken");
    expect(res.status).toBe(200);
    expect(res.body.entries).toEqual([{ path: "README.md", change: "modified" }]);
    // restore for other tests
    await fs.writeFile(path.join(customersRoot, SLUG, "README.md"), "hello\n");
  });

  it("returns 503 + CUSTOMER_DIR_MISSING when slug isn't on the filesystem", async () => {
    firestoreData[`users/caller-uid`] = { uid: "caller-uid", username: "ghost", workspaceId: "ghost" };
    firestoreData[`workspaces/ghost`] = { id: "ghost", ownerUid: "caller-uid", slug: "ghost" };
    const app = createApp();
    const res = await request(app)
      .get(`/api/workspace/git/status?slug=ghost`)
      .set("Authorization", "Bearer caller-idtoken");
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("CUSTOMER_DIR_MISSING");
  });

  it("returns 403 when caller is not the workspace owner", async () => {
    firestoreData[`users/caller-uid`] = { uid: "caller-uid", username: "other", workspaceId: "other" };
    const app = createApp();
    const res = await request(app)
      .get(`/api/workspace/git/status?slug=${SLUG}`)
      .set("Authorization", "Bearer caller-idtoken");
    expect(res.status).toBe(403);
  });
});

describe("GET /api/workspace/git/diff", () => {
  it("returns the unified diff text/plain for a modified file", async () => {
    await fs.writeFile(path.join(customersRoot, SLUG, "README.md"), "changed\n");
    const app = createApp();
    const res = await request(app)
      .get(`/api/workspace/git/diff?slug=${SLUG}&path=README.md`)
      .set("Authorization", "Bearer caller-idtoken");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/plain/);
    expect(res.text).toContain("--- a/README.md");
    expect(res.text).toContain("+changed");
    await fs.writeFile(path.join(customersRoot, SLUG, "README.md"), "hello\n");
  });

  it("rejects path traversal with 400", async () => {
    const app = createApp();
    const res = await request(app)
      .get(`/api/workspace/git/diff?slug=${SLUG}&path=../etc/passwd`)
      .set("Authorization", "Bearer caller-idtoken");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("BAD_PATH");
  });

  it("rejects ref names with shell metacharacters with 400", async () => {
    const app = createApp();
    const res = await request(app)
      .get(`/api/workspace/git/diff?slug=${SLUG}&ref=main;rm -rf /`)
      .set("Authorization", "Bearer caller-idtoken");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("BAD_REF");
  });

  it("rejects ref names that start with a dash (would be parsed as a flag)", async () => {
    const app = createApp();
    const res = await request(app)
      .get(`/api/workspace/git/diff?slug=${SLUG}&ref=-deadbeef`)
      .set("Authorization", "Bearer caller-idtoken");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("BAD_REF");
  });
});

describe("GET /api/workspace/git/log", () => {
  it("returns the initial commit for a fresh repo", async () => {
    const app = createApp();
    const res = await request(app)
      .get(`/api/workspace/git/log?slug=${SLUG}&limit=5`)
      .set("Authorization", "Bearer caller-idtoken");
    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0].subject).toBe("initial");
    expect(res.body.entries[0].sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("rejects branch names with shell metacharacters", async () => {
    const app = createApp();
    const res = await request(app)
      .get(`/api/workspace/git/log?slug=${SLUG}&branch=main$(whoami)`)
      .set("Authorization", "Bearer caller-idtoken");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("BAD_BRANCH");
  });
});

describe("project-target auth-bypass guard (Copilot review on #825)", () => {
  // withFileTarget authorizes project members for project-scoped requests.
  // Phase 6.B is workspace-only — without an explicit reject, a project
  // member could pass `?project=…` and read the parent workspace repo's
  // git state. Regression test pins the reject.
  beforeEach(() => {
    firestoreData[`workspaces/${SLUG}/projects/myproj`] = {
      slug: "myproj",
      ownerUid: "caller-uid",
    };
  });

  it("rejects /git/status with ?project= (PROJECT_TARGET_UNSUPPORTED)", async () => {
    const app = createApp();
    const res = await request(app)
      .get(`/api/workspace/git/status?slug=${SLUG}&project=myproj`)
      .set("Authorization", "Bearer caller-idtoken");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("PROJECT_TARGET_UNSUPPORTED");
  });

  it("rejects /git/diff with ?project=", async () => {
    const app = createApp();
    const res = await request(app)
      .get(`/api/workspace/git/diff?slug=${SLUG}&project=myproj`)
      .set("Authorization", "Bearer caller-idtoken");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("PROJECT_TARGET_UNSUPPORTED");
  });

  it("rejects /git/log with ?project=", async () => {
    const app = createApp();
    const res = await request(app)
      .get(`/api/workspace/git/log?slug=${SLUG}&project=myproj`)
      .set("Authorization", "Bearer caller-idtoken");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("PROJECT_TARGET_UNSUPPORTED");
  });
});

describe("POST /api/workspace/git/commit (Phase 6.C.2)", () => {
  it("commits a real working-tree change with the requesting user as author", async () => {
    // Modify the seeded repo so there's something to commit.
    await fs.writeFile(path.join(customersRoot, SLUG, "README.md"), "owner change\n");
    firestoreData[`users/caller-uid`] = {
      uid: "caller-uid",
      username: SLUG,
      workspaceId: SLUG,
      displayName: "Bob Owner",
      email: "bob@example.com",
    };
    const app = createApp();
    const res = await request(app)
      .post(`/api/workspace/git/commit?slug=${SLUG}`)
      .set("Authorization", "Bearer caller-idtoken")
      .send({ message: "Owner-driven change" });
    expect(res.status).toBe(200);
    expect(res.body.empty).toBe(false);
    expect(res.body.sha).toMatch(/^[0-9a-f]{40}$/);

    // Verify the commit's author email matches the Firestore profile.
    const last = spawnSync("git", ["log", "-1", "--pretty=format:%ae"], {
      cwd: path.join(customersRoot, SLUG),
      encoding: "utf-8",
    });
    expect(last.stdout.trim()).toBe("bob@example.com");

    // Restore for subsequent tests.
    await fs.writeFile(path.join(customersRoot, SLUG, "README.md"), "hello\n");
    spawnSync("git", ["add", "."], { cwd: path.join(customersRoot, SLUG) });
    spawnSync("git", ["commit", "-m", "restore"], { cwd: path.join(customersRoot, SLUG) });
  });

  it("returns 200 with empty: true for clean working tree (idempotent — no error)", async () => {
    const app = createApp();
    const res = await request(app)
      .post(`/api/workspace/git/commit?slug=${SLUG}`)
      .set("Authorization", "Bearer caller-idtoken")
      .send({ message: "nothing to commit" });
    expect(res.status).toBe(200);
    expect(res.body.empty).toBe(true);
  });

  it("rejects empty message with 400 BAD_MESSAGE", async () => {
    const app = createApp();
    const res = await request(app)
      .post(`/api/workspace/git/commit?slug=${SLUG}`)
      .set("Authorization", "Bearer caller-idtoken")
      .send({ message: "   " });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("BAD_MESSAGE");
  });

  it("rejects 5001-char message with 400 MESSAGE_TOO_LONG", async () => {
    const app = createApp();
    const res = await request(app)
      .post(`/api/workspace/git/commit?slug=${SLUG}`)
      .set("Authorization", "Bearer caller-idtoken")
      .send({ message: "x".repeat(5_001) });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("MESSAGE_TOO_LONG");
  });

  it("returns 403 when caller is not the workspace owner (withFileTarget primary gate)", async () => {
    firestoreData[`users/caller-uid`] = {
      uid: "caller-uid",
      username: "someone-else",
      workspaceId: "someone-else",
    };
    const app = createApp();
    const res = await request(app)
      .post(`/api/workspace/git/commit?slug=${SLUG}`)
      .set("Authorization", "Bearer caller-idtoken")
      .send({ message: "not my workspace" });
    expect(res.status).toBe(403);
  });

  it("rejects /git/commit with ?project= (PROJECT_TARGET_UNSUPPORTED)", async () => {
    firestoreData[`workspaces/${SLUG}/projects/myproj`] = {
      slug: "myproj",
      ownerUid: "caller-uid",
    };
    const app = createApp();
    const res = await request(app)
      .post(`/api/workspace/git/commit?slug=${SLUG}&project=myproj`)
      .set("Authorization", "Bearer caller-idtoken")
      .send({ message: "via project" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("PROJECT_TARGET_UNSUPPORTED");
  });
});

describe("POST /api/workspace/git/push (Phase 6.C.2)", () => {
  it("returns 403 for non-owner callers (withFileTarget primary gate)", async () => {
    firestoreData[`users/caller-uid`] = {
      uid: "caller-uid",
      username: "someone-else",
      workspaceId: "someone-else",
    };
    const app = createApp();
    const res = await request(app)
      .post(`/api/workspace/git/push?slug=${SLUG}`)
      .set("Authorization", "Bearer caller-idtoken");
    expect(res.status).toBe(403);
  });

  it("rejects /git/push with ?project= (PROJECT_TARGET_UNSUPPORTED)", async () => {
    firestoreData[`workspaces/${SLUG}/projects/myproj`] = {
      slug: "myproj",
      ownerUid: "caller-uid",
    };
    const app = createApp();
    const res = await request(app)
      .post(`/api/workspace/git/push?slug=${SLUG}&project=myproj`)
      .set("Authorization", "Bearer caller-idtoken");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("PROJECT_TARGET_UNSUPPORTED");
  });

  it("rejects unsafe branch ref names with 400 BAD_BRANCH", async () => {
    const app = createApp();
    const res = await request(app)
      .post(`/api/workspace/git/push?slug=${SLUG}`)
      .set("Authorization", "Bearer caller-idtoken")
      .send({ branch: "-deletes-everything" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("BAD_BRANCH");
  });
});

describe("concurrency cap (P1-1)", () => {
  it("returns 429 CONCURRENCY_LIMIT when more than 4 in-flight git ops for the same slug", async () => {
    const app = createApp();
    // Fire 6 in parallel (cap is 4). At least one must 429.
    const responses = await Promise.all(
      Array.from({ length: 6 }, () =>
        request(app)
          .get(`/api/workspace/git/status?slug=${SLUG}`)
          .set("Authorization", "Bearer caller-idtoken"),
      ),
    );
    const statuses = responses.map((r) => r.status);
    const ok = statuses.filter((s) => s === 200).length;
    const limited = statuses.filter((s) => s === 429).length;
    expect(ok + limited).toBe(6);
    expect(limited).toBeGreaterThan(0);
    for (const r of responses) {
      if (r.status === 429) {
        expect(r.body.code).toBe("CONCURRENCY_LIMIT");
      }
    }
  });
});
