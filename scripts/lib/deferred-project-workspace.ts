import * as fs from "fs";
import * as path from "path";

import { log, CUSTOMERS_DIR } from "./config.js";

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
    "Builder runtime, not here. Files you expect may be absent until then.",
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
