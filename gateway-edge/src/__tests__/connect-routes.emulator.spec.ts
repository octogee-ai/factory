import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

import {
  setupEmulatorTest,
  useAuthToken,
} from "@octogee/test-helpers/firestore-emulator";
import { db } from "../lib/db.js";
import { _setKmsClientForTesting, type KmsClient } from "../lib/kms.js";
import { generateConnectState } from "../lib/connect-state.js";

const UID = "uid-connect-test";
const OTHER_UID = "uid-connect-other";
const PLAINTEXT_GH_TOKEN = "gho_PLAINTEXT-github-oauth-token";
const PLAINTEXT_GH_PAT = "ghp_PLAINTEXT-github-pat-token";
const PLAINTEXT_GOOGLE_ACCESS = "ya29.PLAINTEXT-google-access";
const PLAINTEXT_GOOGLE_REFRESH = "1//PLAINTEXT-google-refresh";
const PLAINTEXT_MS_ACCESS = "EwB-PLAINTEXT-microsoft-access";

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

function encOf(plaintext: string): string {
  return Buffer.concat([Buffer.from("ENC:"), Buffer.from(plaintext)]).toString("base64");
}

const { createApp } = await import("../index.js");
const { default: connectRoutes } = await import("../routes/connect.js");

type RouteLayer = {
  route?: {
    path: string;
    methods: Record<string, boolean>;
  };
};

function routeSignatures(router: unknown): string[] {
  const stack = (router as { stack: RouteLayer[] }).stack;
  return stack
    .filter((layer) => layer.route)
    .map((layer) => {
      const route = layer.route;
      if (!route) throw new Error("expected route layer");
      const methods = Object.entries(route.methods)
        .filter(([, enabled]) => enabled)
        .map(([method]) => method.toUpperCase())
        .sort()
        .join(",");
      return `${methods} ${route.path}`;
    });
}

setupEmulatorTest({
  env: {
    OCTOGEE_KMS_KEY_NAME:
      "projects/octogee-test/locations/us-central1/keyRings/test/cryptoKeys/test",
    CONNECT_STATE_SECRET: "test-connect-state-secret",
    GITHUB_CLIENT_ID: "gh-client-id",
    GITHUB_CLIENT_SECRET: "gh-client-secret",
    GOOGLE_CLIENT_ID: "google-client-id",
    GOOGLE_CLIENT_SECRET: "google-client-secret",
    GOOGLE_PICKER_API_KEY: "picker-key",
    GOOGLE_PICKER_APP_ID: "123456789",
    MICROSOFT_CLIENT_ID: "ms-client-id",
    MICROSOFT_CLIENT_SECRET: "ms-client-secret",
  },
});
const auth = useAuthToken(UID);
const otherAuth = useAuthToken(OTHER_UID);

const realFetch: typeof fetch = globalThis.fetch.bind(globalThis);

interface ProviderStub {
  url: RegExp;
  respond: (init?: RequestInit) => unknown;
}

function stubProviderFetch(stubs: ProviderStub[]): { calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation((async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    const u = String(url);
    if (u.includes("127.0.0.1") || u.includes("localhost")) {
      return realFetch(url as string, init);
    }
    calls.push({ url: u, init });
    const stub = stubs.find((s) => s.url.test(u));
    if (!stub) throw new Error(`unexpected fetch: ${u}`);
    return new Response(JSON.stringify(stub.respond(init)), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch);
  return { calls };
}

const githubHappyStubs: ProviderStub[] = [
  {
    url: /github\.com\/login\/oauth\/access_token/,
    respond: (init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers.Accept).toBe("application/json");
      return { access_token: PLAINTEXT_GH_TOKEN, token_type: "bearer", scope: "repo" };
    },
  },
  { url: /api\.github\.com\/user$/, respond: () => ({ login: "chris-e" }) },
];

beforeEach(() => {
  _setKmsClientForTesting(deterministicMockKms());
});

afterEach(() => {
  _setKmsClientForTesting(null);
  vi.restoreAllMocks();
});

async function readSecret(uid: string, provider: string): Promise<Record<string, unknown> | undefined> {
  const snap = await db.collection("users").doc(uid).collection("secrets").doc(provider).get();
  return snap.data();
}

async function readStatus(uid: string, provider: string): Promise<Record<string, unknown> | undefined> {
  const snap = await db.collection("users").doc(uid).collection("integrations").doc(provider).get();
  return snap.data();
}

async function mintAuthUrlState(
  connector = "github",
  query = "",
): Promise<{ state: string; url: string }> {
  const res = await request(createApp())
    .get(`/api/connect/${connector}/auth-url?returnUrl=/w/me/files${query}`)
    .set("Authorization", auth.bearer());
  expect(res.status, res.text).toBe(200);
  const url = res.body.url as string;
  const state = new URL(url).searchParams.get("state")!;
  expect(state).toBeTruthy();
  return { state, url };
}

async function setGoogleStage(
  stage: "off" | "allowlist" | "on",
  uids: string[] = [],
): Promise<void> {
  await db
    .collection("platformConfig")
    .doc("connect")
    .set({ googleStage: stage, googleAllowlistUids: uids });
}

describe("connect route module", () => {
  it("exports the connector endpoints covered by this emulator suite (the per-user client route is gone)", () => {
    expect(routeSignatures(connectRoutes)).toEqual([
      "POST /disconnect",
      "GET /availability",
      "POST /:connector/verify",
      "GET /google/picker-token",
      "POST /google/picked-files",
      "GET /:connector/auth-url",
      "GET /:connector/callback",
      "POST /:connector/pat",
      "POST /:connector/fields",
      "POST /:connector/device/start",
      "POST /:connector/device/poll",
    ]);
  });
});

describe("connect — auth-url", () => {
  it("requires auth (uid comes from the verified token, never a query param)", async () => {
    const res = await request(createApp()).get("/api/connect/github/auth-url");
    expect(res.status).toBe(401);
  });

  it("404s for catalog stubs, unknown ids and PAT-only connectors (no oauth-web)", async () => {
    for (const id of ["docker", "azure", "vercel", "nope"]) {
      const res = await request(createApp())
        .get(`/api/connect/${id}/auth-url`)
        .set("Authorization", auth.bearer());
      expect(res.status, id).toBe(404);
    }
  });

  it("503s for an oauth-capable connector whose platform client is not provisioned", async () => {
    const saved = process.env.MICROSOFT_CLIENT_ID;
    delete process.env.MICROSOFT_CLIENT_ID;
    try {
      const res = await request(createApp())
        .get("/api/connect/microsoft/auth-url")
        .set("Authorization", auth.bearer());
      expect(res.status).toBe(503);
    } finally {
      if (saved !== undefined) process.env.MICROSOFT_CLIENT_ID = saved;
    }
  });

  it("builds the provider authorize URL with a signed state and persists the single-use flow doc", async () => {
    const authUrlResponse = await request(createApp())
      .get("/api/connect/github/auth-url?returnUrl=/w/me/files")
      .set("Authorization", auth.bearer());
    expect(authUrlResponse.status, authUrlResponse.text).toBe(200);
    expect(authUrlResponse.headers["cache-control"]).toContain("no-store");
    const url = authUrlResponse.body.url as string;
    const state = new URL(url).searchParams.get("state")!;

    expect(url).toContain("https://github.com/login/oauth/authorize?");
    const parsed = new URL(url);
    expect(parsed.searchParams.get("client_id")).toBe("gh-client-id");
    expect(parsed.searchParams.get("scope")).toBe("repo");
    expect(parsed.searchParams.get("redirect_uri")).toContain("/api/connect/github/callback");

    const payloadStr = state.split(".")[0];
    const payload = JSON.parse(Buffer.from(payloadStr, "base64url").toString("utf-8"));
    expect(payload.uid).toBe(UID);
    expect(payload.connector).toBe("github");
    expect(payload.returnUrl).toBe("/w/me/files");

    const flow = await db.collection("connectFlows").doc(payload.nonce).get();
    expect(flow.exists).toBe(true);
    expect(flow.data()?.uid).toBe(UID);
    expect(flow.data()?.connector).toBe("github");
  });

  it("fails loud (503) when the connector client id is not provisioned", async () => {
    const saved = process.env.GITHUB_CLIENT_ID;
    delete process.env.GITHUB_CLIENT_ID;
    const res = await request(createApp())
      .get("/api/connect/github/auth-url")
      .set("Authorization", auth.bearer());
    process.env.GITHUB_CLIENT_ID = saved;
    expect(res.status).toBe(503);
  });

  it("google auth-url also requires auth — the old unsigned ?uid= mint is gone", async () => {
    const res = await request(createApp()).get("/api/connect/google/auth-url?uid=u-victim");
    expect(res.status).toBe(401);
  });
});

describe("connect — callback state verification (the security regression)", () => {
  it("rejects a forged unsigned state (the old integrations.ts shape) and stores nothing", async () => {
    stubProviderFetch(githubHappyStubs);
    const forged = Buffer.from(JSON.stringify({ uid: UID, returnUrl: "/dashboard" })).toString(
      "base64url",
    );
    const res = await request(createApp()).get(
      `/api/connect/github/callback?code=evil&state=${forged}`,
    );
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("connect_error=invalid_state");
    expect(await readSecret(UID, "github")).toBeUndefined();
  });

  it("rejects an expired state", async () => {
    stubProviderFetch(githubHappyStubs);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() - 11 * 60 * 1000);
    const { state } = generateConnectState({ uid: UID, connector: "github", returnUrl: "/d" });
    vi.useRealTimers();

    const res = await request(createApp()).get(
      `/api/connect/github/callback?code=c&state=${encodeURIComponent(state)}`,
    );
    expect(res.headers.location).toContain("connect_error=invalid_state");
    expect(await readSecret(UID, "github")).toBeUndefined();
  });

  it("rejects a signed state without a persisted flow doc (mint must go through auth-url)", async () => {
    stubProviderFetch(githubHappyStubs);
    const { state } = generateConnectState({ uid: UID, connector: "github", returnUrl: "/d" });
    const res = await request(createApp()).get(
      `/api/connect/github/callback?code=c&state=${encodeURIComponent(state)}`,
    );
    expect(res.headers.location).toContain("connect_error=invalid_state");
    expect(await readSecret(UID, "github")).toBeUndefined();
  });

  it("rejects a state minted for a different connector", async () => {
    stubProviderFetch(githubHappyStubs);
    await setGoogleStage("on");
    const { state } = await mintAuthUrlState("google", "&capability=calendar");
    const res = await request(createApp()).get(
      `/api/connect/github/callback?code=c&state=${encodeURIComponent(state)}`,
    );
    expect(res.headers.location).toContain("connect_error=invalid_state");
    expect(await readSecret(UID, "github")).toBeUndefined();
  });

  it("stores KMS-encrypted tokens + connected status on a valid state, then rejects the replay", async () => {
    stubProviderFetch(githubHappyStubs);
    const { state } = await mintAuthUrlState();

    const res = await request(createApp()).get(
      `/api/connect/github/callback?code=good-code&state=${encodeURIComponent(state)}`,
    );
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("github_connected=true");
    expect(res.headers.location).not.toContain("chris-e");
    expect(res.headers.location).toContain("/w/me/files");

    const secret = await readSecret(UID, "github");
    expect(JSON.stringify(secret)).not.toContain(PLAINTEXT_GH_TOKEN);
    const tokens = (secret as Record<string, Record<string, unknown>>).tokens;
    expect(tokens.encryptedAccessToken).toBe(encOf(PLAINTEXT_GH_TOKEN));
    expect(tokens.encryptedRefreshToken).toBeUndefined();

    const status = await readStatus(UID, "github");
    expect(status).toMatchObject({
      provider: "github",
      status: "connected",
      accountLabel: "chris-e",
      captureMethod: "oauth-web",
      scopes: ["repo"],
    });

    // replay: same state again — nonce already consumed
    await db.collection("users").doc(UID).collection("secrets").doc("github").delete();
    const replay = await request(createApp()).get(
      `/api/connect/github/callback?code=good-code&state=${encodeURIComponent(state)}`,
    );
    expect(replay.headers.location).toContain("connect_error=invalid_state");
    expect(await readSecret(UID, "github")).toBeUndefined();
  });

  it("redirects with cancelled (and stores nothing) when the provider returns an error", async () => {
    stubProviderFetch(githubHappyStubs);
    const { state } = await mintAuthUrlState();
    const res = await request(createApp()).get(
      `/api/connect/github/callback?error=access_denied&state=${encodeURIComponent(state)}`,
    );
    expect(res.headers.location).toContain("connect_error=cancelled");
    expect(await readSecret(UID, "github")).toBeUndefined();
  });

  it("marks the integration errored when the token exchange fails", async () => {
    stubProviderFetch([
      {
        url: /github\.com\/login\/oauth\/access_token/,
        respond: () => ({ error: "bad_verification_code" }),
      },
    ]);
    const { state } = await mintAuthUrlState();
    const res = await request(createApp()).get(
      `/api/connect/github/callback?code=stale&state=${encodeURIComponent(state)}`,
    );
    expect(res.headers.location).toContain("connect_error=github_failed");
    expect(await readSecret(UID, "github")).toBeUndefined();
    expect((await readStatus(UID, "github"))?.status).toBe("error");
  });
});

describe("connect — PAT capture", () => {
  it("requires auth", async () => {
    const res = await request(createApp())
      .post("/api/connect/github/pat")
      .send({ token: PLAINTEXT_GH_PAT });
    expect(res.status).toBe(401);
  });

  it("404s for connectors without PAT capture (google is oauth-web only)", async () => {
    const res = await request(createApp())
      .post("/api/connect/google/pat")
      .set("Authorization", auth.bearer())
      .send({ token: "x" });
    expect(res.status).toBe(404);
  });

  it("rejects a PAT the provider rejects, storing nothing", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((async (url: string | URL) => {
      const u = String(url);
      if (u.includes("127.0.0.1") || u.includes("localhost")) return realFetch(u);
      return new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 });
    }) as typeof fetch);

    const res = await request(createApp())
      .post("/api/connect/github/pat")
      .set("Authorization", auth.bearer())
      .send({ token: "ghp_bad" });
    expect(res.status).toBe(400);
    expect(await readSecret(UID, "github")).toBeUndefined();
  });

  it("validates against the connector identity and stores the encrypted PAT", async () => {
    stubProviderFetch([{ url: /api\.github\.com\/user$/, respond: () => ({ login: "pat-user" }) }]);

    const res = await request(createApp())
      .post("/api/connect/github/pat")
      .set("Authorization", auth.bearer())
      .send({ token: PLAINTEXT_GH_PAT });
    expect(res.status).toBe(200);
    expect(res.body.accountLabel).toBe("pat-user");

    const secret = await readSecret(UID, "github");
    expect(JSON.stringify(secret)).not.toContain(PLAINTEXT_GH_PAT);
    expect((secret as Record<string, Record<string, unknown>>).tokens.encryptedAccessToken).toBe(
      encOf(PLAINTEXT_GH_PAT),
    );
    expect((await readStatus(UID, "github"))?.captureMethod).toBe("pat");
  });
});

describe("connect — device flow", () => {
  it("start: requires auth, creates the flow doc, returns the user code", async () => {
    const unauthed = await request(createApp()).post("/api/connect/github/device/start");
    expect(unauthed.status).toBe(401);

    stubProviderFetch([
      {
        url: /github\.com\/login\/device\/code/,
        respond: () => ({
          device_code: "dc-secret-1",
          user_code: "ABCD-1234",
          verification_uri: "https://github.com/login/device",
          expires_in: 900,
          interval: 5,
        }),
      },
    ]);

    const res = await request(createApp())
      .post("/api/connect/github/device/start")
      .set("Authorization", auth.bearer());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      userCode: "ABCD-1234",
      verificationUri: "https://github.com/login/device",
      interval: 5,
    });

    const flow = await db.collection("connectFlows").doc(res.body.flowId).get();
    expect(flow.exists).toBe(true);
    expect(flow.data()).toMatchObject({ uid: UID, connector: "github", kind: "device" });
  });

  async function startDeviceFlow(): Promise<string> {
    stubProviderFetch([
      {
        url: /github\.com\/login\/device\/code/,
        respond: () => ({
          device_code: "dc-secret-2",
          user_code: "EFGH-5678",
          verification_uri: "https://github.com/login/device",
          expires_in: 900,
          interval: 5,
        }),
      },
    ]);
    const res = await request(createApp())
      .post("/api/connect/github/device/start")
      .set("Authorization", auth.bearer());
    expect(res.status).toBe(200);
    vi.restoreAllMocks();
    _setKmsClientForTesting(deterministicMockKms());
    return res.body.flowId as string;
  }

  it("poll: pending → connected with encrypted token, then the flow is consumed", async () => {
    const flowId = await startDeviceFlow();

    const tokenResponses: unknown[] = [
      { error: "authorization_pending" },
      { access_token: PLAINTEXT_GH_TOKEN, token_type: "bearer", scope: "repo" },
    ];
    stubProviderFetch([
      { url: /github\.com\/login\/oauth\/access_token/, respond: () => tokenResponses.shift() },
      { url: /api\.github\.com\/user$/, respond: () => ({ login: "device-user" }) },
    ]);

    const pending = await request(createApp())
      .post("/api/connect/github/device/poll")
      .set("Authorization", auth.bearer())
      .send({ flowId });
    expect(pending.body).toEqual({ status: "pending" });
    expect(await readSecret(UID, "github")).toBeUndefined();

    const granted = await request(createApp())
      .post("/api/connect/github/device/poll")
      .set("Authorization", auth.bearer())
      .send({ flowId });
    expect(granted.body).toEqual({ status: "connected", accountLabel: "device-user" });

    const secret = await readSecret(UID, "github");
    expect(JSON.stringify(secret)).not.toContain(PLAINTEXT_GH_TOKEN);
    expect((await readStatus(UID, "github"))?.captureMethod).toBe("device");

    const consumed = await request(createApp())
      .post("/api/connect/github/device/poll")
      .set("Authorization", auth.bearer())
      .send({ flowId });
    expect(consumed.status).toBe(404);
  });

  it("poll: another user's flowId is not found", async () => {
    const flowId = await startDeviceFlow();
    const res = await request(createApp())
      .post("/api/connect/github/device/poll")
      .set("Authorization", otherAuth.bearer())
      .send({ flowId });
    expect(res.status).toBe(404);
  });

  it("poll: access_denied fails and consumes the flow", async () => {
    const flowId = await startDeviceFlow();
    stubProviderFetch([
      { url: /github\.com\/login\/oauth\/access_token/, respond: () => ({ error: "access_denied" }) },
    ]);

    const res = await request(createApp())
      .post("/api/connect/github/device/poll")
      .set("Authorization", auth.bearer())
      .send({ flowId });
    expect(res.body).toMatchObject({ status: "failed", reason: "access_denied" });

    const again = await request(createApp())
      .post("/api/connect/github/device/poll")
      .set("Authorization", auth.bearer())
      .send({ flowId });
    expect(again.status).toBe(404);
  });
});

describe("connect — multi-field credential capture (azure)", () => {
  const AZURE_FIELDS = {
    tenantId: "11111111-2222-3333-4444-555555555555",
    clientId: "abcd1234-app-client-id",
    clientSecret: "SP-PLAINTEXT-secret",
  };

  it("requires auth, rejects token connectors and partial bodies", async () => {
    expect(
      (await request(createApp()).post("/api/connect/azure/fields").send({ fields: AZURE_FIELDS }))
        .status,
    ).toBe(401);
    expect(
      (
        await request(createApp())
          .post("/api/connect/github/fields")
          .set("Authorization", auth.bearer())
          .send({ fields: { x: "y" } })
      ).status,
    ).toBe(404);
    const partial = await request(createApp())
      .post("/api/connect/azure/fields")
      .set("Authorization", auth.bearer())
      .send({ fields: { tenantId: AZURE_FIELDS.tenantId } });
    expect(partial.status).toBe(400);
    expect(await readSecret(UID, "azure")).toBeUndefined();
  });

  it("validates against the provider, stores every field KMS-encrypted, verify round-trips and heals", async () => {
    stubProviderFetch([
      {
        url: /login\.microsoftonline\.com/,
        respond: () => ({ access_token: "az-mgmt-token" }),
      },
    ]);
    const res = await request(createApp())
      .post("/api/connect/azure/fields")
      .set("Authorization", auth.bearer())
      .send({ fields: AZURE_FIELDS });
    expect(res.status, res.text).toBe(200);
    expect(res.body.accountLabel).toContain("abcd1234");

    const secret = await readSecret(UID, "azure");
    const body = JSON.stringify(secret);
    expect(body).not.toContain(AZURE_FIELDS.clientSecret);
    expect(body).not.toContain(AZURE_FIELDS.clientId);
    const fields = (secret as Record<string, Record<string, string>>).fields;
    expect(fields.clientSecret).toBe(encOf(AZURE_FIELDS.clientSecret));
    expect(fields.tenantId).toBe(encOf(AZURE_FIELDS.tenantId));
    expect((await readStatus(UID, "azure"))?.captureMethod).toBe("fields");

    const verified = await request(createApp())
      .post("/api/connect/azure/verify")
      .set("Authorization", auth.bearer());
    expect(verified.status, verified.text).toBe(200);
    expect(verified.body.ok).toBe(true);
    expect((await readStatus(UID, "azure"))?.verifiedAt).toBeTruthy();
  });

  it("verify flags provider rejection and a later success heals the error state", async () => {
    stubProviderFetch([
      { url: /login\.microsoftonline\.com/, respond: () => ({ access_token: "az-tok" }) },
    ]);
    await request(createApp())
      .post("/api/connect/azure/fields")
      .set("Authorization", auth.bearer())
      .send({ fields: AZURE_FIELDS });

    vi.restoreAllMocks();
    _setKmsClientForTesting(deterministicMockKms());
    const realFetch2: typeof fetch = globalThis.fetch.bind(globalThis);
    vi.spyOn(globalThis, "fetch").mockImplementation((async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("127.0.0.1") || u.includes("localhost")) return realFetch2(u, init);
      return new Response(JSON.stringify({ error: "invalid_client" }), { status: 401 });
    }) as typeof fetch);

    const failed = await request(createApp())
      .post("/api/connect/azure/verify")
      .set("Authorization", auth.bearer());
    expect(failed.status).toBe(502);
    expect((await readStatus(UID, "azure"))?.status).toBe("error");

    vi.restoreAllMocks();
    _setKmsClientForTesting(deterministicMockKms());
    stubProviderFetch([
      { url: /login\.microsoftonline\.com/, respond: () => ({ access_token: "az-tok-2" }) },
    ]);
    const healed = await request(createApp())
      .post("/api/connect/azure/verify")
      .set("Authorization", auth.bearer());
    expect(healed.status, healed.text).toBe(200);
    const status = await readStatus(UID, "azure");
    expect(status?.status).toBe("connected");
    expect(status?.error).toBeUndefined();
  });
});

describe("connect — disconnect", () => {
  it("requires auth and a known connector", async () => {
    expect((await request(createApp()).post("/api/connect/disconnect").send({ connector: "github" })).status).toBe(401);
    const bad = await request(createApp())
      .post("/api/connect/disconnect")
      .set("Authorization", auth.bearer())
      .send({ connector: "nope" });
    expect(bad.status).toBe(400);
  });

  it("deletes the secret and flips status to disconnected", async () => {
    stubProviderFetch([{ url: /api\.github\.com\/user$/, respond: () => ({ login: "pat-user" }) }]);
    await request(createApp())
      .post("/api/connect/github/pat")
      .set("Authorization", auth.bearer())
      .send({ token: PLAINTEXT_GH_PAT });
    expect(await readSecret(UID, "github")).toBeDefined();

    const res = await request(createApp())
      .post("/api/connect/disconnect")
      .set("Authorization", auth.bearer())
      .send({ connector: "github" });
    expect(res.status).toBe(200);
    expect(await readSecret(UID, "github")).toBeUndefined();
    expect((await readStatus(UID, "github"))?.status).toBe("disconnected");
  });
});

describe("connect — google platform capability flow", () => {
  const CAL = "https://www.googleapis.com/auth/calendar.events";
  const GMAIL = "https://www.googleapis.com/auth/gmail.modify";
  const DRIVE = "https://www.googleapis.com/auth/drive.file";
  const EMAIL = "https://www.googleapis.com/auth/userinfo.email";

  function googleTokenStub(grantedScope: string): ProviderStub {
    return {
      url: /oauth2\.googleapis\.com\/token/,
      respond: () => ({
        access_token: PLAINTEXT_GOOGLE_ACCESS,
        refresh_token: PLAINTEXT_GOOGLE_REFRESH,
        expires_in: 3600,
        token_type: "Bearer",
        scope: grantedScope,
      }),
    };
  }
  const googleUserinfoStub: ProviderStub = {
    url: /googleapis\.com\/oauth2\/v2\/userinfo/,
    respond: () => ({ email: "g@x.com" }),
  };

  async function connectGoogle(capability: string, grantedScope: string): Promise<void> {
    stubProviderFetch([googleTokenStub(grantedScope), googleUserinfoStub]);
    const { state } = await mintAuthUrlState("google", `&capability=${capability}`);
    const res = await request(createApp()).get(
      `/api/connect/google/callback?code=c&state=${encodeURIComponent(state)}`,
    );
    expect(res.headers.location).toContain("google_connected=true");
    vi.restoreAllMocks();
    _setKmsClientForTesting(deterministicMockKms());
  }

  it("enforces the connect-stage dial server-side: dark by default, allowlist admits listed uids only", async () => {
    const dark = await request(createApp())
      .get("/api/connect/google/auth-url?capability=calendar")
      .set("Authorization", auth.bearer());
    expect(dark.status).toBe(403);
    expect(dark.body.error).toBe("pending_verification");

    await setGoogleStage("off", [UID]);
    const off = await request(createApp())
      .get("/api/connect/google/auth-url?capability=calendar")
      .set("Authorization", auth.bearer());
    expect(off.status).toBe(403);

    await setGoogleStage("allowlist", [UID]);
    const allowed = await request(createApp())
      .get("/api/connect/google/auth-url?capability=calendar")
      .set("Authorization", auth.bearer());
    expect(allowed.status, allowed.text).toBe(200);

    const denied = await request(createApp())
      .get("/api/connect/google/auth-url?capability=calendar")
      .set("Authorization", otherAuth.bearer());
    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe("pending_verification");
  });

  it("the dial gates only google — github mints regardless of the connect doc", async () => {
    await setGoogleStage("off");
    await mintAuthUrlState("github");
  });

  it("requires a known capability", async () => {
    await setGoogleStage("on");
    const missing = await request(createApp())
      .get("/api/connect/google/auth-url")
      .set("Authorization", auth.bearer());
    expect(missing.status).toBe(400);
    const unknown = await request(createApp())
      .get("/api/connect/google/auth-url?capability=voice")
      .set("Authorization", auth.bearer());
    expect(unknown.status).toBe(400);
  });

  it("503s when the platform client env is unset or the literal placeholder", async () => {
    await setGoogleStage("on");
    const savedId = process.env.GOOGLE_CLIENT_ID;
    const savedSecret = process.env.GOOGLE_CLIENT_SECRET;
    try {
      delete process.env.GOOGLE_CLIENT_ID;
      delete process.env.GOOGLE_CLIENT_SECRET;
      const unset = await request(createApp())
        .get("/api/connect/google/auth-url?capability=calendar")
        .set("Authorization", auth.bearer());
      expect(unset.status).toBe(503);

      process.env.GOOGLE_CLIENT_ID = "placeholder";
      process.env.GOOGLE_CLIENT_SECRET = "placeholder";
      const placeholder = await request(createApp())
        .get("/api/connect/google/auth-url?capability=calendar")
        .set("Authorization", auth.bearer());
      expect(placeholder.status).toBe(503);
    } finally {
      process.env.GOOGLE_CLIENT_ID = savedId;
      process.env.GOOGLE_CLIENT_SECRET = savedSecret;
    }
  });

  it("mints a capability-scoped incremental-consent authorize URL on the platform client", async () => {
    await setGoogleStage("on");
    const { url } = await mintAuthUrlState("google", "&capability=gmail");
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(parsed.searchParams.get("client_id")).toBe("google-client-id");
    expect(parsed.searchParams.get("scope")).toBe(`${GMAIL} ${EMAIL}`);
    expect(parsed.searchParams.get("include_granted_scopes")).toBe("true");
    expect(parsed.searchParams.get("access_type")).toBe("offline");
    expect(parsed.searchParams.get("prompt")).toBe("consent");
  });

  it("scopes each capability card to its own bundle", async () => {
    await setGoogleStage("on");
    const calendar = await mintAuthUrlState("google", "&capability=calendar");
    expect(new URL(calendar.url).searchParams.get("scope")).toBe(`${CAL} ${EMAIL}`);
    const drive = await mintAuthUrlState("google", "&capability=drive");
    expect(new URL(drive.url).searchParams.get("scope")).toBe(`${DRIVE} ${EMAIL}`);
  });

  it("callback stores what Google actually granted — the accumulated scope set from the token response", async () => {
    await setGoogleStage("on");
    stubProviderFetch([googleTokenStub(`${CAL} ${GMAIL} ${EMAIL}`), googleUserinfoStub]);
    const { state } = await mintAuthUrlState("google", "&capability=gmail");
    const res = await request(createApp()).get(
      `/api/connect/google/callback?code=c&state=${encodeURIComponent(state)}`,
    );
    expect(res.headers.location).toContain("google_connected=true");

    const secret = await readSecret(UID, "google");
    const body = JSON.stringify(secret);
    expect(body).not.toContain(PLAINTEXT_GOOGLE_ACCESS);
    expect(body).not.toContain(PLAINTEXT_GOOGLE_REFRESH);
    const tokens = (secret as Record<string, Record<string, unknown>>).tokens;
    expect(tokens.encryptedAccessToken).toBe(encOf(PLAINTEXT_GOOGLE_ACCESS));
    expect(tokens.encryptedRefreshToken).toBe(encOf(PLAINTEXT_GOOGLE_REFRESH));
    expect(tokens.clientSource).toBeUndefined();

    const status = await readStatus(UID, "google");
    expect(status?.scopes).toEqual([CAL, GMAIL, EMAIL]);
    expect(status?.accountLabel).toBe("g@x.com");
  });

  it("incremental consent preserves the durable refresh token and Drive picked-file registry", async () => {
    await setGoogleStage("on");
    await connectGoogle("drive", `${DRIVE} ${EMAIL}`);
    await db
      .collection("users")
      .doc(UID)
      .collection("integrations")
      .doc("google")
      .set(
        { pickedFiles: [{ id: "f1", name: "Plan.pdf", mimeType: "application/pdf" }] },
        { merge: true },
      );

    stubProviderFetch([
      {
        url: /oauth2\.googleapis\.com\/token/,
        respond: () => ({
          access_token: "new-google-access",
          expires_in: 3600,
          token_type: "Bearer",
          scope: `${DRIVE} ${GMAIL} ${EMAIL}`,
        }),
      },
      googleUserinfoStub,
    ]);
    const { state } = await mintAuthUrlState("google", "&capability=gmail");
    const res = await request(createApp()).get(
      `/api/connect/google/callback?code=c&state=${encodeURIComponent(state)}`,
    );
    expect(res.headers.location).toContain("google_connected=true");

    const tokens = (await readSecret(UID, "google"))?.tokens as Record<string, unknown>;
    expect(tokens.encryptedAccessToken).toBe(encOf("new-google-access"));
    expect(tokens.encryptedRefreshToken).toBe(encOf(PLAINTEXT_GOOGLE_REFRESH));
    expect((await readStatus(UID, "google"))?.pickedFiles).toEqual([
      { id: "f1", name: "Plan.pdf", mimeType: "application/pdf" },
    ]);
  });

  it("rejects incremental consent from a different Google account without replacing the grant", async () => {
    await setGoogleStage("on");
    await connectGoogle("drive", `${DRIVE} ${EMAIL}`);
    await db
      .collection("users")
      .doc(UID)
      .collection("integrations")
      .doc("google")
      .set(
        { pickedFiles: [{ id: "f1", name: "Plan.pdf", mimeType: "application/pdf" }] },
        { merge: true },
      );

    stubProviderFetch([
      {
        url: /oauth2\.googleapis\.com\/token/,
        respond: () => ({
          access_token: "other-account-access",
          refresh_token: "other-account-refresh",
          expires_in: 3600,
          token_type: "Bearer",
          scope: `${DRIVE} ${GMAIL} ${EMAIL}`,
        }),
      },
      {
        url: /googleapis\.com\/oauth2\/v2\/userinfo/,
        respond: () => ({ email: "other@x.com" }),
      },
    ]);
    const { state } = await mintAuthUrlState("google", "&capability=gmail");
    const res = await request(createApp()).get(
      `/api/connect/google/callback?code=c&state=${encodeURIComponent(state)}`,
    );

    expect(res.headers.location).toContain("connect_error=google_account_mismatch");
    const tokens = (await readSecret(UID, "google"))?.tokens as Record<string, unknown>;
    expect(tokens.encryptedAccessToken).toBe(encOf(PLAINTEXT_GOOGLE_ACCESS));
    expect(tokens.encryptedRefreshToken).toBe(encOf(PLAINTEXT_GOOGLE_REFRESH));
    expect(await readStatus(UID, "google")).toMatchObject({
      status: "connected",
      accountLabel: "g@x.com",
      scopes: [DRIVE, EMAIL],
      pickedFiles: [{ id: "f1", name: "Plan.pdf", mimeType: "application/pdf" }],
    });
  });

  it("granular consent: an unticked data scope is absent from the stored grant", async () => {
    await setGoogleStage("on");
    await connectGoogle("gmail", EMAIL);
    const status = await readStatus(UID, "google");
    expect(status?.scopes).toEqual([EMAIL]);
  });

  it("disconnect revokes both stored tokens at Google, then deletes the whole secret", async () => {
    await setGoogleStage("on");
    await connectGoogle("calendar", `${CAL} ${EMAIL}`);

    const { calls } = stubProviderFetch([
      { url: /oauth2\.googleapis\.com\/revoke/, respond: () => ({}) },
    ]);
    const res = await request(createApp())
      .post("/api/connect/disconnect")
      .set("Authorization", auth.bearer())
      .send({ connector: "google" });
    expect(res.status, res.text).toBe(200);
    expect(calls.map((c) => String(c.init?.body))).toEqual([
      new URLSearchParams({ token: PLAINTEXT_GOOGLE_REFRESH }).toString(),
      new URLSearchParams({ token: PLAINTEXT_GOOGLE_ACCESS }).toString(),
    ]);
    expect(await readSecret(UID, "google")).toBeUndefined();
    expect((await readStatus(UID, "google"))?.status).toBe("disconnected");
  });

  it("falls back to the REQUESTED capability bundle when the token response omits scope", async () => {
    await setGoogleStage("on");
    stubProviderFetch([
      {
        url: /oauth2\.googleapis\.com\/token/,
        respond: () => ({
          access_token: PLAINTEXT_GOOGLE_ACCESS,
          refresh_token: PLAINTEXT_GOOGLE_REFRESH,
          expires_in: 3600,
          token_type: "Bearer",
        }),
      },
      googleUserinfoStub,
    ]);
    const { state } = await mintAuthUrlState("google", "&capability=calendar");
    await request(createApp()).get(
      `/api/connect/google/callback?code=c&state=${encodeURIComponent(state)}`,
    );
    const status = await readStatus(UID, "google");
    expect(status?.scopes).toEqual([CAL, EMAIL]);
  });

  it("PKCE: google mints an S256 challenge and the exchange presents the matching verifier; github does not", async () => {
    await setGoogleStage("on");
    let exchangeBody = "";
    stubProviderFetch([
      {
        url: /oauth2\.googleapis\.com\/token/,
        respond: (init) => {
          exchangeBody = String(init?.body);
          return {
            access_token: PLAINTEXT_GOOGLE_ACCESS,
            refresh_token: PLAINTEXT_GOOGLE_REFRESH,
            expires_in: 3600,
            token_type: "Bearer",
            scope: `${CAL} ${EMAIL}`,
          };
        },
      },
      googleUserinfoStub,
    ]);
    const { state, url } = await mintAuthUrlState("google", "&capability=calendar");
    const minted = new URL(url);
    const challenge = minted.searchParams.get("code_challenge")!;
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(minted.searchParams.get("code_challenge_method")).toBe("S256");

    await request(createApp()).get(
      `/api/connect/google/callback?code=c&state=${encodeURIComponent(state)}`,
    );
    const verifier = new URLSearchParams(exchangeBody).get("code_verifier")!;
    expect(verifier).toBeTruthy();
    const { createHash } = await import("crypto");
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(challenge);

    const gh = await mintAuthUrlState("github");
    expect(new URL(gh.url).searchParams.get("code_challenge")).toBeNull();
  });

  it("disconnect still deletes the local grant when the provider revoke fails", async () => {
    await setGoogleStage("on");
    await connectGoogle("calendar", `${CAL} ${EMAIL}`);

    const passthrough: typeof fetch = globalThis.fetch.bind(globalThis);
    vi.spyOn(globalThis, "fetch").mockImplementation((async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      const u = String(url);
      if (u.includes("127.0.0.1") || u.includes("localhost")) return passthrough(u, init);
      return new Response("revoke exploded", { status: 500 });
    }) as typeof fetch);

    const res = await request(createApp())
      .post("/api/connect/disconnect")
      .set("Authorization", auth.bearer())
      .send({ connector: "google" });
    expect(res.status).toBe(200);
    expect(await readSecret(UID, "google")).toBeUndefined();
    expect((await readStatus(UID, "google"))?.status).toBe("disconnected");
  });
});

describe("connect — availability", () => {
  it("requires auth", async () => {
    expect((await request(createApp()).get("/api/connect/availability")).status).toBe(401);
  });

  it("reports configured oauth-web providers and the caller-effective google availability", async () => {
    await setGoogleStage("allowlist", [UID]);
    const mine = await request(createApp())
      .get("/api/connect/availability")
      .set("Authorization", auth.bearer());
    expect(mine.status, mine.text).toBe(200);
    expect(mine.body.providers.github).toEqual({ configured: true, available: true });
    expect(mine.body.providers.microsoft).toEqual({ configured: true, available: true });
    expect(mine.body.providers.google).toEqual({
      configured: true,
      stage: "allowlist",
      available: true,
      pickerConfigured: true,
    });

    const theirs = await request(createApp())
      .get("/api/connect/availability")
      .set("Authorization", otherAuth.bearer());
    expect(theirs.body.providers.google).toEqual({
      configured: true,
      stage: "allowlist",
      available: false,
      pickerConfigured: true,
    });
  });

  it("is dark by default, and placeholder creds read as unconfigured", async () => {
    const dark = await request(createApp())
      .get("/api/connect/availability")
      .set("Authorization", auth.bearer());
    expect(dark.body.providers.google).toEqual({
      configured: true,
      stage: "off",
      available: false,
      pickerConfigured: true,
    });

    const savedId = process.env.GOOGLE_CLIENT_ID;
    try {
      process.env.GOOGLE_CLIENT_ID = "placeholder";
      await setGoogleStage("on");
      const placeholder = await request(createApp())
        .get("/api/connect/availability")
        .set("Authorization", auth.bearer());
      expect(placeholder.body.providers.google).toEqual({
        configured: false,
        stage: "on",
        available: false,
        pickerConfigured: true,
      });
    } finally {
      process.env.GOOGLE_CLIENT_ID = savedId;
    }
  });
});

describe("connect — microsoft + verify", () => {
  it("microsoft callback stores encrypted tokens via the signed-state framework", async () => {
    stubProviderFetch([
      {
        url: /login\.microsoftonline\.com.*\/token/,
        respond: () => ({
          access_token: PLAINTEXT_MS_ACCESS,
          refresh_token: "M.R3_PLAINTEXT-ms-refresh",
          expires_in: 3600,
          token_type: "Bearer",
        }),
      },
      { url: /graph\.microsoft\.com\/v1\.0\/me/, respond: () => ({ mail: "ms@x.com" }) },
    ]);
    const { state } = await mintAuthUrlState("microsoft");

    const res = await request(createApp()).get(
      `/api/connect/microsoft/callback?code=c&state=${encodeURIComponent(state)}`,
    );
    expect(res.headers.location).toContain("microsoft_connected=true");

    const secret = await readSecret(UID, "microsoft");
    expect(JSON.stringify(secret)).not.toContain(PLAINTEXT_MS_ACCESS);
    expect((await readStatus(UID, "microsoft"))?.accountLabel).toBe("ms@x.com");
  });

  it("verify: requires auth; 422 not_connected before capture; 200 with identity for a live PAT", async () => {
    expect((await request(createApp()).post("/api/connect/github/verify")).status).toBe(401);

    const notConnected = await request(createApp())
      .post("/api/connect/github/verify")
      .set("Authorization", auth.bearer());
    expect(notConnected.status).toBe(422);
    expect(notConnected.body.reason).toBe("not_connected");

    stubProviderFetch([{ url: /api\.github\.com\/user$/, respond: () => ({ login: "pat-user" }) }]);
    await request(createApp())
      .post("/api/connect/github/pat")
      .set("Authorization", auth.bearer())
      .send({ token: PLAINTEXT_GH_PAT });

    const verified = await request(createApp())
      .post("/api/connect/github/verify")
      .set("Authorization", auth.bearer());
    expect(verified.status, verified.text).toBe(200);
    expect(verified.body).toMatchObject({ ok: true, accountLabel: "pat-user" });
    expect(verified.body.probe).toBeUndefined();
    expect((await readStatus(UID, "github"))?.verifiedAt).toBeTruthy();
  });

  it("verify on google: refreshes with the platform client, probes every granted capability, rotates at rest", async () => {
    await setGoogleStage("on");
    const CAL = "https://www.googleapis.com/auth/calendar.events";
    const GMAIL = "https://www.googleapis.com/auth/gmail.modify";
    const DRIVE = "https://www.googleapis.com/auth/drive.file";
    const EMAIL = "https://www.googleapis.com/auth/userinfo.email";
    const FRESH_ACCESS = "ya29.FRESH-after-refresh";
    stubProviderFetch([
      {
        url: /oauth2\.googleapis\.com\/token/,
        respond: (init) => {
          const body = String(init?.body);
          if (body.includes("grant_type=refresh_token")) {
            expect(body).toContain("client_id=google-client-id");
            return { access_token: FRESH_ACCESS, expires_in: 3600, token_type: "Bearer" };
          }
          return {
            access_token: PLAINTEXT_GOOGLE_ACCESS,
            refresh_token: PLAINTEXT_GOOGLE_REFRESH,
            expires_in: 3600,
            token_type: "Bearer",
            scope: `${CAL} ${GMAIL} ${DRIVE} ${EMAIL}`,
          };
        },
      },
      { url: /googleapis\.com\/oauth2\/v2\/userinfo/, respond: () => ({ email: "g@x.com" }) },
      {
        url: /www\.googleapis\.com\/calendar\/v3\/calendars\/primary\/events/,
        respond: () => ({ items: [] }),
      },
      {
        url: /gmail\.googleapis\.com\/gmail\/v1\/users\/me\/profile/,
        respond: () => ({ emailAddress: "g@x.com" }),
      },
      {
        url: /www\.googleapis\.com\/drive\/v3\/about/,
        respond: () => ({ user: { emailAddress: "g@x.com" } }),
      },
    ]);
    const { state } = await mintAuthUrlState("google", "&capability=drive");
    await request(createApp()).get(
      `/api/connect/google/callback?code=c&state=${encodeURIComponent(state)}`,
    );

    await db
      .collection("users")
      .doc(UID)
      .collection("secrets")
      .doc("google")
      .set({ tokens: { expiresAt: Date.now() - 1000 } }, { merge: true });

    const res = await request(createApp())
      .post("/api/connect/google/verify")
      .set("Authorization", auth.bearer());
    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      accountLabel: "g@x.com",
      probe: { probe: "calendar.events+gmail.profile+drive.about", detail: "calendar, gmail, drive" },
    });

    const tokens = (await readSecret(UID, "google"))?.tokens as Record<string, unknown>;
    expect(tokens.encryptedAccessToken).toBe(encOf(FRESH_ACCESS));
  });

  it("verify reports reauth_required (409) and flags the status doc when the refresh is rejected", async () => {
    await setGoogleStage("on");
    stubProviderFetch([
      {
        url: /oauth2\.googleapis\.com\/token/,
        respond: (init) =>
          String(init?.body).includes("grant_type=refresh_token")
            ? { error: "invalid_grant" }
            : {
                access_token: PLAINTEXT_GOOGLE_ACCESS,
                refresh_token: PLAINTEXT_GOOGLE_REFRESH,
                expires_in: 3600,
                token_type: "Bearer",
                scope: "https://www.googleapis.com/auth/userinfo.email",
              },
      },
      { url: /googleapis\.com\/oauth2\/v2\/userinfo/, respond: () => ({ email: "g@x.com" }) },
    ]);
    const { state } = await mintAuthUrlState("google", "&capability=calendar");
    await request(createApp()).get(
      `/api/connect/google/callback?code=c&state=${encodeURIComponent(state)}`,
    );
    await db
      .collection("users")
      .doc(UID)
      .collection("secrets")
      .doc("google")
      .set({ tokens: { expiresAt: Date.now() - 1000 } }, { merge: true });

    const res = await request(createApp())
      .post("/api/connect/google/verify")
      .set("Authorization", auth.bearer());
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe("reauth_required");
    const status = await readStatus(UID, "google");
    expect(status?.status).toBe("error");
    expect(status?.error).toBe("reauth_required");
  });

  it("the old unsigned /api/integrations/{google,microsoft} mint+callback routes are gone", async () => {
    for (const path of [
      `/api/integrations/google/auth-url?uid=${UID}`,
      `/api/integrations/microsoft/auth-url?uid=${UID}`,
      "/api/integrations/google/callback?code=c&state=x",
      "/api/integrations/microsoft/callback?code=c&state=x",
    ]) {
      const res = await request(createApp()).get(path);
      expect(res.status, path).toBe(404);
    }
  });
});

describe("connect — google drive picker + full-read escalation", () => {
  const DRIVE = "https://www.googleapis.com/auth/drive.file";
  const DRIVE_FULL = "https://www.googleapis.com/auth/drive.readonly";
  const EMAIL = "https://www.googleapis.com/auth/userinfo.email";
  const CAL = "https://www.googleapis.com/auth/calendar.events";

  async function grantGoogle(capability: string, grantedScope: string): Promise<void> {
    stubProviderFetch([
      {
        url: /oauth2\.googleapis\.com\/token/,
        respond: () => ({
          access_token: PLAINTEXT_GOOGLE_ACCESS,
          refresh_token: PLAINTEXT_GOOGLE_REFRESH,
          expires_in: 3600,
          token_type: "Bearer",
          scope: grantedScope,
        }),
      },
      { url: /googleapis\.com\/oauth2\/v2\/userinfo/, respond: () => ({ email: "g@x.com" }) },
    ]);
    const { state } = await mintAuthUrlState("google", `&capability=${capability}`);
    const res = await request(createApp()).get(
      `/api/connect/google/callback?code=c&state=${encodeURIComponent(state)}`,
    );
    expect(res.headers.location).toContain("google_connected=true");
    vi.restoreAllMocks();
    _setKmsClientForTesting(deterministicMockKms());
  }

  it("drive-full mints an escalation consent that keeps drive.file and adds drive.readonly", async () => {
    await setGoogleStage("on");
    const { url } = await mintAuthUrlState("google", "&capability=drive-full");
    expect(new URL(url).searchParams.get("scope")).toBe(`${DRIVE} ${DRIVE_FULL} ${EMAIL}`);
  });

  it("a drive-full grant records drive.readonly in the granted scopes", async () => {
    await setGoogleStage("on");
    await grantGoogle("drive-full", `${DRIVE} ${DRIVE_FULL} ${EMAIL}`);
    const status = await readStatus(UID, "google");
    expect(status?.scopes).toContain(DRIVE_FULL);
  });

  it("picker-token requires auth, drive grant, and picker env", async () => {
    expect((await request(createApp()).get("/api/connect/google/picker-token")).status).toBe(401);

    await setGoogleStage("on");
    const ungranted = await request(createApp())
      .get("/api/connect/google/picker-token")
      .set("Authorization", auth.bearer());
    expect(ungranted.status).toBe(422);
    expect(ungranted.body.reason).toBe("drive_not_connected");

    await grantGoogle("calendar", `${CAL} ${EMAIL}`);
    const calendarOnly = await request(createApp())
      .get("/api/connect/google/picker-token")
      .set("Authorization", auth.bearer());
    expect(calendarOnly.status).toBe(422);
    expect(calendarOnly.body.reason).toBe("drive_not_connected");
  });

  it("picker-token 503s when the picker env is unset", async () => {
    await setGoogleStage("on");
    await grantGoogle("drive", `${DRIVE} ${EMAIL}`);
    const saved = process.env.GOOGLE_PICKER_API_KEY;
    try {
      delete process.env.GOOGLE_PICKER_API_KEY;
      const res = await request(createApp())
        .get("/api/connect/google/picker-token")
        .set("Authorization", auth.bearer());
      expect(res.status).toBe(503);
    } finally {
      process.env.GOOGLE_PICKER_API_KEY = saved;
    }
  });

  it("picker-token returns the Builder's fresh access token with the picker client config", async () => {
    await setGoogleStage("on");
    await grantGoogle("drive", `${DRIVE} ${EMAIL}`);
    const res = await request(createApp())
      .get("/api/connect/google/picker-token")
      .set("Authorization", auth.bearer());
    expect(res.status, res.text).toBe(200);
    expect(res.body).toEqual({
      accessToken: PLAINTEXT_GOOGLE_ACCESS,
      apiKey: "picker-key",
      appId: "123456789",
    });
    expect(res.headers["cache-control"]).toContain("no-store");
  });

  it("picked-files add/remove merges by id and round-trips through the integration doc", async () => {
    await setGoogleStage("on");
    await grantGoogle("drive", `${DRIVE} ${EMAIL}`);

    const add = await request(createApp())
      .post("/api/connect/google/picked-files")
      .set("Authorization", auth.bearer())
      .send({
        add: [
          { id: "f1", name: "Plan.pdf", mimeType: "application/pdf" },
          { id: "f2", name: "Notes.md", mimeType: "text/markdown" },
        ],
      });
    expect(add.status, add.text).toBe(200);

    const again = await request(createApp())
      .post("/api/connect/google/picked-files")
      .set("Authorization", auth.bearer())
      .send({
        add: [{ id: "f1", name: "Plan v2.pdf", mimeType: "application/pdf" }],
        remove: ["f2"],
      });
    expect(again.status).toBe(200);
    expect(again.body.pickedFiles).toEqual([
      { id: "f1", name: "Plan v2.pdf", mimeType: "application/pdf" },
    ]);
    expect((await readStatus(UID, "google"))?.pickedFiles).toEqual([
      { id: "f1", name: "Plan v2.pdf", mimeType: "application/pdf" },
    ]);
  });

  it("picked-files rejects empty payloads and unconnected users", async () => {
    await setGoogleStage("on");
    const empty = await request(createApp())
      .post("/api/connect/google/picked-files")
      .set("Authorization", auth.bearer())
      .send({ add: [{ id: "", name: "x", mimeType: "t" }] });
    expect(empty.status).toBe(400);

    const unconnected = await request(createApp())
      .post("/api/connect/google/picked-files")
      .set("Authorization", auth.bearer())
      .send({ add: [{ id: "f1", name: "Plan.pdf", mimeType: "application/pdf" }] });
    expect(unconnected.status).toBe(422);
    expect(unconnected.body.reason).toBe("not_connected");
  });

  it("picked-files requires an active Drive grant, not merely a Google integration doc", async () => {
    await setGoogleStage("on");
    await grantGoogle("calendar", `${CAL} ${EMAIL}`);

    const res = await request(createApp())
      .post("/api/connect/google/picked-files")
      .set("Authorization", auth.bearer())
      .send({ add: [{ id: "f1", name: "Plan.pdf", mimeType: "application/pdf" }] });

    expect(res.status).toBe(422);
    expect(res.body.reason).toBe("drive_not_connected");
    expect((await readStatus(UID, "google"))?.pickedFiles).toBeUndefined();
  });

  it("availability reports picker configuration", async () => {
    await setGoogleStage("on");
    const res = await request(createApp())
      .get("/api/connect/availability")
      .set("Authorization", auth.bearer());
    expect(res.body.providers.google.pickerConfigured).toBe(true);

    const saved = process.env.GOOGLE_PICKER_APP_ID;
    try {
      process.env.GOOGLE_PICKER_APP_ID = "placeholder";
      const dark = await request(createApp())
        .get("/api/connect/availability")
        .set("Authorization", auth.bearer());
      expect(dark.body.providers.google.pickerConfigured).toBe(false);
    } finally {
      process.env.GOOGLE_PICKER_APP_ID = saved;
    }
  });
});
