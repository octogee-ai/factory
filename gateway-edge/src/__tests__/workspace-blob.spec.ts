import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireWorkspaceMutationLeaseSync } from "@octogee/core/workspace-mutation-lease";
import type { FileTarget } from "../lib/fileTarget.js";

const h = vi.hoisted(() => ({
  save: vi.fn(),
  delete: vi.fn(),
  getSignedUrl: vi.fn(),
  file: vi.fn(),
  bucket: vi.fn(),
  updateManifest: vi.fn(),
  removeFromManifest: vi.fn(),
  getManifestForQuota: vi.fn(),
  warn: vi.fn(),
  reserveWorkspaceStorage: vi.fn(),
  finalizeWorkspaceStorageReservation: vi.fn(),
  rollbackWorkspaceStorageReservation: vi.fn(),
  releaseWorkspaceStorage: vi.fn(),
}));

vi.mock("../lib/db.js", () => ({
  db: {},
  storage: {
    bucket: h.bucket,
  },
}));

vi.mock("../lib/workspace-storage-quota.js", () => ({
  WorkspaceStorageQuotaError: class WorkspaceStorageQuotaError extends Error {
    name = "WorkspaceStorageQuotaError";
    code = "FREE_STORAGE_LIMIT";
    constructor(readonly limitBytes: number, readonly projectedBytes: number) {
      super("quota");
    }
  },
  reserveWorkspaceStorage: (...args: unknown[]) => h.reserveWorkspaceStorage(...args),
  finalizeWorkspaceStorageReservation: (...args: unknown[]) =>
    h.finalizeWorkspaceStorageReservation(...args),
  rollbackWorkspaceStorageReservation: (...args: unknown[]) =>
    h.rollbackWorkspaceStorageReservation(...args),
  releaseWorkspaceStorage: (...args: unknown[]) => h.releaseWorkspaceStorage(...args),
}));

vi.mock("../lib/manifest.js", () => ({
  updateManifest: h.updateManifest,
  removeFromManifest: h.removeFromManifest,
  getManifestForQuota: h.getManifestForQuota,
}));

vi.mock("../middleware/logging.js", () => ({
  logger: { warn: h.warn, error: vi.fn(), info: vi.fn() },
}));

import {
  removeWorkspaceBlob,
  storeWorkspaceBlob,
  WorkspaceBlobBusyError,
} from "../lib/workspace-blob.js";

const customersDir = `/tmp/octogee-workspace-blob-${process.pid}/customers`;
const originalCustomersDir = process.env.CUSTOMERS_DIR;
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
  process.env.CUSTOMERS_DIR = customersDir;
  fs.rmSync(path.dirname(customersDir), { recursive: true, force: true });
  fs.mkdirSync(path.join(path.dirname(customersDir), "git-metadata", "alice", "workspace.git"), {
    recursive: true,
  });
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
  h.getManifestForQuota.mockResolvedValue({});
  h.reserveWorkspaceStorage.mockImplementation(async (_db: unknown, input: {
    slug: string;
    path: string;
    newSize: number;
    manifestBytes: number;
    manifestPathBytes: number;
    limitBytes: number;
  }) => {
    const projectedBytes = input.manifestBytes - input.manifestPathBytes + input.newSize;
    if (projectedBytes > input.limitBytes) {
      const error = new Error("quota") as Error & Record<string, unknown>;
      Object.assign(error, {
        name: "WorkspaceStorageQuotaError",
        code: "FREE_STORAGE_LIMIT",
        limitBytes: input.limitBytes,
        projectedBytes,
      });
      throw error;
    }
    return {
      slug: input.slug,
      path: input.path,
      id: "reservation-1",
      previousSize: input.manifestPathBytes,
      newSize: input.newSize,
    };
  });
  h.finalizeWorkspaceStorageReservation.mockResolvedValue(undefined);
  h.rollbackWorkspaceStorageReservation.mockResolvedValue(undefined);
  h.releaseWorkspaceStorage.mockResolvedValue(undefined);
});

afterEach(() => {
  fs.rmSync(path.dirname(customersDir), { recursive: true, force: true });
  if (originalCustomersDir === undefined) delete process.env.CUSTOMERS_DIR;
  else process.env.CUSTOMERS_DIR = originalCustomersDir;
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
    expect(h.updateManifest).toHaveBeenCalledWith("customers/alice/projects/site", {
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
      "customers/alice/projects/site",
      expect.objectContaining({
        "files/custom.bin": expect.objectContaining({ mimeType: "application/x-custom" }),
      }),
    );
  });

  it("rejects a Free workspace upload before GCS when its projected manifest exceeds the configured limit", async () => {
    h.getManifestForQuota.mockResolvedValue({
      "files/existing.bin": { type: "blob", size: 8 },
    });

    await expect(storeWorkspaceBlob(
      { ...target, projectSlug: null },
      "files/new.bin",
      Buffer.from("123"),
      "application/octet-stream",
      { maxStorageBytes: 10 },
    )).rejects.toMatchObject({
      name: "WorkspaceStorageQuotaError",
      code: "FREE_STORAGE_LIMIT",
      limitBytes: 10,
      projectedBytes: 11,
    });
    expect(h.save).not.toHaveBeenCalled();
  });

  it("subtracts the replaced blob before applying the configured limit", async () => {
    h.getManifestForQuota.mockResolvedValue({
      "files/existing.bin": { type: "blob", size: 8 },
    });

    await expect(storeWorkspaceBlob(
      { ...target, projectSlug: null },
      "files/existing.bin",
      Buffer.from("1234567890"),
      "application/octet-stream",
      { maxStorageBytes: 10 },
    )).resolves.toMatchObject({ size: 10 });
    expect(h.save).toHaveBeenCalledOnce();
  });

  it("rolls back the atomic reservation when blob persistence fails", async () => {
    h.save.mockRejectedValueOnce(new Error("GCS unavailable"));

    await expect(storeWorkspaceBlob(
      { ...target, projectSlug: null },
      "files/new.bin",
      Buffer.from("123"),
      "application/octet-stream",
      { maxStorageBytes: 10 },
    )).rejects.toThrow("GCS unavailable");

    expect(h.rollbackWorkspaceStorageReservation).toHaveBeenCalledOnce();
    expect(h.finalizeWorkspaceStorageReservation).not.toHaveBeenCalled();
  });

  it("serializes a direct replacement with a staged autosave and supersedes the staged bytes", async () => {
    const workspaceTarget = {
      ...target,
      projectSlug: null,
      gcsPrefix: "customers/alice",
    };
    const workspaceDir = path.join(customersDir, "alice");
    const gitDir = path.join(path.dirname(customersDir), "git-metadata", "alice", "workspace.git");
    const pendingPath = path.join(workspaceDir, ".blobs", ".pending", "cover.png");
    fs.mkdirSync(path.dirname(pendingPath), { recursive: true });
    fs.writeFileSync(pendingPath, Buffer.from([0x00, 0x41]));

    const lease = acquireWorkspaceMutationLeaseSync({ workspaceDir, gitDir });
    expect(lease).not.toBeNull();
    await expect(storeWorkspaceBlob(
      workspaceTarget,
      "cover.png",
      Buffer.from([0x00, 0x42]),
      "image/png",
      { maxStorageBytes: 10 },
    )).rejects.toBeInstanceOf(WorkspaceBlobBusyError);
    expect(fs.existsSync(pendingPath)).toBe(true);

    lease!.release();
    await storeWorkspaceBlob(
      workspaceTarget,
      "cover.png",
      Buffer.from([0x00, 0x42]),
      "image/png",
      { maxStorageBytes: 10 },
    );

    expect(fs.existsSync(pendingPath)).toBe(false);
    expect(h.save).toHaveBeenCalledWith(Buffer.from([0x00, 0x42]), {
      metadata: { contentType: "image/png" },
    });
  });
});

describe("removeWorkspaceBlob", () => {
  it("removes the blob, image thumbnail, and manifest entry", async () => {
    await removeWorkspaceBlob(target, "images/logo.png");

    expect(h.file).toHaveBeenCalledWith("customers/alice/projects/site/images/logo.png");
    expect(h.file).toHaveBeenCalledWith("customers/alice/projects/site/.thumbs/images/logo.png.png");
    expect(h.delete).toHaveBeenNthCalledWith(1, { ignoreNotFound: true });
    expect(h.delete).toHaveBeenNthCalledWith(2, { ignoreNotFound: true });
    expect(h.removeFromManifest).toHaveBeenCalledWith("customers/alice/projects/site", "images/logo.png");
  });

  it("does not attempt thumbnail deletion for non-image blobs", async () => {
    await removeWorkspaceBlob(target, "docs/readme.pdf");

    expect(h.file).toHaveBeenCalledTimes(1);
    expect(h.file).toHaveBeenCalledWith("customers/alice/projects/site/docs/readme.pdf");
    expect(h.removeFromManifest).toHaveBeenCalledWith("customers/alice/projects/site", "docs/readme.pdf");
  });
});
