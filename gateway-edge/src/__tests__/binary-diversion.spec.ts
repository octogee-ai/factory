import { mkdtemp, readFile, rm, symlink, truncate, writeFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

import { gitStatus } from "../lib/workspace-git.js";
import { storeWorkspaceBlob } from "../lib/workspace-blob.js";
import {
  divertWorktreeBinaries,
  isDivertablePath,
  looksBinary,
  MAX_DIVERTED_BLOB_BYTES,
  type DivertBinariesDeps,
} from "../lib/binary-diversion.js";
import type { WorkspaceGitStatusEntry } from "../lib/workspace-git.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "octogee-divert-"));
  dirs.push(dir);
  return dir;
}

const target = { slug: "aug29", projectSlug: null, gcsPrefix: "customers/aug29" };

function deps(
  entries: WorkspaceGitStatusEntry[],
  store = vi.fn(async () => ({ gcsPath: "g", size: 1 })),
): DivertBinariesDeps {
  return {
    gitStatus: vi.fn(async () => ({ ok: true as const, entries })),
    storeWorkspaceBlob: store as unknown as DivertBinariesDeps["storeWorkspaceBlob"],
  };
}

describe("looksBinary", () => {
  it("treats a NUL byte as binary and plain text as text", () => {
    expect(looksBinary(Buffer.from([0x89, 0x50, 0x00, 0x4e]))).toBe(true);
    expect(looksBinary(Buffer.from("# notes\nhello\n"))).toBe(false);
  });

  it("ignores a NUL that appears beyond the sniff window, as git does", () => {
    const late = Buffer.concat([Buffer.alloc(9000, 0x61), Buffer.from([0x00])]);
    expect(looksBinary(late)).toBe(false);
  });
});

describe("isDivertablePath", () => {
  it("leaves the stores and git metadata alone", () => {
    expect(isDivertablePath(".blobs/avatar.png")).toBe(false);
    expect(isDivertablePath(".files/manifest.json")).toBe(false);
    expect(isDivertablePath(".git/config")).toBe(false);
  });

  it("refuses traversal and absolute paths", () => {
    expect(isDivertablePath("../escape.png")).toBe(false);
    expect(isDivertablePath("a/../../escape.png")).toBe(false);
    expect(isDivertablePath("/etc/passwd")).toBe(false);
  });

  it("accepts ordinary workspace paths", () => {
    expect(isDivertablePath("notes/diagram.png")).toBe(true);
  });
});

describe("divertWorktreeBinaries", () => {
  it("uploads a binary and removes it so the commit never sees it", async () => {
    const dir = await workspace();
    await mkdir(path.join(dir, "notes"), { recursive: true });
    const binary = path.join(dir, "notes/diagram.png");
    await writeFile(binary, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));

    const store = vi.fn(async () => ({ gcsPath: "g", size: 6 }));
    const result = await divertWorktreeBinaries(
      dir,
      target,
      deps([{ path: "notes/diagram.png", change: "untracked" }], store),
    );

    expect(result.diverted).toEqual([{ path: "notes/diagram.png", size: 6 }]);
    expect(result.failures).toEqual([]);
    expect(existsSync(binary)).toBe(false);
    expect(store).toHaveBeenCalledWith(target, "notes/diagram.png", expect.any(Buffer), "image/png");
  });

  it("leaves text files for git", async () => {
    const dir = await workspace();
    await writeFile(path.join(dir, "IDENTITY.md"), "- Name: Zippy\n");

    const store = vi.fn(async () => ({ gcsPath: "g", size: 1 }));
    const result = await divertWorktreeBinaries(
      dir,
      target,
      deps([{ path: "IDENTITY.md", change: "modified" }], store),
    );

    expect(result.diverted).toEqual([]);
    expect(store).not.toHaveBeenCalled();
    expect(existsSync(path.join(dir, "IDENTITY.md"))).toBe(true);
  });

  it("never re-diverts what already lives in the blob store", async () => {
    const dir = await workspace();
    await mkdir(path.join(dir, ".blobs"), { recursive: true });
    await writeFile(path.join(dir, ".blobs/avatar.png"), Buffer.from([0x00, 0x01]));

    const store = vi.fn(async () => ({ gcsPath: "g", size: 2 }));
    const result = await divertWorktreeBinaries(
      dir,
      target,
      deps([{ path: ".blobs/avatar.png", change: "untracked" }], store),
    );

    expect(store).not.toHaveBeenCalled();
    expect(result.diverted).toEqual([]);
    expect(existsSync(path.join(dir, ".blobs/avatar.png"))).toBe(true);
  });

  it("skips deletions rather than trying to read them", async () => {
    const dir = await workspace();
    const result = await divertWorktreeBinaries(
      dir,
      target,
      deps([{ path: "gone.png", change: "deleted" }]),
    );
    expect(result).toEqual({ diverted: [], failures: [], failedPaths: [] });
  });

  it("reports an upload failure instead of deleting the file", async () => {
    const dir = await workspace();
    const binary = path.join(dir, "logo.png");
    await writeFile(binary, Buffer.from([0x00, 0x01]));

    const store = vi.fn(async () => {
      throw new Error("quota exceeded");
    });
    const result = await divertWorktreeBinaries(
      dir,
      target,
      deps([{ path: "logo.png", change: "untracked" }], store),
    );

    expect(result.diverted).toEqual([]);
    expect(result.failures[0]).toContain("quota exceeded");
    expect(existsSync(binary)).toBe(true);
  });

  it("surfaces a git status failure rather than silently committing binaries", async () => {
    const dir = await workspace();
    const result = await divertWorktreeBinaries(dir, target, {
      gitStatus: vi.fn(async () => ({
        ok: false as const,
        error: { code: "GIT_FAILED" as const, cwd: dir, status: 1, stderr: "boom" },
      })),
      storeWorkspaceBlob: vi.fn() as unknown as DivertBinariesDeps["storeWorkspaceBlob"],
    });
    expect(result.failures).toEqual(["git status failed: GIT_FAILED"]);
  });

  it("rejects an oversize blob without reading it into memory", async () => {
    const dir = await workspace();
    const big = path.join(dir, "huge.bin");
    await writeFile(big, Buffer.from([0x00]));
    await truncate(big, MAX_DIVERTED_BLOB_BYTES + 1);

    const store = vi.fn(async () => ({ gcsPath: "g", size: 0 }));
    const result = await divertWorktreeBinaries(
      dir,
      target,
      deps([{ path: "huge.bin", change: "untracked" }], store),
    );

    expect(store).not.toHaveBeenCalled();
    expect(result.failures[0]).toContain("exceeds the blob limit");
    expect(existsSync(big)).toBe(true);
  });

  it("refuses a symlink instead of reading and publishing whatever it points at", async () => {
    const dir = await workspace();
    const outside = path.join(dir, "..", `octogee-outside-${process.pid}.bin`);
    await writeFile(outside, Buffer.from([0x00, 0x01, 0x02]));
    dirs.push(outside);
    await symlink(outside, path.join(dir, "innocent.bin"));

    const store = vi.fn(async () => ({ gcsPath: "g", size: 3 }));
    const result = await divertWorktreeBinaries(
      dir,
      target,
      deps([{ path: "innocent.bin", change: "untracked" }], store),
    );

    expect(store).not.toHaveBeenCalled();
    expect(result.diverted).toEqual([]);
    expect(result.failures[0]).toContain("symlink");
    expect(existsSync(outside)).toBe(true);
  });

  it("finds a binary inside a brand-new directory, which git collapses by default", async () => {
    const dir = await workspace();
    execFileSync("git", ["init", "-b", "main", dir]);
    execFileSync("git", ["-C", dir, "config", "user.email", "t@t.t"]);
    execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
    await writeFile(path.join(dir, "README.md"), "hi\n");
    execFileSync("git", ["-C", dir, "add", "."]);
    execFileSync("git", ["-C", dir, "commit", "-m", "initial"]);

    await mkdir(path.join(dir, "images"), { recursive: true });
    await writeFile(path.join(dir, "images/logo.png"), Buffer.from([0x89, 0x50, 0x00]));

    const store = vi.fn(async () => ({ gcsPath: "g", size: 3 }));
    const result = await divertWorktreeBinaries(dir, target, {
      gitStatus,
      storeWorkspaceBlob: store as unknown as typeof storeWorkspaceBlob,
    });

    expect(result.diverted.map((d) => d.path)).toEqual(["images/logo.png"]);
    expect(existsSync(path.join(dir, "images/logo.png"))).toBe(false);
  });

  it("reads the file it uploads", async () => {
    const dir = await workspace();
    const bytes = Buffer.from([0x00, 0x11, 0x22]);
    await writeFile(path.join(dir, "a.bin"), bytes);
    const store = vi.fn(async () => ({ gcsPath: "g", size: 3 }));
    await divertWorktreeBinaries(dir, target, deps([{ path: "a.bin", change: "added" }], store));
    const uploaded = store.mock.calls[0][2] as unknown as Buffer;
    expect(Buffer.compare(uploaded, bytes)).toBe(0);
    await expect(readFile(path.join(dir, "a.bin")).catch(() => "gone")).resolves.toBe("gone");
  });
});
