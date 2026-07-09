import * as fs from "fs";
import * as path from "path";

import { TEMPLATES_DIR } from "./config.js";
import { applyTemplatePlaceholders } from "./helpers.js";

// The platform owns exactly AGENTS.md + TOOLS.md; SOUL.md/USER.md/MEMORY.md are
// the customer's, BOOTSTRAP.md is transient. These two carry no per-customer
// personalization placeholders (unlike SOUL.md/USER.md's {{ownerName}}) — the
// property that makes them safe for context-file-convergence.ts to re-assert
// unconditionally for house_only plans.
export const PLATFORM_CONVERGED_CONTEXT_FILES = new Set(["AGENTS.md", "TOOLS.md"]);

function templatesRoot(): string {
  return process.env.OCTOGEE_TEMPLATES_DIR || TEMPLATES_DIR;
}

export function listTierTemplateFiles(tier: string): string[] {
  const tierDir = path.join(templatesRoot(), "tiers", tier);
  if (!fs.existsSync(tierDir)) {
    throw new Error(
      `Tier template directory not found: tiers/${tier} (looked in ${tierDir})`,
    );
  }
  return fs
    .readdirSync(tierDir, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith(".md"))
    .map((d) => d.name)
    .sort();
}

export function readTierTemplateFile(
  tier: string,
  filename: string,
  vars: Record<string, string>,
): string {
  const filePath = path.join(templatesRoot(), "tiers", tier, filename);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Template missing: ${filePath}`);
  }
  return applyTemplatePlaceholders(fs.readFileSync(filePath, "utf-8"), vars);
}

function removeLegacyContextIgnores(customerDir: string): boolean {
  const gitignorePath = path.join(customerDir, ".gitignore");
  if (!fs.existsSync(gitignorePath)) return false;

  const original = fs.readFileSync(gitignorePath, "utf-8");
  const filtered = original
    .split(/\r?\n/)
    .filter((line) => !PLATFORM_CONVERGED_CONTEXT_FILES.has(line.trim()))
    .join("\n");
  if (filtered === original) return false;

  fs.writeFileSync(gitignorePath, filtered, "utf-8");
  return true;
}

// No memory/ seed here: openclaw does memory, not Octogee — its session-memory
// hook mkdirs the directory on demand and every native reader tolerates absence.
export function writeTierTemplateFiles(
  customerDir: string,
  tier: string,
  templateVars: Record<string, string>,
): string[] {
  const written: string[] = [];

  for (const file of listTierTemplateFiles(tier)) {
    const dest = path.join(customerDir, file);
    if (fs.existsSync(dest)) continue;
    fs.writeFileSync(dest, readTierTemplateFile(tier, file, templateVars), "utf-8");
    written.push(file);
  }

  if (removeLegacyContextIgnores(customerDir)) {
    written.push(".gitignore");
  }

  return written;
}
