import * as fs from "fs";
import * as path from "path";
import { log, CUSTOMERS_DIR } from "./config.js";

export function migrateAgentsMd(): void {
  if (!fs.existsSync(CUSTOMERS_DIR)) return;
  const migrations: [RegExp, string][] = [
    [/\bprojectDefined\b/g, "userDreamDefined"],
    [/\bprojectSummary\b/g, "dreamSummary"],
  ];
  for (const slug of fs.readdirSync(CUSTOMERS_DIR)) {
    const agentsMdPath = path.join(CUSTOMERS_DIR, slug, "coach", "AGENTS.md");
    if (!fs.existsSync(agentsMdPath)) continue;
    let content = fs.readFileSync(agentsMdPath, "utf-8");
    let changed = false;
    for (const [pattern, replacement] of migrations) {
      const updated = content.replace(pattern, replacement);
      if (updated !== content) { content = updated; changed = true; }
    }
    if (changed) {
      fs.writeFileSync(agentsMdPath, content, "utf-8");
      log(`migrate: updated AGENTS.md for ${slug} (stale milestone names)`);
    }
  }
}

export function cleanupStaleLimitsMd(): void {
  if (!fs.existsSync(CUSTOMERS_DIR)) return;
  for (const slug of fs.readdirSync(CUSTOMERS_DIR)) {
    const limitsPath = path.join(CUSTOMERS_DIR, slug, "coach", "LIMITS.md");
    if (fs.existsSync(limitsPath)) {
      fs.unlinkSync(limitsPath);
      log(`throttle: removed stale LIMITS.md for ${slug}`);
    }
  }
}
