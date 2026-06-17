import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { internalFetch } from "../lib/internal-fetch.js";
import * as broker from "../lib/gitea-admin-broker-client.js";

vi.mock("../lib/internal-fetch.js", () => ({ internalFetch: vi.fn() }));

const mockFetch = vi.mocked(internalFetch);
const DEFAULT_BASE = "http://127.0.0.1:3001";

function reply(status: number, body: unknown = {}): Response {
  const noBody = status === 204;
  return new Response(noBody ? null : JSON.stringify(body), { status });
}

function lastCall(): { url: string; method: string; body: unknown } {
  const [url, init] = mockFetch.mock.calls.at(-1)!;
  return {
    url: String(url),
    method: (init?.method ?? "GET") as string,
    body: init?.body ? JSON.parse(init.body as string) : undefined,
  };
}

describe("gitea-admin-broker-client → Gitea admin broker", () => {
  beforeEach(() => {
    delete process.env.GATEWAY_EDGE_INTERNAL_URL;
    delete process.env.GITEA_ADMIN_BROKER_URL;
    mockFetch.mockReset();
  });
  afterEach(() => {
    delete process.env.GATEWAY_EDGE_INTERNAL_URL;
    delete process.env.GITEA_ADMIN_BROKER_URL;
  });

  it("ensureGiteaUser POSTs slug + pubKey to the local sidecar", async () => {
    mockFetch.mockResolvedValueOnce(reply(204));
    await broker.ensureGiteaUser("acme", "ssh-ed25519 AAA");
    expect(lastCall()).toMatchObject({
      url: `${DEFAULT_BASE}/internal/gitea/ensure-user`,
      method: "POST",
      body: { slug: "acme", pubKey: "ssh-ed25519 AAA" },
    });
  });

  it("fails loud when the sidecar returns a non-2xx (no silent success)", async () => {
    mockFetch.mockResolvedValueOnce(reply(502, { error: "gitea down" }));
    await expect(broker.ensureGiteaUser("acme", "k")).rejects.toThrow(/502/);
  });

  it("readGiteaUserPubKey GETs and returns the pubKey", async () => {
    mockFetch.mockResolvedValueOnce(reply(200, { pubKey: "ssh-ed25519 WANT" }));
    expect(await broker.readGiteaUserPubKey("acme")).toBe("ssh-ed25519 WANT");
    expect(lastCall()).toMatchObject({
      url: `${DEFAULT_BASE}/internal/gitea/user-pubkey?slug=acme`,
      method: "GET",
    });
  });

  it("readGiteaUserPubKey passes through null", async () => {
    mockFetch.mockResolvedValueOnce(reply(200, { pubKey: null }));
    expect(await broker.readGiteaUserPubKey("acme")).toBeNull();
  });

  it("ensureGiteaOrgForWorkspace POSTs slug", async () => {
    mockFetch.mockResolvedValueOnce(reply(204));
    await broker.ensureGiteaOrgForWorkspace("acme");
    expect(lastCall()).toMatchObject({
      url: `${DEFAULT_BASE}/internal/gitea/ensure-org`,
      method: "POST",
      body: { slug: "acme" },
    });
  });

  it("ensureWorkspaceRepo POSTs slug", async () => {
    mockFetch.mockResolvedValueOnce(reply(204));
    await broker.ensureWorkspaceRepo("acme");
    expect(lastCall()).toMatchObject({
      url: `${DEFAULT_BASE}/internal/gitea/ensure-workspace-repo`,
      method: "POST",
      body: { slug: "acme" },
    });
  });

  it("ensureSystemConfigRepo POSTs slug", async () => {
    mockFetch.mockResolvedValueOnce(reply(204));
    await broker.ensureSystemConfigRepo("acme");
    expect(lastCall()).toMatchObject({
      url: `${DEFAULT_BASE}/internal/gitea/ensure-system-config-repo`,
      method: "POST",
      body: { slug: "acme" },
    });
  });

  it("ensureProjectRepo POSTs slug + projectName", async () => {
    mockFetch.mockResolvedValueOnce(reply(204));
    await broker.ensureProjectRepo("acme", "mygame");
    expect(lastCall()).toMatchObject({
      url: `${DEFAULT_BASE}/internal/gitea/ensure-project-repo`,
      method: "POST",
      body: { slug: "acme", projectName: "mygame" },
    });
  });

  it("repoExists GETs and returns the boolean", async () => {
    mockFetch.mockResolvedValueOnce(reply(200, { exists: false }));
    expect(await broker.repoExists("acme", "workspace")).toBe(false);
    expect(lastCall()).toMatchObject({
      url: `${DEFAULT_BASE}/internal/gitea/repo-exists?org=acme&repo=workspace`,
      method: "GET",
    });
  });

  it("archiveRepo POSTs org + repo", async () => {
    mockFetch.mockResolvedValueOnce(reply(204));
    await broker.archiveRepo("acme", "workspace");
    expect(lastCall()).toMatchObject({
      url: `${DEFAULT_BASE}/internal/gitea/archive-repo`,
      method: "POST",
      body: { org: "acme", repo: "workspace" },
    });
  });

  it("honors GATEWAY_EDGE_INTERNAL_URL override", async () => {
    process.env.GATEWAY_EDGE_INTERNAL_URL = "http://localhost:9999";
    mockFetch.mockResolvedValueOnce(reply(204));
    await broker.ensureWorkspaceRepo("acme");
    expect(lastCall().url).toBe("http://localhost:9999/internal/gitea/ensure-workspace-repo");
  });

  it("prefers GITEA_ADMIN_BROKER_URL over the legacy local sidecar URL", async () => {
    process.env.GATEWAY_EDGE_INTERNAL_URL = "http://localhost:9999";
    process.env.GITEA_ADMIN_BROKER_URL = "http://octogee-api.octogee-test.svc.cluster.local:3001";
    mockFetch.mockResolvedValueOnce(reply(204));
    await broker.ensureWorkspaceRepo("acme");
    expect(lastCall().url).toBe(
      "http://octogee-api.octogee-test.svc.cluster.local:3001/internal/gitea/ensure-workspace-repo",
    );
  });
});
