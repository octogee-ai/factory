/**
 * Integration tests for /api/projects — v3 nested + user-named slug schema.
 *
 * This file was pared down when projects moved from top-level `/projects/{id}`
 * to `workspaces/{wid}/projects/{pid}` with channels + members subcollections
 * (DATA-MODEL-REVIEW v3 §§6.3, 6.10, 6.11, 6.12). A comprehensive integration
 * rewrite is tracked as a P1 follow-up (see the PR body).
 *
 * Coverage here is intentionally minimal: the slug validator + the availability
 * check endpoint, which are pure server-side guards not covered by any other
 * test. End-to-end project create/join/leave/star behavior is validated via
 * manual flows post-provisioning until the new-shape integration tests land.
 */
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Minimal mock — only enough for the availability endpoint.
const firestoreData: Record<string, any> = {};

vi.mock("../lib/db", () => ({
  auth: {
    verifyIdToken: vi.fn().mockResolvedValue({ uid: "caller-uid" }),
  },
  db: {
    doc: (path: string) => ({
      get: async () => ({
        exists: !!firestoreData[path],
        data: () => firestoreData[path],
      }),
    }),
    collection: (_name: string) => ({
      doc: (_id: string) => ({ get: async () => ({ exists: false }) }),
    }),
  },
  FieldValue: { serverTimestamp: () => "now" },
}));

vi.mock("../lib/mattermost", () => ({ mmApi: vi.fn() }));
vi.mock("../lib/gitea", () => ({ giteaApi: vi.fn() }));

import { createApp } from "../index";

function authHeaders() {
  return { Authorization: "Bearer valid-token" };
}

describe("GET /api/projects/slug-available", () => {
  beforeEach(() => {
    firestoreData["users/caller-uid"] = { username: "alice", workspaceId: "alice" };
  });

  it("rejects slugs that violate the regex", async () => {
    const app = createApp();
    const res = await request(app)
      .get("/api/projects/slug-available?slug=1bad")
      .set(authHeaders());
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(false);
    expect(res.body.reason).toMatch(/start with a letter/);
  });

  it("rejects reserved slugs", async () => {
    const app = createApp();
    const res = await request(app)
      .get("/api/projects/slug-available?slug=settings")
      .set(authHeaders());
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(false);
    expect(res.body.reason).toMatch(/reserved/);
  });

  it("rejects too-short slugs", async () => {
    const app = createApp();
    const res = await request(app)
      .get("/api/projects/slug-available?slug=ab")
      .set(authHeaders());
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(false);
  });

  it("rejects too-long slugs (>16 chars)", async () => {
    const app = createApp();
    const res = await request(app)
      .get("/api/projects/slug-available?slug=seventeen-chars-x")
      .set(authHeaders());
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(false);
  });

  it("returns available=true for a valid, unclaimed slug", async () => {
    const app = createApp();
    const res = await request(app)
      .get("/api/projects/slug-available?slug=my-game")
      .set(authHeaders());
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
  });
});
