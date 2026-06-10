import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";

import {
  getIdTokenForUid,
  setupEmulatorTest,
} from "@shared/test-helpers/firestore-emulator.js";

import { createApp } from "../index.js";
import { db } from "../lib/db.js";

setupEmulatorTest();

const UID = "ro-uid";
const WS = "rowsowner";
const PID = "ghproj";

async function seedGithubProject(): Promise<void> {
  await db.collection("workspaces").doc(WS).set({ id: WS, slug: WS, ownerUid: UID });
  await db.collection("users").doc(UID).set({ uid: UID, username: WS, workspaceId: WS });
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

// A GitHub-backed project shares withFileTarget routing, so every non-read
// route must refuse it — otherwise /upload + /delete-blob would write to Gitea
// under the GitHub owner/repo names, and /git/* would touch a non-existent
// local checkout. PR1 is read-only.
describe("GitHub-backed projects are read-only", () => {
  let token = "";
  beforeEach(async () => {
    await seedGithubProject();
    token = await getIdTokenForUid(UID);
  });

  it("/git/status refuses a github target (409)", async () => {
    const r = await request(createApp())
      .get(`/api/g/test/workspace/git/status?slug=${WS}&project=${PID}`)
      .set("Authorization", `Bearer ${token}`);
    expect(r.status, r.text).toBe(409);
    expect(r.body.code).toBe("GITHUB_READ_ONLY");
  });

  it("/upload refuses a github target (409)", async () => {
    const r = await request(createApp())
      .post(`/api/workspace/upload?slug=${WS}&project=${PID}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ files: [{ name: "x.txt", content: "aGk=" }] });
    expect(r.status, r.text).toBe(409);
    expect(r.body.code).toBe("GITHUB_READ_ONLY");
  });
});
