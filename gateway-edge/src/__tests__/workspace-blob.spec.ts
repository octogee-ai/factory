import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileTarget } from "../lib/fileTarget.js";

const h = vi.hoisted(() => ({
  save: vi.fn(),
  delete: vi.fn(),
  getSignedUrl: vi.fn(),
  file: vi.fn(),
  bucket: vi.fn(),
  updateManifest: vi.fn(),
  removeFromManifest: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../lib/db.js", () => ({
  storage: {
    bucket: h.bucket,
  },
}));

vi.mock("../lib/manifest.js", () => ({
  updateManifest: h.updateManifest,
  removeFromManifest: h.removeFromManifest,
}));

vi.mock("../middleware/logging.js", () => ({
  logger: { warn: h.warn, error: vi.fn(), info: vi.fn() },
}));

import { removeWorkspaceBlob, storeWorkspaceBlob } from "../lib/workspace-blob.js";

const target: FileTarget = {
  slug: "alice",
  projectSlug: "site",
  provider: "gitea",
  org: "octogee-alice",
  repoName: "alice-site",
  gcsPrefix: "customers/alice/projects/site",
  sudoUser: "ws-alice",
};

beforeEach(() => {
  vi.clearAllMocks();
  h.file.mockReturnValue({
    save: h.save,
    delete: h.delete,
    getSignedUrl: h.getSignedUrl,
  });
  h.bucket.mockReturnValue({ file: h.file });
  h.save.mockResolvedValue(undefined);
  h.delete.mockResolvedValue(undefined);
  h.updateManifest.mockResolvedValue(undefined);
  h.removeFromManifest.mockResolvedValue(undefined);
  h.getSignedUrl.mockResolvedValue(["https://signed-thumb"]);
});

describe("storeWorkspaceBlob", () => {
  it("saves non-image blobs to GCS and writes the manifest placeholder", async () => {
    const result = await storeWorkspaceBlob(
      target,
      "files/report.pdf",
      Buffer.from("pdf"),
    );

    expect(h.file).toHaveBeenCalledWith("customers/alice/projects/site/files/report.pdf");
    expect(h.save).toHaveBeenCalledWith(Buffer.from("pdf"), {
      metadata: { contentType: "application/pdf" },
    });
    expect(h.updateManifest).toHaveBeenCalledWith("ws-alice", "octogee-alice", "alice-site", {
      "files/report.pdf": expect.objectContaining({
        type: "blob",
        gcsPath: "customers/alice/projects/site/files/report.pdf",
        size: 3,
        mimeType: "application/pdf",
        uploadedAt: expect.any(String),
      }),
    });
    expect(result).toEqual({
      gcsPath: "customers/alice/projects/site/files/report.pdf",
      size: 3,
    });
  });

  it("uses the caller-supplied content type when provided", async () => {
    await storeWorkspaceBlob(target, "files/custom.bin", Buffer.from("data"), "application/x-custom");

    expect(h.save).toHaveBeenCalledWith(Buffer.from("data"), {
      metadata: { contentType: "application/x-custom" },
    });
    expect(h.updateManifest).toHaveBeenCalledWith(
      "ws-alice",
      "octogee-alice",
      "alice-site",
      expect.objectContaining({
        "files/custom.bin": expect.objectContaining({ mimeType: "application/x-custom" }),
      }),
    );
  });
});

describe("removeWorkspaceBlob", () => {
  it("removes the blob, image thumbnail, and manifest entry", async () => {
    await removeWorkspaceBlob(target, "images/logo.png");

    expect(h.file).toHaveBeenCalledWith("customers/alice/projects/site/images/logo.png");
    expect(h.file).toHaveBeenCalledWith("customers/alice/projects/site/.thumbs/images/logo.png.png");
    expect(h.delete).toHaveBeenNthCalledWith(1, { ignoreNotFound: true });
    expect(h.delete).toHaveBeenNthCalledWith(2, { ignoreNotFound: true });
    expect(h.removeFromManifest).toHaveBeenCalledWith(
      "ws-alice",
      "octogee-alice",
      "alice-site",
      "images/logo.png",
    );
  });

  it("does not attempt thumbnail deletion for non-image blobs", async () => {
    await removeWorkspaceBlob(target, "docs/readme.pdf");

    expect(h.file).toHaveBeenCalledTimes(1);
    expect(h.file).toHaveBeenCalledWith("customers/alice/projects/site/docs/readme.pdf");
    expect(h.removeFromManifest).toHaveBeenCalledWith(
      "ws-alice",
      "octogee-alice",
      "alice-site",
      "docs/readme.pdf",
    );
  });
});
