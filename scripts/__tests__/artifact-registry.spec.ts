import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let getAccessTokenCalls = 0;
vi.mock("google-auth-library", () => ({
  GoogleAuth: class {
    async getClient() {
      return {
        getAccessToken: async () => {
          getAccessTokenCalls += 1;
          return { token: "fake-token" };
        },
      };
    }
  },
}));

import { listGatewayBuilds } from "../lib/artifact-registry";

const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  getAccessTokenCalls = 0;
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function makeArResponse(items: Array<{ name: string; tags: string[]; uploadTime: string }>) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ dockerImages: items }),
  } as unknown as Response;
}

describe("listGatewayBuilds — Artifact Registry adapter", () => {
  it("returns SHA-tagged builds for the requested service, sorted newest-first", async () => {
    fetchMock.mockResolvedValueOnce(
      makeArResponse([
        {
          name: "projects/octogee/locations/us-central1/repositories/octogee/dockerImages/octogee-gateway@sha256:aaa",
          tags: ["abc1234"],
          uploadTime: "2026-05-04T10:00:00Z",
        },
        {
          name: "projects/octogee/locations/us-central1/repositories/octogee/dockerImages/octogee-gateway@sha256:bbb",
          tags: ["def5678"],
          uploadTime: "2026-05-03T08:00:00Z",
        },
      ]),
    );
    const builds = await listGatewayBuilds({ service: "octogee-gateway" });
    expect(builds).toHaveLength(2);
    expect(builds[0]).toMatchObject({ tag: "abc1234", pushedAt: "2026-05-04T10:00:00Z" });
    expect(builds[1].tag).toBe("def5678");
    expect(builds[0].digest).toBe("sha256:aaa");
  });

  it("filters out non-SHA tags like `latest` and the floating `main`", async () => {
    fetchMock.mockResolvedValueOnce(
      makeArResponse([
        {
          name: "projects/octogee/locations/us-central1/repositories/octogee/dockerImages/octogee-gateway@sha256:zzz",
          tags: ["latest", "abc1234", "main"],
          uploadTime: "2026-05-04T10:00:00Z",
        },
      ]),
    );
    const builds = await listGatewayBuilds({ service: "octogee-gateway" });
    expect(builds).toHaveLength(1);
    expect(builds[0].tag).toBe("abc1234");
  });

  it("excludes images for other services in the same repo", async () => {
    fetchMock.mockResolvedValueOnce(
      makeArResponse([
        {
          name: "projects/octogee/locations/us-central1/repositories/octogee/dockerImages/octogee-gateway@sha256:aaa",
          tags: ["abc1234"],
          uploadTime: "2026-05-04T10:00:00Z",
        },
        {
          name: "projects/octogee/locations/us-central1/repositories/octogee/dockerImages/workspace-api@sha256:bbb",
          tags: ["def5678"],
          uploadTime: "2026-05-04T11:00:00Z",
        },
      ]),
    );
    const builds = await listGatewayBuilds({ service: "octogee-gateway" });
    expect(builds.map((b) => b.tag)).toEqual(["abc1234"]);
  });

  it("collapses duplicate SHAs to the newest occurrence (multi-arch images share a tag)", async () => {
    fetchMock.mockResolvedValueOnce(
      makeArResponse([
        {
          name: "projects/octogee/locations/us-central1/repositories/octogee/dockerImages/octogee-gateway@sha256:aaa",
          tags: ["abc1234"],
          uploadTime: "2026-05-04T10:00:00Z",
        },
        {
          name: "projects/octogee/locations/us-central1/repositories/octogee/dockerImages/octogee-gateway@sha256:bbb",
          tags: ["abc1234"],
          uploadTime: "2026-05-04T09:00:00Z",
        },
      ]),
    );
    const builds = await listGatewayBuilds({ service: "octogee-gateway" });
    expect(builds).toHaveLength(1);
    expect(builds[0].digest).toBe("sha256:aaa");
  });

  it("respects the limit parameter (caps the returned count)", async () => {
    const items = Array.from({ length: 60 }, (_, i) => ({
      name: `projects/octogee/locations/us-central1/repositories/octogee/dockerImages/octogee-gateway@sha256:${i.toString(16).padStart(40, "0")}`,
      tags: [i.toString(16).padStart(7, "0")],
      uploadTime: new Date(Date.now() - i * 3600_000).toISOString(),
    }));
    fetchMock.mockResolvedValueOnce(makeArResponse(items));
    const builds = await listGatewayBuilds({ service: "octogee-gateway", limit: 10 });
    expect(builds).toHaveLength(10);
  });

  it("uses the GoogleAuth access token via the Authorization header", async () => {
    fetchMock.mockResolvedValueOnce(makeArResponse([]));
    await listGatewayBuilds({ service: "octogee-gateway" });
    expect(getAccessTokenCalls).toBeGreaterThan(0);
    const call = fetchMock.mock.calls[0];
    const init = call[1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer fake-token");
  });

  it("targets the canonical Artifact Registry repo by default", async () => {
    fetchMock.mockResolvedValueOnce(makeArResponse([]));
    await listGatewayBuilds({ service: "octogee-gateway" });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain(
      "/v1/projects/octogee/locations/us-central1/repositories/octogee/dockerImages",
    );
  });

  it("requests update_time desc so newest builds dominate the first page", async () => {
    // Without orderBy, AR returns images in digest-hash order. With 100+
    // historical SHAs in a busy repo, the accumulator filled with older
    // builds before today's builds were paged, and newer builds vanished
    // from the picker.
    fetchMock.mockResolvedValueOnce(makeArResponse([]));
    await listGatewayBuilds({ service: "octogee-gateway" });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("orderBy=update_time+desc");
  });

  it("paginates until enough service-matching builds are found", async () => {
    // Page 1: only non-matching services (workspace-api), forcing pagination
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        dockerImages: [
          {
            name: "projects/octogee/locations/us-central1/repositories/octogee/dockerImages/workspace-api@sha256:01",
            tags: ["abc1234"],
            uploadTime: "2026-05-04T10:00:00Z",
          },
        ],
        nextPageToken: "page-2",
      }),
    } as unknown as Response);
    // Page 2: gateway image — should be picked up
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        dockerImages: [
          {
            name: "projects/octogee/locations/us-central1/repositories/octogee/dockerImages/octogee-gateway@sha256:02",
            tags: ["def5678"],
            uploadTime: "2026-05-03T10:00:00Z",
          },
        ],
      }),
    } as unknown as Response);

    const builds = await listGatewayBuilds({ service: "octogee-gateway", limit: 1 });
    expect(builds).toHaveLength(1);
    expect(builds[0].tag).toBe("def5678");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Second call must include the pageToken
    const secondUrl = fetchMock.mock.calls[1][0] as string;
    expect(secondUrl).toContain("pageToken=page-2");
  });

  it("stops pagination once we have plenty of deduped builds for the service", async () => {
    // Returns 30 gateway builds in page 1, claims more pages — but caller asks for 5
    const items = Array.from({ length: 30 }, (_, i) => ({
      name: `projects/octogee/locations/us-central1/repositories/octogee/dockerImages/octogee-gateway@sha256:${i.toString(16).padStart(40, "0")}`,
      tags: [i.toString(16).padStart(7, "0")],
      uploadTime: new Date(Date.now() - i * 3600_000).toISOString(),
    }));
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ dockerImages: items, nextPageToken: "page-2" }),
    } as unknown as Response);

    const builds = await listGatewayBuilds({ service: "octogee-gateway", limit: 5 });
    expect(builds).toHaveLength(5);
    // Should stop on page 1 — 30 deduped > limit*3 = 15
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("propagates HTTP errors from Artifact Registry as a thrown Error", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      text: async () => "permission denied",
    } as unknown as Response);
    await expect(listGatewayBuilds({ service: "octogee-gateway" })).rejects.toThrow(
      /artifact-registry/i,
    );
  });
});
