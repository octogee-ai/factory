import { afterAll, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import zlib from "node:zlib";

import {
  collectDistFiles,
  deployCollectedFiles,
  ensureChannel,
  hostingConfigForRecipe,
  listReleases,
  releaseToChannel,
  releaseVersion,
  withCollectedFile,
  type CollectedFiles,
} from "./hosting.js";

const tmpDirs: string[] = [];
function makeDist(tree: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dist-"));
  tmpDirs.push(root);
  for (const [rel, content] of Object.entries(tree)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}
afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

describe("collectDistFiles", () => {
  it("returns null when the dist directory does not exist", () => {
    expect(collectDistFiles("/no/such/dir-xyz")).toBeNull();
  });

  it("maps each file to /url-path → sha256(gzip), with the gzipped blob by hash", () => {
    const dir = makeDist({ "index.html": "<h1>hi</h1>", "assets/app.js": "console.log(1)" });
    const collected = collectDistFiles(dir);
    expect(collected).not.toBeNull();
    expect(Object.keys(collected!.files).sort()).toEqual(["/assets/app.js", "/index.html"]);

    // hash is sha256 of the gzipped bytes; blob is that gzip, base64
    const expectedGz = zlib.gzipSync(Buffer.from("<h1>hi</h1>"));
    const expectedHash = crypto.createHash("sha256").update(expectedGz).digest("hex");
    expect(collected!.files["/index.html"]).toBe(expectedHash);
    expect(Buffer.from(collected!.blobs[expectedHash], "base64")).toEqual(expectedGz);
  });

  it("skips symlinks — never follows a link pointing outside dist/ (e.g. the mounted KSA token)", () => {
    const dir = makeDist({ "index.html": "<h1>hi</h1>" });
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "hosting-outside-"));
    tmpDirs.push(outside);
    const secret = path.join(outside, "token");
    fs.writeFileSync(secret, "KSA-TOKEN-SHOULD-NOT-PUBLISH", { flag: "wx", mode: 0o600 });
    fs.symlinkSync(secret, path.join(dir, "leak.txt"));

    const collected = collectDistFiles(dir);
    expect(Object.keys(collected!.files)).toEqual(["/index.html"]);
    expect(collected!.files["/leak.txt"]).toBeUndefined();
  });
});

function res(ok: boolean, body: unknown = {}, status = ok ? 200 : 500) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as unknown as Response;
}

const collected: CollectedFiles = { files: { "/index.html": "h1", "/app.js": "h2" }, blobs: { h1: "AAA", h2: "BBB" } };

describe("deployCollectedFiles", () => {
  it("runs create→populate→upload(required only)→finalize→release and returns the .web.app url", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/versions")) return res(true, { name: "sites/octogee-eggman/versions/v1" });
      if (url.endsWith(":populateFiles")) return res(true, { uploadUrl: "https://up", uploadRequiredHashes: ["h2"] });
      if (url.startsWith("https://up/")) return res(true);
      if (url.includes("update_mask=status")) return res(true);
      if (url.includes("/releases?")) return res(true);
      return res(false, "unexpected");
    });
    const getToken = vi.fn(async () => "hosting-tok");

    const result = await deployCollectedFiles("octogee-eggman", collected, {
      getToken,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toEqual({ success: true, url: "https://octogee-eggman.web.app" });
    // only the required hash (h2) is uploaded — not h1
    expect(calls).toContain("POST https://up/h2");
    expect(calls.some((c) => c.includes("https://up/h1"))).toBe(false);
    expect(calls.some((c) => c.includes("update_mask=status"))).toBe(true);
    expect(calls.some((c) => c.includes("/releases?versionName=sites/octogee-eggman/versions/v1"))).toBe(true);
    expect(getToken).toHaveBeenCalledWith(["https://www.googleapis.com/auth/firebase.hosting"]);
  });

  it("errors (not silently skips) when a required hash has no blob", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/versions")) return res(true, { name: "v1" });
      if (url.endsWith(":populateFiles")) return res(true, { uploadUrl: "https://up", uploadRequiredHashes: ["missing"] });
      return res(true);
    });
    const r = await deployCollectedFiles("octogee-eggman", collected, {
      getToken: async () => "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toMatch(/missing/i);
  });

  it("returns the failure when create-version fails", async () => {
    const fetchImpl = vi.fn(async () => res(false, "boom", 503));
    const r = await deployCollectedFiles("octogee-eggman", collected, {
      getToken: async () => "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toMatch(/version/i);
  });

  it("bakes the supplied serving config into the created version", async () => {
    let versionBody: unknown;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/versions")) {
        versionBody = JSON.parse(String(init?.body));
        return res(true, { name: "sites/octogee-eggman/versions/v1" });
      }
      if (url.endsWith(":populateFiles")) return res(true, { uploadUrl: "https://up" });
      return res(true);
    });

    await deployCollectedFiles("octogee-eggman", collected, {
      getToken: async () => "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      config: hostingConfigForRecipe("vite-static"),
    });

    expect(versionBody).toEqual({ config: hostingConfigForRecipe("vite-static") });
  });

  it("falls back to the recipe-less config when the caller supplies none", async () => {
    let versionBody: unknown;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/versions")) {
        versionBody = JSON.parse(String(init?.body));
        return res(true, { name: "sites/octogee-eggman/versions/v1" });
      }
      if (url.endsWith(":populateFiles")) return res(true, { uploadUrl: "https://up" });
      return res(true);
    });

    await deployCollectedFiles("octogee-eggman", collected, {
      getToken: async () => "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(versionBody).toEqual({
      config: { headers: [{ glob: "**", headers: { "Cache-Control": "max-age=1800" } }] },
    });
  });
});

describe("hostingConfigForRecipe", () => {
  it("gives vite-static an SPA fallback plus immutable /assets caching", () => {
    expect(hostingConfigForRecipe("vite-static")).toEqual({
      rewrites: [{ glob: "**", path: "/index.html" }],
      headers: [
        { glob: "/assets/**", headers: { "Cache-Control": "max-age=31536000, immutable" } },
        { glob: "**", headers: { "Cache-Control": "max-age=1800" } },
      ],
    });
  });

  it("gives astro-static immutable /_astro caching and NO rewrites (multi-page site)", () => {
    const config = hostingConfigForRecipe("astro-static");
    expect(config).toEqual({
      headers: [
        { glob: "/_astro/**", headers: { "Cache-Control": "max-age=31536000, immutable" } },
        { glob: "**", headers: { "Cache-Control": "max-age=1800" } },
      ],
    });
    expect(config.rewrites).toBeUndefined();
  });

  it.each([["static-site"], [null], ["node-service"]])(
    "leaves %s on the single short-TTL header rule with no rewrites",
    (recipe) => {
      expect(hostingConfigForRecipe(recipe as string | null)).toEqual({
        headers: [{ glob: "**", headers: { "Cache-Control": "max-age=1800" } }],
      });
    },
  );
});

describe("withCollectedFile", () => {
  it("adds the file to the manifest as sha256(gzip) with the gzipped blob, leaving the source untouched", () => {
    const png = Buffer.from("PNG-BYTES");
    const next = withCollectedFile(collected, "/_octogee/og.png", png);

    const expectedGz = zlib.gzipSync(png);
    const expectedHash = crypto.createHash("sha256").update(expectedGz).digest("hex");
    expect(next.files["/_octogee/og.png"]).toBe(expectedHash);
    expect(Buffer.from(next.blobs[expectedHash], "base64")).toEqual(expectedGz);
    expect(next.files["/index.html"]).toBe("h1");
    expect(collected.files["/_octogee/og.png"]).toBeUndefined();
  });
});

describe("ensureChannel", () => {
  it("creates the channel with a duration ttl and returns its url + expireTime", async () => {
    const calls: { url: string; method: string; body: unknown }[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "GET", body: JSON.parse(String(init?.body)) });
      return res(true, { url: "https://octogee-eggman--draft-a1b2.web.app", expireTime: "2026-08-12T00:00:00Z" });
    });

    const r = await ensureChannel("octogee-eggman", "draft", 604800, {
      getToken: async () => "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(r).toEqual({
      success: true,
      url: "https://octogee-eggman--draft-a1b2.web.app",
      expireTime: "2026-08-12T00:00:00Z",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe(
      "https://firebasehosting.googleapis.com/v1beta1/sites/octogee-eggman/channels?channelId=draft",
    );
    expect(calls[0].body).toEqual({ ttl: "604800s" });
  });

  it("PATCHes the ttl when the channel already exists (409) and returns the refreshed channel", async () => {
    const calls: { url: string; method: string }[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (method === "POST") return res(false, { error: "already exists" }, 409);
      return res(true, { url: "https://ch.web.app", expireTime: "2026-08-12T00:00:00Z" });
    });

    const r = await ensureChannel("octogee-eggman", "shot", 3600, {
      getToken: async () => "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(r).toEqual({ success: true, url: "https://ch.web.app", expireTime: "2026-08-12T00:00:00Z" });
    expect(calls[1]).toEqual({
      url: "https://firebasehosting.googleapis.com/v1beta1/sites/octogee-eggman/channels/shot?updateMask=ttl",
      method: "PATCH",
    });
  });

  it("fails loudly when the ttl PATCH is rejected", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) =>
      (init?.method ?? "GET") === "POST" ? res(false, "exists", 409) : res(false, "nope", 400),
    );
    const r = await ensureChannel("octogee-eggman", "shot", 3600, {
      getToken: async () => "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toMatch(/Extend channel shot/);
  });

  it("fails loudly on a non-409 create error", async () => {
    const fetchImpl = vi.fn(async () => res(false, "boom", 503));
    const r = await ensureChannel("octogee-eggman", "shot", 3600, {
      getToken: async () => "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toMatch(/Create channel shot/);
  });

  it("fails loudly when the channel comes back without a url", async () => {
    const fetchImpl = vi.fn(async () => res(true, { expireTime: "2026-08-12T00:00:00Z" }));
    const r = await ensureChannel("octogee-eggman", "shot", 3600, {
      getToken: async () => "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toMatch(/no url/);
  });
});

describe("releaseToChannel", () => {
  it("POSTs the version to the channel's releases collection", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method} ${url}`);
      return res(true, {});
    });

    const r = await releaseToChannel("octogee-eggman", "draft", "sites/octogee-eggman/versions/v9", {
      getToken: async () => "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(r).toEqual({ success: true });
    expect(calls).toEqual([
      "POST https://firebasehosting.googleapis.com/v1beta1/sites/octogee-eggman/channels/draft/releases?versionName=sites/octogee-eggman/versions/v9",
    ]);
  });

  it("surfaces the API error instead of reporting success", async () => {
    const fetchImpl = vi.fn(async () => res(false, "channel gone", 404));
    const r = await releaseToChannel("octogee-eggman", "draft", "sites/octogee-eggman/versions/v9", {
      getToken: async () => "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toMatch(/channel gone/);
  });
});

describe("releaseVersion", () => {
  it("POSTs a new live release for the named version — that is the rollback primitive", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method} ${url}`);
      return res(true, {});
    });

    const r = await releaseVersion("octogee-eggman", "sites/octogee-eggman/versions/old", {
      getToken: async () => "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(r).toEqual({ success: true });
    expect(calls).toEqual([
      "POST https://firebasehosting.googleapis.com/v1beta1/sites/octogee-eggman/releases?versionName=sites/octogee-eggman/versions/old",
    ]);
  });

  it("surfaces the API error", async () => {
    const fetchImpl = vi.fn(async () => res(false, "no such version", 404));
    const r = await releaseVersion("octogee-eggman", "sites/octogee-eggman/versions/ghost", {
      getToken: async () => "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toMatch(/no such version/);
  });
});

describe("listReleases", () => {
  const apiReleases = [
    {
      name: "sites/octogee-eggman/releases/r1",
      releaseTime: "2026-08-01T10:00:00Z",
      message: "first",
      version: { name: "sites/octogee-eggman/versions/v1" },
    },
    {
      name: "sites/octogee-eggman/releases/r3",
      releaseTime: "2026-08-03T10:00:00Z",
      version: { name: "sites/octogee-eggman/versions/v3" },
    },
    {
      name: "sites/octogee-eggman/releases/r2",
      releaseTime: "2026-08-02T10:00:00Z",
      message: "second",
      version: { name: "sites/octogee-eggman/versions/v2" },
    },
  ];

  it("returns releases newest first with only the newest marked live, asking for 20", async () => {
    let requested = "";
    const fetchImpl = vi.fn(async (url: string) => {
      requested = url;
      return res(true, { releases: apiReleases });
    });

    const r = await listReleases("octogee-eggman", {
      getToken: async () => "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(r).toEqual({
      success: true,
      releases: [
        { versionName: "sites/octogee-eggman/versions/v3", releaseTime: "2026-08-03T10:00:00Z", live: true },
        {
          versionName: "sites/octogee-eggman/versions/v2",
          releaseTime: "2026-08-02T10:00:00Z",
          live: false,
          message: "second",
        },
        {
          versionName: "sites/octogee-eggman/versions/v1",
          releaseTime: "2026-08-01T10:00:00Z",
          live: false,
          message: "first",
        },
      ],
    });
    expect(requested).toBe(
      "https://firebasehosting.googleapis.com/v1beta1/sites/octogee-eggman/releases?pageSize=20",
    );
  });

  it("drops releases with no version (nothing to roll back to) and logs the skip", async () => {
    const logged: string[] = [];
    const fetchImpl = vi.fn(async () =>
      res(true, {
        releases: [
          { releaseTime: "2026-08-04T10:00:00Z" },
          { releaseTime: "2026-08-03T10:00:00Z", version: { name: "sites/octogee-eggman/versions/v3" } },
        ],
      }),
    );

    const r = await listReleases("octogee-eggman", {
      getToken: async () => "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      log: (m) => logged.push(m),
    });

    expect(r).toEqual({
      success: true,
      releases: [
        { versionName: "sites/octogee-eggman/versions/v3", releaseTime: "2026-08-03T10:00:00Z", live: true },
      ],
    });
    expect(logged.join(" ")).toMatch(/Skipped 1 release/);
  });

  it("returns an empty list (not an error) when the site has never been released", async () => {
    const fetchImpl = vi.fn(async () => res(true, {}));
    const r = await listReleases("octogee-eggman", {
      getToken: async () => "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r).toEqual({ success: true, releases: [] });
  });

  it("surfaces the API error", async () => {
    const fetchImpl = vi.fn(async () => res(false, "denied", 403));
    const r = await listReleases("octogee-eggman", {
      getToken: async () => "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toMatch(/denied/);
  });
});
