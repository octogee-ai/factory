import * as fs from "fs";
import * as path from "path";

import { resolveBillingProfile, type TierResolvable } from "@octogee/shared/types/billing";
import { PLATFORM_CONVERGED_CONTEXT_FILES, readTierTemplateFile } from "./tier-template-files.js";
import { CUSTOMERS_DIR, log } from "./config.js";

// The tier dir whose AGENTS.md/TOOLS.md content is authoritative for every
// house_only plan, regardless of which legacy tier dir seeded the customer's
// workspace at signup (a trial-boosted signup seeds tiers/trial/, but if the
// boost lapses into house_only the coach must converge onto tiers/free/ — the
// seed tier and the converged tier are deliberately different concepts).
const CONVERGED_CONTEXT_TEMPLATE_TIER = "free";

// Files the platform REMOVES for house_only plans: a free customer is already
// bootstrapped by platform onboarding by the time the coach runs, so a seeded
// BOOTSTRAP.md (pre-removal seeds, or a Gitea boot-sync resurrection — the
// mount-time reassert re-deletes it and the periodic workspace git sync
// commits the deletion) is dead context weight in exactly the tier where
// context is the budget. Same drift-only semantics as the converged writes:
// absent file, no-op, no churn.
const CONVERGED_CONTEXT_REMOVED_FILES = ["BOOTSTRAP.md"] as const;

function writeAtomic(target: string, content: string): void {
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, content, "utf-8");
  fs.renameSync(tmp, target);
}

// Re-asserts AGENTS.md/TOOLS.md to the platform's free-tier content for
// house_only plans only — the same convergence semantics as the model pin
// (idempotent, only-on-drift so a reconcile tick that finds no change makes
// no write and no git history churn). Every other context file (SOUL.md,
// USER.md, MEMORY.md, memory/*.md) stays customer-owned: PLATFORM_CONVERGED_CONTEXT_FILES
// is the single list this function and the seed-once writer both honor, so the
// two can never drift apart on which files are platform-owned. A plan that is not
// house_only (paid, or a live Signup Offer) is a no-op — including for a
// customer who WAS house_only and has since upgraded, which is how ownership
// returns to the customer without deleting anything they wrote.
export function reassertConvergedContextFiles(
  slug: string,
  customerDir: string,
  userData: TierResolvable,
  vars: Record<string, string> = {},
): string[] {
  const plan = resolveBillingProfile(userData);
  if (plan.modelAccess !== "house_only") return [];

  const changed: string[] = [];
  for (const file of PLATFORM_CONVERGED_CONTEXT_FILES) {
    const desired = readTierTemplateFile(CONVERGED_CONTEXT_TEMPLATE_TIER, file, vars);
    const dest = path.join(customerDir, file);
    const existing = fs.existsSync(dest) ? fs.readFileSync(dest, "utf-8") : null;
    if (existing === desired) continue;
    writeAtomic(dest, desired);
    changed.push(file);
  }
  if (changed.length > 0) {
    log(`[context-files] ${slug}: converged ${changed.join(", ")} to the free-tier template`);
  }

  const removed: string[] = [];
  for (const file of CONVERGED_CONTEXT_REMOVED_FILES) {
    const dest = path.join(customerDir, file);
    if (!fs.existsSync(dest)) continue;
    fs.rmSync(dest);
    removed.push(file);
  }
  if (removed.length > 0) {
    log(
      `[context-files] ${slug}: removed ${removed.join(", ")} — platform onboarding already bootstrapped this workspace`,
    );
  }

  return [...changed, ...removed];
}

// Convenience wrapper for adapters that only have the reassert userData bag
// (which carries the slug as `username`, matching byot-sync's convention) —
// avoids every call site re-deriving the customer directory from CUSTOMERS_DIR.
// A missing/non-string username is an upstream payload bug, never a valid
// skip: throw so the lifecycle's per-domain catch logs it loudly (the mount
// still completes) instead of the convergence silently not happening.
export function reassertConvergedContextFilesForSlug(
  userData: TierResolvable & { username?: unknown },
  customersDir: string = CUSTOMERS_DIR,
): string[] {
  const slug = userData.username;
  if (typeof slug !== "string" || !slug) {
    throw new Error(
      `[context-files] reassert userData has no username (got ${JSON.stringify(slug)}) — upstream payload bug`,
    );
  }
  return reassertConvergedContextFiles(slug, path.join(customersDir, slug), userData);
}
