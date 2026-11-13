import * as fs from "fs";
import * as path from "path";

import { log, CUSTOMERS_DIR } from "./config.js";
import { isValidProjectId, isValidUsername } from "../../shared/types/identity.js";

const OPENCLAW_WORKSPACE_MARKER_FILES = [
  "AGENTS.md",
  "SOUL.md",
  "IDENTITY.md",
  "USER.md",
] as const;

export function deferredProjectPlaceholder(slug: string, projectSlug: string): string {
  return [
    `# ${projectSlug}`,
    "",
    `This project's source lives on GitHub and is checked out on ${slug}'s own`,
    "isolated runtime, not here. Files you expect may be absent until then.",
    "",
    "Replace this file once the checkout lands.",
    "",
  ].join("\n");
}

export function seedDeferredProjectWorkspace(slug: string, projectSlug: string): boolean {
  const dest = path.join(CUSTOMERS_DIR, slug, "projects", projectSlug);
  fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
  if (OPENCLAW_WORKSPACE_MARKER_FILES.some((name) => fs.existsSync(path.join(dest, name)))) {
    return false;
  }
  fs.writeFileSync(
    path.join(dest, "AGENTS.md"),
    deferredProjectPlaceholder(slug, projectSlug),
    "utf-8",
  );
  log(`[git] ${slug}/${projectSlug} checkout deferred — seeded a placeholder workspace`);
  return true;
}

export function deferredProjectPlaceholderPaths(stateDir: string, slug: string): string[] {
  if (!isValidUsername(slug)) throw new Error("invalid deferred project workspace owner");
  const projects = path.join(stateDir, "customers", slug, "projects");
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(projects, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries.flatMap(entry => {
    if (!entry.isDirectory() || !isValidProjectId(entry.name)) return [];
    const filename = path.join(projects, entry.name, "AGENTS.md");
    const expected = deferredProjectPlaceholder(slug, entry.name);
    try {
      const stat = fs.lstatSync(filename);
      if (!stat.isFile() || stat.size !== Buffer.byteLength(expected) || fs.readFileSync(filename, "utf8") !== expected) return [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return [`customers/${slug}/projects/${entry.name}/AGENTS.md`];
  });
}
