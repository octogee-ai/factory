import request from "supertest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  getIdTokenForUid,
  setupEmulatorTest,
} from "@octogee/test-helpers/firestore-emulator";

import { createApp } from "../index.js";
import { db } from "../lib/db.js";

setupEmulatorTest();

const UID = "ro-uid";
const WS = "rowsowner";
const PID = "ghproj";

let customersRoot = "";
let originalCustomersDir: string | undefined;

async function seedGithubProject(): Promise<void> {
  await db.collection("workspaces").doc(WS).set({ id: WS, slug: WS, ownerUid: UID });
  await db.collection("users").doc(UID).set({
    uid: UID,
    username: WS,
    workspaceId: WS,
    subscription: { tier: "personal", status: "active" },
  });
  await db.collection("users").doc(UID).collection("system").doc("config").set({ role: "admin" });
  await db.doc(`workspaces/${WS}/projects/${PID}`).set({
    id: PID,
    ownerUid: UID,
    workspaceId: WS,
    slug: PID,
    name: "GH",
    visibility: "private",
    provisioningState: "active",
    giteaRepoName: null,
    repoSource: { provider: "github", owner: "octogee-ai", repo: "octogee" },
    starCount: 0,
    memberCount: 1,
  });
}

beforeAll(async () => {
  customersRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gh-provider-gate-"));
  originalCustomersDir = process.env.CUSTOMERS_DIR;
  process.env.CUSTOMERS_DIR = customersRoot;
});

afterAll(async () => {
  if (originalCustomersDir === undefined) delete process.env.CUSTOMERS_DIR;
  else process.env.CUSTOMERS_DIR = originalCustomersDir;
  await fs.rm(customersRoot, { recursive: true, force: true });
});

describe("GitHub-backed project provider gate", () => {
  let token = "";
  beforeEach(async () => {
    await seedGithubProject();
    token = await getIdTokenForUid(UID);
  });

  it("/git/status resolves a github target against the local checkout", async () => {
    const r = await request(createApp())
      .get(`/api/g/test/workspace/git/status?slug=${WS}&project=${PID}`)
      .set("Authorization", `Bearer ${token}`);
    expect(r.status, r.text).toBe(503);
    expect(r.body.code).toBe("CUSTOMER_DIR_MISSING");
  });

  it("/upload refuses a github target (409) — blob writes stay Gitea-only", async () => {
    const r = await request(createApp())
      .post(`/api/workspace/upload?slug=${WS}&project=${PID}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ files: [{ name: "x.txt", content: "aGk=" }] });
    expect(r.status, r.text).toBe(409);
    expect(r.body.code).toBe("GITHUB_READ_ONLY");
  });
});
