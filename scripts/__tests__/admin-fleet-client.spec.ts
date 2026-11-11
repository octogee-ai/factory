import { describe, expect, it, vi } from "vitest";
import {
  AdminFleetHttpError,
  createAdminFleetClient,
  exchangeAdminFleetCustomToken,
  resolveFirebaseWebApiKey,
} from "../lib/admin-fleet-client.js";
import { TEST_TARGET } from "./fixtures/deployment.js";

function response(input: {
  status: number;
  body: string;
  statusText?: string;
}): Response {
  return {
    ok: input.status >= 200 && input.status < 300,
    status: input.status,
    statusText: input.statusText ?? "",
    text: async () => input.body,
  } as Response;
}

describe("admin fleet client", () => {
  it("discovers the Firebase web API key from the environment app origin", async () => {
    const fetchImpl = vi.fn(async () => response({
      status: 200,
      body: JSON.stringify({ apiKey: "public-web-key", projectId: TEST_TARGET.firebaseProjectId }),
    }));

    await expect(resolveFirebaseWebApiKey({
      appOrigin: `${TEST_TARGET.appOrigin}/`,
      fetchImpl,
    })).resolves.toBe("public-web-key");

    expect(fetchImpl).toHaveBeenCalledWith(
      `${TEST_TARGET.appOrigin}/__/firebase/init.json`,
      { headers: { Accept: "application/json" } },
    );
  });

  it("keeps an explicit Firebase web API key as a no-network override", async () => {
    const fetchImpl = vi.fn();

    await expect(resolveFirebaseWebApiKey({
      appOrigin: TEST_TARGET.appOrigin,
      configuredKey: "  explicit-key  ",
      fetchImpl,
    })).resolves.toBe("explicit-key");

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails clearly when public Firebase initialization metadata has no API key", async () => {
    await expect(resolveFirebaseWebApiKey({
      appOrigin: TEST_TARGET.appOrigin,
      fetchImpl: async () => response({ status: 200, body: "{}" }),
    })).rejects.toThrow("Firebase initialization metadata returned no apiKey");
  });

  it("sends bearer JSON with an optional idempotency key", async () => {
    const fetchImpl = vi.fn(async () => response({
      status: 202,
      body: JSON.stringify({ operationId: "op-1" }),
    }));
    const client = createAdminFleetClient({
      apiOrigin: `${TEST_TARGET.apiOrigin}/`,
      getIdToken: async () => "id-token",
      fetchImpl,
    });

    await expect(client.request<{ operationId: string }>({
      method: "POST",
      path: "/api/admin/gateways/gw-1/rollout",
      body: { imageTag: "abc1234" },
      idempotencyKey: "fleet-roll-gw-1",
    })).resolves.toEqual({ operationId: "op-1" });

    expect(fetchImpl).toHaveBeenCalledWith(
      `${TEST_TARGET.apiOrigin}/api/admin/gateways/gw-1/rollout`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ imageTag: "abc1234" }),
        headers: {
          Authorization: "Bearer id-token",
          "Content-Type": "application/json",
          "Idempotency-Key": "fleet-roll-gw-1",
        },
      }),
    );
  });

  it("throws a structured API error instead of swallowing a non-JSON failure", async () => {
    const client = createAdminFleetClient({
      apiOrigin: "https://api.octogee.com",
      getIdToken: async () => "id-token",
      fetchImpl: async () => response({
        status: 503,
        statusText: "Service Unavailable",
        body: "maintenance configuration unavailable",
      }),
    });

    await expect(client.request({
      method: "PATCH",
      path: "/api/admin/gateways/gw-1",
      body: { desiredStatus: "paused" },
    })).rejects.toMatchObject<Partial<AdminFleetHttpError>>({
      name: "AdminFleetHttpError",
      status: 503,
      body: "maintenance configuration unavailable",
    });
  });

  it("exchanges an Admin SDK custom token for the admin route bearer token", async () => {
    const createCustomToken = vi.fn(async () => "custom-token");
    const fetchImpl = vi.fn(async () => response({
      status: 200,
      body: JSON.stringify({ idToken: "firebase-id-token" }),
    }));

    await expect(exchangeAdminFleetCustomToken({
      operatorUid: "operator-uid",
      webApiKey: "web-key",
      createCustomToken,
      fetchImpl,
    })).resolves.toBe("firebase-id-token");

    expect(createCustomToken).toHaveBeenCalledWith("operator-uid");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=web-key",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: "custom-token", returnSecureToken: true }),
      }),
    );
  });

  it("preserves custom-token exchange failures", async () => {
    await expect(exchangeAdminFleetCustomToken({
      operatorUid: "operator-uid",
      webApiKey: "web-key",
      createCustomToken: async () => "custom-token",
      fetchImpl: async () => response({
        status: 400,
        statusText: "Bad Request",
        body: JSON.stringify({ error: { message: "INVALID_CUSTOM_TOKEN" } }),
      }),
    })).rejects.toThrow("Custom-token exchange failed: 400");
  });
});
