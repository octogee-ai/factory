import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";

import {
  getIdTokenForUid,
  setupEmulatorTest,
} from "@shared/test-helpers/firestore-emulator.js";

import { createApp } from "../index.js";
import { db } from "../lib/db.js";

setupEmulatorTest();

const UID = "gh-repos-uid";
const USERNAME = "ghreposowner";

async function seed(role: "user" | "admin"): Promise<void> {
  await db.collection("workspaces").doc(USERNAME).set({ id: USERNAME, slug: USERNAME, ownerUid: UID });
  await db.collection("users").doc(UID).set({ uid: UID, username: USERNAME, workspaceId: USERNAME });
  await db.collection("users").doc(UID).collection("system").doc("config").set({ role });
}

beforeEach(() => {
  delete process.env.GITHUB_TOKEN;
});

// Guards the canary against the mount it actually rides: the picker calls the
// gateway-locality path /api/g/<id>/workspace/github/repos. A 403/422 here (not
// 404) proves the route is mounted; an unmounted route would 404 the picker.
describe("GET /workspace/github/repos — mounted + admin-gated", () => {
  it("403s a non-admin (route reachable, not 404)", async () => {
    await seed("user");
    const token = await getIdTokenForUid(UID);
    const r = await request(createApp())
      .get("/api/g/test/workspace/github/repos")
      .set("Authorization", `Bearer ${token}`);
    expect(r.status, r.text).toBe(403);
  });

  it("422 github_token_unset for an admin when no GITHUB_TOKEN is set", async () => {
    await seed("admin");
    const token = await getIdTokenForUid(UID);
    const r = await request(createApp())
      .get("/api/g/test/workspace/github/repos")
      .set("Authorization", `Bearer ${token}`);
    expect(r.status, r.text).toBe(422);
    expect(r.body.reason).toBe("github_token_unset");
  });
});
