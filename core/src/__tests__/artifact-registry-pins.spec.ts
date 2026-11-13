import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ensureKeepTag, removeKeepTag, listKeepTags } from "../artifact-registry.js";

vi.mock("google-auth-library", () => ({
  GoogleAuth: class {
    async getClient() {
      return { getAccessToken: async () => ({ token: "test-token" }) };
    }
  },
}));

const COORDS = { project: "octogee", location: "us-central1", repository: "octogee" };
const BASE =
  "https://artifactregistry.googleapis.com/v1/projects/octogee/locations/us-central1/repositories/octogee/packages";
const DIGEST = `sha256:${"a".repeat(64)}`;
const VERSION = `projects/octogee/locations/us-central1/repositories/octogee/packages/octogee-gateway/versions/${DIGEST}`;

function mockFetch(handler: (url: string, init?: RequestInit) => { status: number; body?: unknown }) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const { status, body } = handler(url, init);
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: String(status),
      json: async () => body ?? {},
      text: async () => JSON.stringify(body ?? {}),
    } as Response;
  });
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe("artifact-registry keep-tag pins", () => {
  it("pins the immutable digest without resolving a synthetic image tag", async () => {
    const calls: { method: string; url: string; body?: unknown }[] = [];
    const fetchMock = mockFetch((url, init) => {
      calls.push({ method: init?.method ?? "GET", url, body: init?.body && JSON.parse(init.body as string) });
      if ((init?.method ?? "GET") === "GET") {
        return { status: 404 };
      }
      return { status: 200, body: {} };
    });
    vi.stubGlobal("fetch", fetchMock);

    await ensureKeepTag({ ...COORDS, service: "octogee-gateway", env: "prod", digest: DIGEST });

    expect(calls.some((c) => c.method === "GET")).toBe(false);
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.url).toContain(`tagId=keep-prod-sha256-${"a".repeat(64)}`);
    expect(post.body).toEqual({ version: VERSION });
  });

  it("ensureKeepTag is idempotent — a 409 ALREADY_EXISTS on create is not an error", async () => {
    const fetchMock = mockFetch((url, init) => {
      if ((init?.method ?? "GET") === "GET") return { status: 200, body: { version: `${BASE}/octogee-gateway/versions/sha256:abc` } };
      return { status: 409, body: { error: { status: "ALREADY_EXISTS" } } };
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      ensureKeepTag({ ...COORDS, service: "octogee-gateway", env: "prod", digest: DIGEST }),
    ).resolves.toBeUndefined();
  });

  it("rejects a malformed digest before contacting Artifact Registry", async () => {
    const fetchMock = mockFetch(() => ({ status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(ensureKeepTag({
      ...COORDS, service: "octogee-gateway", env: "prod", digest: "sha256:bad",
    })).rejects.toThrow("digest");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a failed pin creation", async () => {
    vi.stubGlobal("fetch", mockFetch(() => ({ status: 404, body: { error: "version missing" } })));
    await expect(ensureKeepTag({
      ...COORDS, service: "octogee-gateway", env: "prod", digest: DIGEST,
    })).rejects.toThrow("404");
  });

  it("removeKeepTag DELETEs keep-<env>-<tag>, and a 404 is treated as already-gone", async () => {
    const calls: string[] = [];
    const fetchMock = mockFetch((url, init) => {
      calls.push(`${init?.method} ${url}`);
      return { status: 404, body: {} };
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      removeKeepTag({ ...COORDS, service: "octogee-gateway", env: "test", tag: "4011015-oc2026.6.11" }),
    ).resolves.toBeUndefined();
    expect(calls[0]).toBe(`DELETE ${BASE}/octogee-gateway/tags/keep-test-4011015-oc2026.6.11`);
  });

  it("listKeepTags returns only controller-owned live pins for this env", async () => {
    const fetchMock = mockFetch(() => ({
      status: 200,
      body: {
        tags: [
          { name: `${BASE}/octogee-gateway/tags/keep-prod-930d163-oc2026.6.11` },
          { name: `${BASE}/octogee-gateway/tags/keep-test-4011015-oc2026.6.11` },
          { name: `${BASE}/octogee-gateway/tags/keep-release-prod-b975108-oc2026.8.1` },
          { name: `${BASE}/octogee-gateway/tags/930d163-oc2026.6.11` },
          { name: `${BASE}/octogee-gateway/tags/latest` },
        ],
      },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const tags = await listKeepTags({ ...COORDS, service: "octogee-gateway", env: "prod" });
    expect(tags).toEqual(["930d163-oc2026.6.11"]);
  });
});
