import * as fs from "fs";
import { parseTimeZone } from "@octogee/shared/types/time-zone";
import * as path from "path";

import { resolveBillingProfile, type TierResolvable } from "@octogee/shared/types/billing";
import {
  PLATFORM_CONVERGED_CONTEXT_FILES,
  readTierTemplateFile,
  type TemplateTier,
} from "./tier-template-files.js";
import { CUSTOMERS_DIR, log } from "./config.js";

// The seed tier and the converged tier are deliberately different concepts: a
// workspace is seeded once from whatever tier the customer signed up on, and
// converges from then on onto whatever their plan resolves to today. A
// trial-boosted signup seeds tiers/trial/ and converges onto tiers/free/ when
// the boost lapses, onto tiers/paid/ when they subscribe.
// Trial state is checked before model access on purpose: a Signup Offer whose
// Personal plan is personal_free still resolves modelAccess "house_only", and
// that customer is mid-onboarding on a trial, not a lapsed free user.
function convergedContextTemplateTier(plan: {
  modelAccess: string;
  rail: string;
  trialDaysRemaining: number | null;
}): TemplateTier {
  if (plan.rail === "signup_offer" || plan.trialDaysRemaining !== null) return "trial";
  if (plan.modelAccess === "house_only") return "free";
  return "paid";
}

// Files the platform REMOVES for customers on the free template: they are already
// bootstrapped by platform onboarding by the time the coach runs, so a seeded
// BOOTSTRAP.md (pre-removal seeds, or a Gitea boot-sync resurrection) is dead
// context weight in exactly the tier where context is the budget. The
// mount-time reassert re-deletes it on the gateway's own disk, which is what
// the agent reads; reaching Gitea needs a commit, and the only commit path is
// the agent's own workspace_commit. Same drift-only semantics as the converged
// writes: absent file, no-op, no churn.
const CONVERGED_CONTEXT_REMOVED_FILES = ["BOOTSTRAP.md"] as const;

function writeAtomic(target: string, content: string): void {
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, content, "utf-8");
  fs.renameSync(tmp, target);
}

// Re-asserts AGENTS.md/TOOLS.md to the platform's content for the customer's
// current plan — the same convergence semantics as the model pin (idempotent,
// only-on-drift so a reconcile tick that finds no change makes no write and no
// git history churn). Every plan converges, including paid Builders: these two
// files are the platform's own capability documentation, nobody chose their
// contents, and a plan that never re-asserts them keeps whatever shipped the
// day the workspace was seeded — which is how a Builder ends up reading a
// months-old tool manual while the gateway image ships current tools.
// Customer edits to these two files lose; SOUL.md, USER.md, MEMORY.md and
// memory/*.md stay customer-owned and are where personalization belongs.
// PLATFORM_CONVERGED_CONTEXT_FILES is the single list this function and the
// seed-once writer both honor, so the two can never drift apart on which files
// are platform-owned.
export const UNKNOWN_TIME_ZONE = "unknown";
const TIME_ZONE_LINE = /^(- \*\*Time ?zone:\*\*)[^\n]*$/imu;
const NAME_LINE = /^(- \*\*Name:\*\*[^\n]*\n)/mu;

// USER.md is customer-owned: the coach fills it in. The one platform-written
// fact in it is the Builder's time zone, which the app captures from their
// browser, so this rewrites exactly that line (or adds it under the Name line
// the template seeds) and touches nothing else. A file without either anchor is
// left to the Builder.
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
  userData: TierResolvable & { timeZone?: unknown },
  vars: Record<string, string> = {},
): string[] {
  const plan = resolveBillingProfile(userData);
  const templateTier = convergedContextTemplateTier(plan);

  const changed: string[] = [];
  if (reassertUserTimeZoneLine(customerDir, parseTimeZone(userData.timeZone))) {
    changed.push("USER.md");
    log(`[context-files] ${slug}: USER.md time zone set to ${String(userData.timeZone)}`);
  }
  for (const file of PLATFORM_CONVERGED_CONTEXT_FILES) {
    const desired = readTierTemplateFile(templateTier, file, vars);
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
  const removable = templateTier === "free" ? CONVERGED_CONTEXT_REMOVED_FILES : [];
  for (const file of removable) {
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
  userData: TierResolvable & { username?: unknown; timeZone?: unknown },
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
