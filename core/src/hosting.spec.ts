import { afterAll, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import zlib from "node:zlib";

import { collectDistFiles, deployCollectedFiles } from "./hosting";

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
    const secret = path.join(os.tmpdir(), `secret-${process.pid}-${dir.length}`);
    fs.writeFileSync(secret, "KSA-TOKEN-SHOULD-NOT-PUBLISH");
    tmpDirs.push(secret);
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

const collected = { files: { "/index.html": "h1", "/app.js": "h2" }, blobs: { h1: "AAA", h2: "BBB" } };

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
});
