import { lstatSync, readdirSync } from "node:fs";
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
function findUnsafeEntry(root, forbidden) {
    const rootStat = lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
        return ".";
    const pending = [""];
    while (pending.length > 0) {
        const relative = pending.pop();
        for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
            const child = relative ? `${relative}/${entry.name}` : entry.name;
            if (forbidden(child, entry.isDirectory()) || entry.isSymbolicLink()
                || (!entry.isFile() && !entry.isDirectory()))
                return child;
            if (entry.isDirectory())
                pending.push(child);
        }
    }
    return null;
}
export function findUnsafeGitMetadataEntry(gitDir, metadataRoot = gitDir) {
    const relative = path.relative(metadataRoot, gitDir);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`Git metadata is outside its root: ${gitDir}`);
    }
    let ancestor = metadataRoot;
    for (const segment of ["", ...relative.split(path.sep).filter(Boolean)]) {
        ancestor = path.join(ancestor, segment);
        const stat = lstatSync(ancestor);
        if (!stat.isDirectory() || stat.isSymbolicLink())
            return path.relative(gitDir, ancestor) || ".";
    }
    return findUnsafeEntry(gitDir, (entry) => GIT_INDIRECTIONS.has(entry));
}
export function findUnsafeCustomerGitMetadataEntry(customerMetadataDir) {
    return findUnsafeEntry(customerMetadataDir, (entry, directory) => {
        const parts = entry.split("/");
        if (parts[0] === "workspace.git") {
            return parts.length === 1 ? !directory : GIT_INDIRECTIONS.has(parts.slice(1).join("/"));
        }
        if (entry === "projects")
            return !directory;
        if (parts[0] === "projects" && parts[1]?.endsWith(".git")) {
            return parts.length === 2 ? !directory : GIT_INDIRECTIONS.has(parts.slice(2).join("/"));
        }
        return false;
    });
}
