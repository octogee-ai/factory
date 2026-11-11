import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findUnsafeUserGitMetadataEntry, findUnsafeGitMetadataEntry } from "./git-metadata.js";

describe("Git metadata containment", () => {
  let root: string;
  let metadata: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "git-metadata-validation-"));
    metadata = path.join(root, "alice", "workspace.git");
    fs.mkdirSync(path.join(metadata, "objects", "info"), { recursive: true });
    fs.mkdirSync(path.join(metadata, "refs", "heads"), { recursive: true });
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it.each([
    "commondir", "objects/info/alternates", "objects/info/http-alternates",
    "info/grafts", "refs/replace", "worktrees", "modules",
  ])("rejects the Git redirector %s", (entry) => {
    fs.mkdirSync(path.dirname(path.join(metadata, entry)), { recursive: true });
    fs.writeFileSync(path.join(metadata, entry), "external\n");
    expect(findUnsafeGitMetadataEntry(metadata, root)).toBe(entry);
    expect(findUnsafeUserGitMetadataEntry(path.join(root, "alice"))).toBe(`workspace.git/${entry}`);
  });

  it.each(["refs/heads/main", "objects/ab/1234", "logs/refs/heads/main"])("rejects a dangling nested link at %s", (entry) => {
    fs.mkdirSync(path.dirname(path.join(metadata, entry)), { recursive: true });
    fs.symlinkSync(path.join(root, "absent"), path.join(metadata, entry));
    expect(findUnsafeGitMetadataEntry(metadata, root)).toBe(entry);
  });

  it("rejects linked ancestors even when the repository itself is a directory", () => {
    fs.renameSync(path.join(root, "alice"), path.join(root, "other"));
    fs.symlinkSync(path.join(root, "other"), path.join(root, "alice"));
    expect(findUnsafeGitMetadataEntry(metadata, root)).not.toBeNull();
  });

  it("reports unreadable or missing metadata instead of accepting it", () => {
    fs.rmSync(metadata, { recursive: true });
    expect(() => findUnsafeGitMetadataEntry(metadata, root)).toThrow();
  });

  it("preserves ordinary refs whose branch names resemble Git redirectors", () => {
    for (const name of ["commondir", "alternates", "modules", "worktrees"]) {
      fs.writeFileSync(path.join(metadata, "refs", "heads", name), "a".repeat(40));
    }
    const before = fs.readdirSync(path.join(metadata, "refs", "heads"));
    expect(findUnsafeGitMetadataEntry(metadata, root)).toBeNull();
    expect(findUnsafeUserGitMetadataEntry(path.join(root, "alice"))).toBeNull();
    expect(fs.readdirSync(path.join(metadata, "refs", "heads"))).toEqual(before);
  });

  it("requires a metadata root that contains the repository", () => {
    expect(() => findUnsafeGitMetadataEntry(metadata, path.join(root, "unrelated"))).toThrow("outside its root");
  });
});
