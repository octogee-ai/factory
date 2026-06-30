import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FleetBrokerClient } from "../lib/fleet-broker-client.js";
import { createBrokeredBlobStore } from "../lib/blob-sync-broker.js";

const fetchMock = vi.fn();
const tempDirs: string[] = [];

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempFile(name: string, content = ""): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "octogee-blob-sync-"));
  tempDirs.push(dir);
  const file = join(dir, name);
  await writeFile(file, content);
  return file;
}

function client(overrides: Partial<FleetBrokerClient> = {}): FleetBrokerClient {
  return {
    blobDownloadUrl: vi.fn(async () => ({ url: "https://signed.test/download", method: "GET" })),
    blobUploadUrl: vi.fn(async () => ({ url: "https://signed.test/upload", method: "PUT" })),
    ...overrides,
  } as FleetBrokerClient;
}

describe("createBrokeredBlobStore", () => {
  it("downloads through a signed broker URL and writes the destination file", async () => {
    fetchMock.mockResolvedValue(new Response(new Uint8Array([65, 66]), { status: 200 }));
    const c = client();
    const destination = await tempFile("asset.bin");

    await createBrokeredBlobStore(c).download({
      slug: "acme",
      relativePath: "images/logo.png",
      gcsPath: "unused-by-broker",
      destination,
    });

    expect(c.blobDownloadUrl).toHaveBeenCalledWith({ slug: "acme", path: "images/logo.png" });
    expect(fetchMock).toHaveBeenCalledWith("https://signed.test/download", { method: "GET" });
    await expect(readFile(destination, "utf8")).resolves.toBe("AB");
  });

  it("uploads local bytes through a signed broker URL with the declared content type", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    const c = client();
    const localPath = await tempFile("asset.txt", "hello");

    await createBrokeredBlobStore(c).upload({
      slug: "acme",
      relativePath: "docs/readme.txt",
      gcsPath: "unused-by-broker",
      localPath,
      mimeType: "text/plain",
      size: 5,
    });

    expect(c.blobUploadUrl).toHaveBeenCalledWith({
      slug: "acme",
      path: "docs/readme.txt",
      mimeType: "text/plain",
      size: 5,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://signed.test/upload",
      expect.objectContaining({
        method: "PUT",
        headers: { "Content-Type": "text/plain" },
        body: Buffer.from("hello"),
      }),
    );
  });

  it("includes response status and text when signed download or upload fails", async () => {
    const c = client();
    fetchMock.mockResolvedValueOnce(new Response("expired", { status: 403 }));

    await expect(createBrokeredBlobStore(c).download({
      slug: "acme",
      relativePath: "images/logo.png",
      gcsPath: "unused",
      destination: await tempFile("logo.png"),
    })).rejects.toThrow("blob download acme/images/logo.png failed: 403 expired");

    fetchMock.mockResolvedValueOnce(new Response("too large", { status: 413 }));
    await expect(createBrokeredBlobStore(c).upload({
      slug: "acme",
      relativePath: "images/logo.png",
      gcsPath: "unused",
      localPath: await tempFile("logo-upload.png", "x"),
      mimeType: "image/png",
      size: 1,
    })).rejects.toThrow("blob upload acme/images/logo.png failed: 413 too large");
  });
});
