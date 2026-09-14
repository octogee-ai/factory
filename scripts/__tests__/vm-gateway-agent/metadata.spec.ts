import { expect, it, vi } from "vitest";
import { createMetadataClient, METADATA_BASE } from "../../lib/vm-gateway-agent/metadata";

it("mints the computer access token with the email scope so GKE TokenReview can resolve the service account by email", async () => {
  const fetchImpl = vi.fn(async () => Response.json({ access_token: "ya29.fixture", expires_in: 3599, token_type: "Bearer" })) as unknown as typeof fetch;
  await expect(createMetadataClient(fetchImpl).accessToken()).resolves.toBe("ya29.fixture");
  const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
  const requested = new URL(url);
  expect(`${requested.origin}${requested.pathname}`).toBe(`${METADATA_BASE}/instance/service-accounts/default/token`);
  expect(requested.searchParams.get("scopes")?.split(",")).toEqual([
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/userinfo.email",
  ]);
  expect((init.headers as Record<string, string>)["Metadata-Flavor"]).toBe("Google");
});
