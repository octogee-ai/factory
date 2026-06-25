import * as fs from "fs";
import * as path from "path";

import { TEMPLATES_DIR } from "./config.js";
import { applyTemplatePlaceholders } from "./helpers.js";

const CUSTOMER_OWNED_CONTEXT_FILES = new Set(["AGENTS.md", "TOOLS.md"]);

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

function readTierTemplateFile(
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
    .filter((line) => !CUSTOMER_OWNED_CONTEXT_FILES.has(line.trim()))
    .join("\n");
  if (filtered === original) return false;

  fs.writeFileSync(gitignorePath, filtered, "utf-8");
  return true;
}

export function writeTierTemplateFiles(
  customerDir: string,
  tier: string,
  templateVars: Record<string, string>,
  today: string,
): string[] {
  const written: string[] = [];

  for (const file of listTierTemplateFiles(tier)) {
    const dest = path.join(customerDir, file);
    if (fs.existsSync(dest)) continue;
    fs.writeFileSync(dest, readTierTemplateFile(tier, file, templateVars), "utf-8");
    written.push(file);
  }

  fs.mkdirSync(path.join(customerDir, "memory"), { recursive: true });
  const memNote = path.join(customerDir, "memory", `${today}.md`);
  if (!fs.existsSync(memNote)) {
    fs.writeFileSync(
      memNote,
      `# Coach - ${today}\n\n- Workspace provisioned via Octogee.\n`,
      "utf-8",
    );
    written.push(`memory/${today}.md`);
  }

  if (removeLegacyContextIgnores(customerDir)) {
    written.push(".gitignore");
  }

  return written;
}
