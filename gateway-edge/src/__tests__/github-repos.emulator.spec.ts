import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getIdTokenForUid,
  setupEmulatorTest,
} from "@shared/test-helpers/firestore-emulator.js";

import { createApp } from "../index.js";
import { db } from "../lib/db.js";
import { _setKmsClientForTesting, type KmsClient } from "../lib/kms.js";

setupEmulatorTest({
  env: {
    OCTOGEE_KMS_KEY_NAME:
      "projects/octogee-test/locations/us-central1/keyRings/test/cryptoKeys/test",
  },
});

const UID = "gh-repos-uid";
const USERNAME = "ghreposowner";

function deterministicMockKms(): KmsClient {
  return {
    encrypt: vi.fn(async ({ plaintext }) => [
      { ciphertext: Buffer.concat([Buffer.from("ENC:"), Buffer.from(plaintext)]) },
    ] as [{ ciphertext: Buffer }]) as unknown as KmsClient["encrypt"],
    decrypt: vi.fn(async ({ ciphertext }) => [
      { plaintext: Buffer.from(ciphertext).slice(4) },
    ] as [{ plaintext: Buffer }]) as unknown as KmsClient["decrypt"],
  };
}

async function seed(role: "user" | "admin"): Promise<void> {
  await db.collection("workspaces").doc(USERNAME).set({ id: USERNAME, slug: USERNAME, ownerUid: UID });
  await db.collection("users").doc(UID).set({ uid: UID, username: USERNAME, workspaceId: USERNAME });
  await db.collection("users").doc(UID).collection("system").doc("config").set({ role });
}

async function seedGithubConnection(): Promise<void> {
  await db.collection("users").doc(UID).collection("secrets").doc("github").set({
    provider: "github",
    tokens: {
      encryptedAccessToken: Buffer.concat([
        Buffer.from("ENC:"),
        Buffer.from("gho_callers_own_token"),
      ]).toString("base64"),
      encryptedRefreshToken: null,
      tokenType: "bearer",
    },
  });
}

beforeEach(() => {
  _setKmsClientForTesting(deterministicMockKms());
});

afterEach(() => {
  _setKmsClientForTesting(null);
  vi.restoreAllMocks();
});

// Guards the canary against the mount it actually rides: the picker calls the
// gateway-locality path /api/g/<id>/workspace/github/repos. A 403/422 here (not
// 404) proves the route is mounted; an unmounted route would 404 the picker.
describe("GET /workspace/github/repos — mounted + caller's own connection", () => {
  it("403s a non-admin (route reachable, not 404)", async () => {
    await seed("user");
    const token = await getIdTokenForUid(UID);
    const r = await request(createApp())
      .get("/api/g/test/workspace/github/repos")
      .set("Authorization", `Bearer ${token}`);
    expect(r.status, r.text).toBe(403);
  });

  it("422 github_not_connected for an admin without a github connection", async () => {
    await seed("admin");
    const token = await getIdTokenForUid(UID);
    const r = await request(createApp())
      .get("/api/g/test/workspace/github/repos")
      .set("Authorization", `Bearer ${token}`);
    expect(r.status, r.text).toBe(422);
    expect(r.body.reason).toBe("github_not_connected");
  });

  it("lists repos with the caller's own decrypted token", async () => {
    await seed("admin");
    await seedGithubConnection();

    const realFetch: typeof fetch = globalThis.fetch.bind(globalThis);
    let seenAuth: string | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation((async (
      url: string | URL,
      init?: RequestInit,
    ) => {
      const u = String(url);
      if (u.includes("127.0.0.1") || u.includes("localhost")) return realFetch(u, init);
      expect(u).toContain("api.github.com/user/repos");
      seenAuth = ((init?.headers ?? {}) as Record<string, string>).Authorization;
      return new Response(
        JSON.stringify([
          {
            name: "octogee",
            full_name: "octogee-ai/octogee",
            private: true,
            description: "Eight arms. One dream.",
            updated_at: "2026-06-01T00:00:00Z",
            owner: { login: "octogee-ai" },
          },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch);

    const token = await getIdTokenForUid(UID);
    const r = await request(createApp())
      .get("/api/g/test/workspace/github/repos")
      .set("Authorization", `Bearer ${token}`);

    expect(r.status, r.text).toBe(200);
    expect(seenAuth).toBe("Bearer gho_callers_own_token");
    expect(r.body.repos).toEqual([
      {
        owner: "octogee-ai",
        repo: "octogee",
        fullName: "octogee-ai/octogee",
        private: true,
        description: "Eight arms. One dream.",
        updatedAt: "2026-06-01T00:00:00Z",
      },
    ]);
  });
});
