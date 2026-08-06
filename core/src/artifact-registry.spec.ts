import { gzipSync } from "node:zlib";
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

import {
  createCentralReleaseAuthority,
  listGatewayBuilds,
} from "./artifact-registry";

const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  getAccessTokenCalls = 0;
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("K8S_NAMESPACE", "octogee");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
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

  it("returns build-flavor (-diag) and oc-prerelease (-beta.N) bundle tags", async () => {
    fetchMock.mockResolvedValueOnce(
      makeArResponse([
        {
          name: "projects/octogee/locations/us-central1/repositories/octogee/dockerImages/octogee-gateway@sha256:d1a",
          tags: ["a9f521f-oc2026.5.12-diag"],
          uploadTime: "2026-05-18T05:00:00Z",
        },
        {
          name: "projects/octogee/locations/us-central1/repositories/octogee/dockerImages/octogee-gateway@sha256:b6a",
          tags: ["a9f521f-oc2026.5.16-beta.6"],
          uploadTime: "2026-05-18T04:00:00Z",
        },
      ]),
    );
    const builds = await listGatewayBuilds({ service: "octogee-gateway" });
    expect(builds.map((b) => b.tag)).toEqual([
      "a9f521f-oc2026.5.12-diag",
      "a9f521f-oc2026.5.16-beta.6",
    ]);
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
          name: "projects/octogee/locations/us-central1/repositories/octogee/dockerImages/gateway-edge@sha256:bbb",
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

  it("targets the exact Central registry when the runtime target is explicit", async () => {
    vi.stubEnv("K8S_NAMESPACE", "octogee-test");
    vi.stubEnv("DEPLOYMENT_TARGET_ID", "test-central");
    fetchMock.mockResolvedValueOnce(makeArResponse([]));
    await listGatewayBuilds({ service: "octogee-gateway" });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain(
      "/v1/projects/octogee/locations/us-central1/repositories/octogee/dockerImages",
    );
  });

  it("fails closed when runtime registry coordinates have no deployment context", async () => {
    vi.unstubAllEnvs();
    delete process.env.K8S_NAMESPACE;
    await expect(listGatewayBuilds({ service: "octogee-gateway" })).rejects.toThrow(
      "K8S_NAMESPACE is required when Artifact Registry coordinates are incomplete",
    );
  });

  it("requests update_time desc so newest builds dominate the first page", async () => {

fetchMock.mockResolvedValueOnce(makeArResponse([]));
    await listGatewayBuilds({ service: "octogee-gateway" });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("orderBy=update_time+desc");
  });

  it("paginates until enough service-matching builds are found", async () => {
    
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        dockerImages: [
          {
            name: "projects/octogee/locations/us-central1/repositories/octogee/dockerImages/gateway-edge@sha256:01",
            tags: ["abc1234"],
            uploadTime: "2026-05-04T10:00:00Z",
          },
        ],
        nextPageToken: "page-2",
      }),
    } as unknown as Response);
    
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
    
    const secondUrl = fetchMock.mock.calls[1][0] as string;
    expect(secondUrl).toContain("pageToken=page-2");
  });

  it("stops pagination once we have plenty of deduped builds for the service", async () => {
    
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

function tarFile(name: string, contents: string): Uint8Array {
  const body = Buffer.from(contents);
  const header = Buffer.alloc(512);
  header.write(name, 0, "utf8");
  header.write("0000644\0", 100, "ascii");
  header.write("0000000\0", 108, "ascii");
  header.write("0000000\0", 116, "ascii");
  header.write(body.length.toString(8).padStart(11, "0") + "\0", 124, "ascii");
  header.write("00000000000\0", 136, "ascii");
  header[156] = "0".charCodeAt(0);
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");
  const length = Math.ceil(body.length / 512) * 512;
  return gzipSync(Buffer.concat([header, body, Buffer.alloc(length - body.length), Buffer.alloc(1024)]));
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("CENTRAL release authority — Artifact Registry adapter", () => {
  const sourceSha = "a".repeat(40);
  const manifestDigest = `sha256:${"b".repeat(64)}`;
  const gatewayDigest = `sha256:${"c".repeat(64)}`;
  const operatorDigest = `sha256:${"d".repeat(64)}`;
  const edgeDigest = `sha256:${"e".repeat(64)}`;
  const repository = "us-central1-docker.pkg.dev/octogee/octogee";

  const manifest = {
    schemaVersion: 3,
    sourceSha,
    openclawVersion: "2026.7.1",
    repository,
    surfaces: {
      gateway: {
        "gateway-edge": edgeDigest,
        "octogee-gateway": gatewayDigest,
        "octogee-gateway-operator": operatorDigest,
      },
      platform: {
        "artifact-worker": `sha256:${"1".repeat(64)}`,
        "glm-controller": `sha256:${"2".repeat(64)}`,
        "octogee-api": `sha256:${"3".repeat(64)}`,
        "octogee-ops-agent": `sha256:${"4".repeat(64)}`,
        "octogee-project-runner": `sha256:${"5".repeat(64)}`,
      },
    },
  };

  it("resolves the immutable manifest, builds the exact alias plan, and accepts a raced alias only after exact re-read", async () => {
    const authority = createCentralReleaseAuthority({
      project: "octogee",
      location: "us-central1",
      repository: "octogee",
    });
    const archive = tarFile("release-digest-manifest.json", JSON.stringify(manifest));
    const aliases = [{
      alias: `${repository}/octogee-gateway:aaaaaaa-oc2026.7.1`,
      intendedTarget: `${repository}/octogee-gateway@${gatewayDigest}`,
    }];
    fetchMock
      .mockResolvedValueOnce(jsonResponse({
        version: `projects/octogee/locations/us-central1/repositories/octogee/packages/release-digest-manifest/versions/${manifestDigest}`,
      }))
      .mockResolvedValueOnce(jsonResponse({
        schemaVersion: 2,
        layers: [{ digest: `sha256:${"f".repeat(64)}` }],
      }))
      .mockResolvedValueOnce(new Response(archive))
      .mockResolvedValueOnce(new Response("missing", { status: 404 }))
      .mockResolvedValueOnce(new Response("already exists", { status: 409 }))
      .mockResolvedValueOnce(jsonResponse({
        version: `projects/octogee/locations/us-central1/repositories/octogee/packages/octogee-gateway/versions/${gatewayDigest}`,
      }));

    await expect(authority.resolveManifest(sourceSha)).resolves.toMatchObject({
      sourceSha,
      manifestDigest,
      surfaces: { gateway: { "octogee-gateway": gatewayDigest } },
    });
    expect(authority.aliasesFor({ ...manifest, manifestDigest })).toHaveLength(11);
    await expect(authority.ensureAliases(aliases)).resolves.toEqual([{
      alias: aliases[0].alias,
      status: "already-applied",
      observedTarget: aliases[0].intendedTarget,
    }]);

    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls[0]).toContain("/packages/release-digest-manifest/tags/");
    expect(urls[1]).toContain(`/v2/octogee/octogee/release-digest-manifest/manifests/${manifestDigest}`);
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      headers: {
        Accept: [
          "application/vnd.oci.image.manifest.v1+json",
          "application/vnd.docker.distribution.manifest.v2+json",
        ].join(", "),
      },
    });
    expect(urls[2]).toContain("/v2/octogee/octogee/release-digest-manifest/blobs/");
    expect(urls[4]).toContain("tagId=aaaaaaa-oc2026.7.1");
    expect(fetchMock.mock.calls[4]?.[1]).toMatchObject({
      body: JSON.stringify({
        version: `projects/octogee/locations/us-central1/repositories/octogee/packages/octogee-gateway/versions/${gatewayDigest}`,
      }),
    });
  });

  it("rejects legacy v1 manifests at the current release authority boundary", async () => {
    const authority = createCentralReleaseAuthority({
      project: "octogee",
      location: "us-central1",
      repository: "octogee",
    });
    const legacy = structuredClone(manifest);
    legacy.schemaVersion = 1;
    delete legacy.surfaces.platform["octogee-project-runner"];
    const archive = tarFile("release-digest-manifest.json", JSON.stringify(legacy));
    fetchMock
      .mockResolvedValueOnce(jsonResponse({
        version: `projects/octogee/locations/us-central1/repositories/octogee/packages/release-digest-manifest/versions/${manifestDigest}`,
      }))
      .mockResolvedValueOnce(jsonResponse({
        schemaVersion: 2,
        layers: [{ digest: `sha256:${"f".repeat(64)}` }],
      }))
      .mockResolvedValueOnce(new Response(archive));

    await expect(authority.resolveManifest(sourceSha)).rejects.toThrow(
      "release digest manifest schemaVersion must be 3",
    );
  });

  it("rejects an alias race when the persisted target is not the manifest digest", async () => {
    const authority = createCentralReleaseAuthority({
      project: "octogee",
      location: "us-central1",
      repository: "octogee",
    });
    const alias = {
      alias: `${repository}/octogee-gateway:aaaaaaa`,
      intendedTarget: `${repository}/octogee-gateway@${gatewayDigest}`,
    };
    fetchMock
      .mockResolvedValueOnce(new Response("missing", { status: 404 }))
      .mockResolvedValueOnce(new Response("already exists", { status: 409 }))
      .mockResolvedValueOnce(jsonResponse({
        version: `projects/octogee/locations/us-central1/repositories/octogee/packages/octogee-gateway/versions/sha256:${"0".repeat(64)}`,
      }));

    await expect(authority.ensureAliases([alias])).rejects.toThrow("already points at a different digest");
  });
});
