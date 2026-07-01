import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/db", () => ({
  storage: { bucket: vi.fn() },
}));

vi.mock("../lib/manifest", () => ({
  getManifest: vi.fn(),
}));

vi.mock("../lib/github", () => ({
  isOversizeFile: vi.fn(),
}));

vi.mock("../lib/fileTarget", () => ({
  withFileTarget: vi.fn((handler) => handler),
}));

vi.mock("../routes/workspace/helpers", () => ({
  HIDDEN: new Set([".git"]),
  giteaSudoUser: vi.fn(() => "ws-alice"),
  isTargetPathWritable: vi.fn(),
  pathHasReservedOrHiddenSegment: vi.fn((path: string) => path.startsWith(".") ? "Access denied" : null),
  repoContentsApi: vi.fn(),
  repoCommitsApi: vi.fn(),
  repoTreeApi: vi.fn(),
}));

import {
  blobFileEntries,
  clearWorkspaceFileResponseCache,
  workspaceFileIndexResponse,
  workspaceFileResponse,
  repoFileEntries,
  sortWorkspaceFiles,
  workspaceFilesResponse,
} from "../routes/workspace/files.js";
import { repoContentsApi, repoTreeApi } from "../routes/workspace/helpers.js";
import { getManifest } from "../lib/manifest.js";
import { storage } from "../lib/db.js";
import type { Manifest } from "../lib/manifest.js";
import type { FileTarget } from "../lib/fileTarget.js";

const giteaTarget: FileTarget = {
  slug: "alice",
  projectSlug: null,
  provider: "gitea",
  org: "alice",
  repoName: "workspace",
  gcsPrefix: "customers/alice",
  sudoUser: "ws-alice",
  brokered: false,
};

const githubTarget: FileTarget = {
  slug: "bob",
  projectSlug: null,
  provider: "github",
  org: "bob",
  repoName: "site",
  gcsPrefix: "customers/bob",
  githubToken: "tok",
  brokered: true,
};

describe("workspace file list helpers", () => {
  beforeEach(() => {
    clearWorkspaceFileResponseCache();
    vi.mocked(repoContentsApi).mockReset();
    vi.mocked(repoTreeApi).mockReset();
    vi.mocked(getManifest).mockReset();
    vi.mocked(storage.bucket).mockReset();
  });

  it("maps visible repo entries, including customer-owned context files, and hides reserved or dot-prefixed names", () => {
    const files = repoFileEntries([
      { name: "src", path: "src", type: "dir" },
      { name: "README.md", path: "README.md", type: "file", size: 12 },
      { name: ".env", path: ".env", type: "file", size: 4 },
      { name: "AGENTS.md", path: "AGENTS.md", type: "file", size: 8 },
    ]);

    expect(files).toEqual([
      { name: "src", path: "src", type: "dir", size: 0, source: "git" },
      { name: "README.md", path: "README.md", type: "file", size: 12, source: "git" },
      { name: "AGENTS.md", path: "AGENTS.md", type: "file", size: 8, source: "git" },
    ]);
  });

  it("adds direct manifest blob children that are not already present in git", () => {
    const manifest: Manifest = {
      "assets/logo.png": {
        type: "blob",
        gcsPath: "customers/alice/assets/logo.png",
        size: 100,
        mimeType: "image/png",
        thumbnailUrl: "https://thumb.test/logo.png",
        uploadedAt: "2026-01-01T00:00:00.000Z",
      },
      "assets/nested/photo.png": {
        type: "blob",
        gcsPath: "customers/alice/assets/nested/photo.png",
        size: 200,
        mimeType: "image/png",
        uploadedAt: "2026-01-01T00:00:00.000Z",
      },
      "assets/git-backed.png": {
        type: "blob",
        gcsPath: "customers/alice/assets/git-backed.png",
        size: 300,
        mimeType: "image/png",
        uploadedAt: "2026-01-01T00:00:00.000Z",
      },
    };

    const entries = blobFileEntries(
      manifest,
      "assets",
      new Set(["assets/git-backed.png"]),
    );

    expect(entries).toEqual([
      {
        name: "logo.png",
        path: "assets/logo.png",
        type: "file",
        size: 100,
        source: "blob",
        thumbnailUrl: "https://thumb.test/logo.png",
      },
    ]);
  });

  it("sorts directories before files and then by name", () => {
    expect(sortWorkspaceFiles([
      { name: "z.md", path: "z.md", type: "file", size: 1, source: "git" },
      { name: "beta", path: "beta", type: "dir", size: 0, source: "git" },
      { name: "a.md", path: "a.md", type: "file", size: 1, source: "blob" },
      { name: "alpha", path: "alpha", type: "dir", size: 0, source: "git" },
    ])).toEqual([
      { name: "alpha", path: "alpha", type: "dir", size: 0, source: "git" },
      { name: "beta", path: "beta", type: "dir", size: 0, source: "git" },
      { name: "a.md", path: "a.md", type: "file", size: 1, source: "blob" },
      { name: "z.md", path: "z.md", type: "file", size: 1, source: "git" },
    ]);
  });

  it("preserves the legacy repo-404 response shape without readOnly", async () => {
    vi.mocked(repoContentsApi).mockRejectedValueOnce(new Error("Gitea API 404"));

    await expect(workspaceFilesResponse(giteaTarget, "", false)).resolves.toEqual({ files: [] });
  });

  it("serves repeated directory listings from the gateway cache", async () => {
    vi.mocked(repoContentsApi).mockResolvedValue([{ name: "README.md", path: "README.md", type: "file", size: 12 }]);

    await workspaceFilesResponse(githubTarget, "", false);
    await workspaceFilesResponse(githubTarget, "", false);

    expect(repoContentsApi).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent directory listing requests for the same repo path", async () => {
    let resolveListing: (value: unknown) => void = () => {};
    vi.mocked(repoContentsApi).mockReturnValue(new Promise((resolve) => {
      resolveListing = resolve;
    }));

    const first = workspaceFilesResponse(githubTarget, "", false);
    const second = workspaceFilesResponse(githubTarget, "", false);
    await Promise.resolve();
    expect(repoContentsApi).toHaveBeenCalledTimes(1);

    resolveListing([{ name: "README.md", path: "README.md", type: "file", size: 12 }]);
    await expect(Promise.all([first, second])).resolves.toEqual([
      { files: [{ name: "README.md", path: "README.md", type: "file", size: 12, source: "git" }], readOnly: true },
      { files: [{ name: "README.md", path: "README.md", type: "file", size: 12, source: "git" }], readOnly: true },
    ]);
  });

  it("builds the global file index from repo tree paths plus manifest-backed blobs", async () => {
    vi.mocked(repoTreeApi).mockResolvedValueOnce({
      paths: ["README.md", "src/index.ts", "assets/git-backed.png"],
      truncated: false,
    });
    vi.mocked(getManifest).mockResolvedValueOnce({
      "assets/git-backed.png": {
        type: "blob",
        gcsPath: "customers/alice/assets/git-backed.png",
        size: 300,
        mimeType: "image/png",
        uploadedAt: "2026-01-01T00:00:00.000Z",
      },
      "assets/logo.png": {
        type: "blob",
        gcsPath: "customers/alice/assets/logo.png",
        size: 100,
        mimeType: "image/png",
        uploadedAt: "2026-01-01T00:00:00.000Z",
      },
      ".files/hidden.png": {
        type: "blob",
        gcsPath: "customers/alice/.files/hidden.png",
        size: 100,
        mimeType: "image/png",
        uploadedAt: "2026-01-01T00:00:00.000Z",
      },
    });

    await expect(workspaceFileIndexResponse(giteaTarget, "main", false)).resolves.toEqual({
      files: [
        { path: "assets/git-backed.png", source: "git" },
        { path: "assets/logo.png", source: "blob" },
        { path: "README.md", source: "git" },
        { path: "src/index.ts", source: "git" },
      ],
      paths: ["assets/git-backed.png", "assets/logo.png", "README.md", "src/index.ts"],
      truncated: false,
    });
  });

  it("caches the global file index by target and ref", async () => {
    vi.mocked(repoTreeApi).mockResolvedValue({
      paths: ["README.md"],
      truncated: false,
    });
    vi.mocked(getManifest).mockResolvedValue({});

    await workspaceFileIndexResponse(giteaTarget, "main", false);
    await workspaceFileIndexResponse(giteaTarget, "main", false);

    expect(repoTreeApi).toHaveBeenCalledTimes(1);
    expect(getManifest).toHaveBeenCalledTimes(1);
  });

  it("returns null for a missing git-backed file instead of throwing", async () => {
    vi.mocked(getManifest).mockResolvedValueOnce({});
    vi.mocked(repoContentsApi).mockRejectedValueOnce(new Error("Gitea API 404"));

    await expect(workspaceFileResponse(giteaTarget, "README.md")).resolves.toBeNull();
  });

  it("serves manifest-backed blobs from GCS without asking the repo contents API", async () => {
    const getSignedUrl = vi.fn().mockResolvedValue(["https://signed.test/logo.png"]);
    const file = vi.fn(() => ({ getSignedUrl }));
    vi.mocked(storage.bucket).mockReturnValue({ file } as never);
    vi.mocked(getManifest).mockResolvedValueOnce({
      "assets/logo.png": {
        type: "blob",
        gcsPath: "customers/alice/assets/logo.png",
        mimeType: "image/png",
        size: 20,
        uploadedAt: "2026-01-01T00:00:00.000Z",
      },
    });

    await expect(workspaceFileResponse(giteaTarget, "assets/logo.png")).resolves.toEqual({
      content: null,
      downloadUrl: "https://signed.test/logo.png",
      mimeType: "image/png",
      size: 20,
      path: "assets/logo.png",
      source: "blob",
    });
    expect(file).toHaveBeenCalledWith("customers/alice/assets/logo.png");
    expect(repoContentsApi).not.toHaveBeenCalled();
  });
});
