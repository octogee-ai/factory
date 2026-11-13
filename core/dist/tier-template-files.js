import * as fs from "fs";
import * as path from "path";
import { TEMPLATES_DIR } from "./config.js";
import { applyTemplatePlaceholders } from "./helpers.js";
// The platform owns exactly AGENTS.md + TOOLS.md; SOUL.md/USER.md/MEMORY.md are
// the user's, BOOTSTRAP.md is transient. These two carry no per-user
// personalization placeholders (unlike SOUL.md/USER.md's {{ownerName}}) — the
// property that makes them safe for context-file-convergence.ts to re-assert
// unconditionally on every plan.
export const PLATFORM_CONVERGED_CONTEXT_FILES = new Set(["AGENTS.md", "TOOLS.md"]);
export const USER_OWNED_CONTEXT_FILES = new Set(["SOUL.md", "USER.md", "MEMORY.md"]);
function templatesRoot() {
    return process.env.OCTOGEE_TEMPLATES_DIR || TEMPLATES_DIR;
}
export function listTierTemplateFiles(templateKey) {
    const templateDir = path.join(templatesRoot(), "tiers", templateKey);
    if (!fs.existsSync(templateDir)) {
        throw new Error(`Context template directory not found: tiers/${templateKey} (looked in ${templateDir})`);
    }
    return fs
        .readdirSync(templateDir, { withFileTypes: true })
        .filter((d) => d.isFile() && d.name.endsWith(".md"))
        .map((d) => d.name)
        .sort();
}
export function readTierTemplateFile(templateKey, filename, vars) {
    const filePath = path.join(templatesRoot(), "tiers", templateKey, filename);
    if (!fs.existsSync(filePath)) {
        throw new Error(`Template missing: ${filePath}`);
    }
    return applyTemplatePlaceholders(fs.readFileSync(filePath, "utf-8"), vars);
}
function removeLegacyContextIgnores(customerDir) {
    const gitignorePath = path.join(customerDir, ".gitignore");
    let fd;
    try {
        fd = fs.openSync(gitignorePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    }
    catch (error) {
        const code = error.code;
        if (code === "ENOENT" || code === "ELOOP")
            return false;
        throw error;
    }
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile())
            return false;
        const original = fs.readFileSync(fd, "utf-8");
        const filtered = original.split(/\r?\n/).filter((line) => !PLATFORM_CONVERGED_CONTEXT_FILES.has(line.trim())).join("\n");
        if (filtered === original)
            return false;
        const staging = fs.mkdtempSync(path.join(customerDir, ".octogee-ignore-"));
        try {
            const pending = path.join(staging, "pending");
            fs.writeFileSync(pending, filtered, { encoding: "utf-8", flag: "wx", mode: stat.mode & 0o777 });
            const current = fs.lstatSync(gitignorePath, { throwIfNoEntry: false });
            if (current?.ino !== stat.ino || current.dev !== stat.dev || current.mtimeMs !== stat.mtimeMs || current.size !== stat.size)
                return false;
            fs.renameSync(pending, gitignorePath);
            return true;
        }
        finally {
            fs.rmSync(staging, { recursive: true, force: true });
        }
    }
    finally {
        fs.closeSync(fd);
    }
}
// No memory/ seed here: openclaw does memory, not Octogee — its session-memory
// hook mkdirs the directory on demand and every native reader tolerates absence.
export function writeTierTemplateFiles(customerDir, templateKey, templateVars) {
    const written = [];
    for (const file of listTierTemplateFiles(templateKey)) {
        const dest = path.join(customerDir, file);
        try {
            fs.writeFileSync(dest, readTierTemplateFile(templateKey, file, templateVars), { encoding: "utf-8", flag: "wx" });
            written.push(file);
        }
        catch (error) {
            if (error.code !== "EEXIST")
                throw error;
        }
    }
    if (removeLegacyContextIgnores(customerDir)) {
        written.push(".gitignore");
    }
    return written;
}
