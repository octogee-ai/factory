import { describe, expect, it, vi } from "vitest";
import {
  AdminFleetHttpError,
  createAdminFleetClient,
  exchangeAdminFleetCustomToken,
} from "../lib/admin-fleet-client.js";

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
  it("sends bearer JSON with an optional idempotency key", async () => {
    const fetchImpl = vi.fn(async () => response({
      status: 202,
      body: JSON.stringify({ operationId: "op-1" }),
    }));
    const client = createAdminFleetClient({
      apiOrigin: "https://api-test.octogee.com/",
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
      "https://api-test.octogee.com/api/admin/gateways/gw-1/rollout",
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
