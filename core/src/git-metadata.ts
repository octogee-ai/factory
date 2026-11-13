import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync } from "node:fs";
import * as path from "node:path";

const GIT_INDIRECTIONS = new Set([
  "commondir",
  "objects/info/alternates",
  "objects/info/http-alternates",
  "info/grafts",
  "refs/replace",
  "worktrees",
  "modules",
]);

function findUnsafeEntry(root: string, forbidden: (relative: string, directory: boolean) => boolean): string | null {
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return ".";
  const pending = [""];
  while (pending.length > 0) {
    const relative = pending.pop()!;
    for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (forbidden(child, entry.isDirectory()) || entry.isSymbolicLink()
        || (!entry.isFile() && !entry.isDirectory())) return child;
      if (entry.isDirectory()) pending.push(child);
    }
  }
  return null;
}

export function findUnsafeGitMetadataEntry(gitDir: string, metadataRoot = gitDir): string | null {
  const relative = path.relative(metadataRoot, gitDir);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Git metadata is outside its root: ${gitDir}`);
  }
  let ancestor = metadataRoot;
  for (const segment of ["", ...relative.split(path.sep).filter(Boolean)]) {
    ancestor = path.join(ancestor, segment);
    const stat = lstatSync(ancestor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return path.relative(gitDir, ancestor) || ".";
  }
  return findUnsafeEntry(gitDir, (entry) => GIT_INDIRECTIONS.has(entry));
}

export function findUnsafeUserGitMetadataEntry(userMetadataDir: string): string | null {
  return findUnsafeEntry(userMetadataDir, (entry, directory) => {
    const parts = entry.split("/");
    if (parts[0] === "workspace.git") {
      return parts.length === 1 ? !directory : GIT_INDIRECTIONS.has(parts.slice(1).join("/"));
    }
    if (entry === "projects") return !directory;
    if (parts[0] === "projects" && parts[1]?.endsWith(".git")) {
      return parts.length === 2 ? !directory : GIT_INDIRECTIONS.has(parts.slice(2).join("/"));
    }
    return false;
  });
}

export function readGitMetadataText(file: string, limit: number, { requireReadOnly = false } = {}): string | null {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ELOOP") return null;
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit) return null;
    if (requireReadOnly && ((stat.mode & 0o400) === 0 || (stat.mode & 0o333) !== 0)) return null;
    const bytes = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const read = readSync(fd, bytes, size, bytes.length - size, size);
      if (read === 0) break;
      size += read;
    }
    return size === stat.size ? bytes.toString("utf8", 0, size) : null;
  } finally {
    closeSync(fd);
  }
}
