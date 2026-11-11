import * as fs from "fs";
import { parseTimeZone } from "@octogee/shared/types/time-zone";
import * as path from "path";

import { userEntitlements, type UserEntitlementInputs } from "@octogee/shared/types/user-entitlements";
import {
  USER_OWNED_CONTEXT_FILES,
  PLATFORM_CONVERGED_CONTEXT_FILES,
  readTierTemplateFile,
} from "./tier-template-files.js";
import { CUSTOMERS_DIR, log } from "./config.js";

function writeAtomic(target: string, content: string): void {
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, content, "utf-8");
  fs.renameSync(tmp, target);
}

// Re-asserts AGENTS.md/TOOLS.md to the platform's content for the user's
// current plan — the same convergence semantics as the model pin (idempotent,
// only-on-drift so a reconcile tick that finds no change makes no write and no
// git history churn). Every plan converges, including paid users: these two
// files are the platform's own capability documentation, nobody chose their
// contents, and a plan that never re-asserts them keeps whatever shipped the
// day the workspace was seeded — which is how a user ends up reading a
// months-old tool manual while the gateway image ships current tools.
// User edits to these two files lose; SOUL.md, USER.md, MEMORY.md and
// memory/*.md stay user-owned and are where personalization belongs.
// PLATFORM_CONVERGED_CONTEXT_FILES is the single list this function and the
// seed-once writer both honor, so the two can never drift apart on which files
// are platform-owned.
export const UNKNOWN_TIME_ZONE = "unknown";
const TIME_ZONE_LINE = /^(- \*\*Time ?zone:\*\*)[^\n]*$/imu;
const NAME_LINE = /^(- \*\*Name:\*\*[^\n]*\n)/mu;

// USER.md is user-owned: the agent fills it in. The one platform-written
// fact in it is the user's time zone, which the app captures from their
// browser, so this rewrites exactly that line (or adds it under the Name line
// the template seeds) and touches nothing else. A file without either anchor is
// left to the user.
export function reassertUserTimeZoneLine(customerDir: string, timeZone: string | null): boolean {
  if (!timeZone) return false;
  const file = path.join(customerDir, "USER.md");
  if (!fs.existsSync(file)) return false;
  const existing = fs.readFileSync(file, "utf-8");
  const desired = TIME_ZONE_LINE.test(existing)
    ? existing.replace(TIME_ZONE_LINE, `$1 ${timeZone}`)
    : existing.replace(NAME_LINE, `$1- **Timezone:** ${timeZone}\n`);
  if (desired === existing) return false;
  writeAtomic(file, desired);
  return true;
}

export function reassertConvergedContextFiles(
  slug: string,
  customerDir: string,
  userData: UserEntitlementInputs & { timeZone?: unknown },
  vars: Record<string, string> = {},
): string[] {
  const policy = userEntitlements().contextFilePolicy(userData);
  const userOwned = policy.removedFiles.filter((file) => USER_OWNED_CONTEXT_FILES.has(file));
  if (userOwned.length > 0) {
    throw new Error(`[context-files] ${slug}: policy may not remove user-owned ${userOwned.join(", ")}`);
  }

  const changed: string[] = [];
  if (reassertUserTimeZoneLine(customerDir, parseTimeZone(userData.timeZone))) {
    changed.push("USER.md");
    log(`[context-files] ${slug}: USER.md time zone set to ${String(userData.timeZone)}`);
  }
  for (const file of PLATFORM_CONVERGED_CONTEXT_FILES) {
    const desired = readTierTemplateFile(policy.templateKey, file, vars);
    const dest = path.join(customerDir, file);
    const existing = fs.existsSync(dest) ? fs.readFileSync(dest, "utf-8") : null;
    if (existing === desired) continue;
    writeAtomic(dest, desired);
    changed.push(file);
  }
  if (changed.length > 0) {
    log(`[context-files] ${slug}: converged ${changed.join(", ")} to the ${policy.templateKey} template`);
  }

  const removed: string[] = [];
  for (const file of policy.removedFiles) {
    const dest = path.join(customerDir, file);
    if (!fs.existsSync(dest)) continue;
    fs.rmSync(dest);
    removed.push(file);
  }
  if (removed.length > 0) {
    log(`[context-files] ${slug}: removed ${removed.join(", ")}`);
  }

  return [...changed, ...removed];
}

// Convenience wrapper for adapters that only have the reassert userData bag
// (which carries the slug as `username`, matching byot-sync's convention) —
// avoids every call site re-deriving the user directory from CUSTOMERS_DIR.
// A missing/non-string username is an upstream payload bug, never a valid
// skip: throw so the lifecycle's per-domain catch logs it loudly (the mount
// still completes) instead of the convergence silently not happening.
export function reassertConvergedContextFilesForSlug(
  userData: UserEntitlementInputs & { username?: unknown; timeZone?: unknown },
  usersDir: string = CUSTOMERS_DIR,
): string[] {
  const slug = userData.username;
  if (typeof slug !== "string" || !slug) {
    throw new Error(
      `[context-files] reassert userData has no username (got ${JSON.stringify(slug)}) — upstream payload bug`,
    );
  }
  return reassertConvergedContextFiles(slug, path.join(usersDir, slug), userData);
}
