import { describe, expect, it, vi } from "vitest";

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
  HIDDEN: new Set(["AGENTS.md", ".git"]),
  giteaSudoUser: vi.fn(),
  isTargetPathWritable: vi.fn(),
  pathHasReservedOrHiddenSegment: vi.fn(),
  repoContentsApi: vi.fn(),
}));

import {
  blobFileEntries,
  repoFileEntries,
  sortWorkspaceFiles,
  workspaceFilesResponse,
} from "../routes/workspace/files.js";
import { repoContentsApi } from "../routes/workspace/helpers.js";
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

describe("workspace file list helpers", () => {
  it("maps visible repo entries and hides reserved or dot-prefixed names", () => {
    const files = repoFileEntries([
      { name: "src", path: "src", type: "dir" },
      { name: "README.md", path: "README.md", type: "file", size: 12 },
      { name: ".env", path: ".env", type: "file", size: 4 },
      { name: "AGENTS.md", path: "AGENTS.md", type: "file", size: 8 },
    ]);

    expect(files).toEqual([
      { name: "src", path: "src", type: "dir", size: 0, source: "git" },
      { name: "README.md", path: "README.md", type: "file", size: 12, source: "git" },
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
});
