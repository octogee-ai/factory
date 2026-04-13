/**
 * BYOT state sync — writes per-agent auth-profiles.json for customers
 * whose Firestore byotActive flag is true; removes it when false.
 *
 * After a mutation, triggers `openclaw secrets reload` so the in-memory
 * snapshot swaps without a gateway pod restart.
 *
 * Called from the provisioner's onSnapshot watcher in local-provisioner.ts.
 *
 * Idempotent: re-writing an existing file with identical content is a
 * no-op (file-content diff). Removing a non-existent file is safe.
 */

import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import {
  buildByotAuthProfilesJson,
  type ByotProfileInput,
} from "./byot-auth-profiles.js";
import { AGENTS_DIR, log } from "./config.js";

/** The agent id we write auth-profiles.json into. */
function agentIdForSlug(slug: string): string {
  return `octogee-${slug}-coach`;
}

function authProfilesPathForSlug(slug: string): string {
  return path.join(AGENTS_DIR, agentIdForSlug(slug), "agent", "auth-profiles.json");
}

/**
 * Pure — given Firestore user data, decide whether the customer should
 * have a BYOT auth-profiles.json today. Phase 1 supports only Anthropic.
 */
export function deriveDesiredByotState(userData: {
  byotActive?: boolean;
  workspaceSlug?: string;
  provisioning?: { openclaw?: { slug?: string; status?: string } };
}): { enabled: boolean; input: ByotProfileInput | null } {
  const status = userData.provisioning?.openclaw?.status;
  const slug = userData.workspaceSlug || userData.provisioning?.openclaw?.slug;
  if (!userData.byotActive || !slug || status !== "complete") {
    return { enabled: false, input: null };
  }
  return {
    enabled: true,
    input: { slug, provider: "anthropic" },
  };
}

/**
 * Write or remove auth-profiles.json to match desired state. Returns
 * true if the on-disk file actually changed (caller uses that signal
 * to decide whether to trigger secrets.reload).
 */
export function applyByotState(slug: string, enabled: boolean): boolean {
  const target = authProfilesPathForSlug(slug);
  const agentDir = path.dirname(target);

  if (!enabled) {
    if (fs.existsSync(target)) {
      fs.rmSync(target);
      log(`[byot-sync] ${slug}: removed auth-profiles.json (BYOT off)`);
      return true;
    }
    return false;
  }

  // Enabled: refuse to write if the agent dir doesn't exist yet. This
  // means the customer's coach hasn't been provisioned, and creating
  // an orphan auth-profiles.json would silently leave a dangling
  // SecretRef pointing at an agent OpenClaw doesn't know about.
  // The provisioner's onSnapshot will fire again once the customer's
  // provisioning completes — try then.
  if (!fs.existsSync(agentDir)) {
    log(`⚠ [byot-sync] ${slug}: agent dir missing (provisioning incomplete?) — skipping BYOT write`);
    return false;
  }

  const content = JSON.stringify(
    buildByotAuthProfilesJson({ slug, provider: "anthropic" }),
    null,
    2,
  );

  const existing = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;
  if (existing === content) {
    return false; // no-op — file already at desired state
  }

  // Atomic write via .tmp + rename so the resolver never sees a partial
  // file. Mode 0o600 hardens perms — even though this file holds only
  // a SecretRef shape (no plaintext key), the keyRef reveals which
  // Secret Manager secret a customer is bound to.
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, target);

  log(`[byot-sync] ${slug}: wrote auth-profiles.json (BYOT active)`);
  return true;
}

/**
 * Trigger OpenClaw's in-memory snapshot swap. Safe to call any time —
 * OpenClaw atomically keeps the last-known-good snapshot on failure.
 *
 * Invocation is via the local `openclaw` CLI which speaks to the same
 * gateway over its own WS auth. The gateway pod shares env with the
 * provisioner, so the CLI auto-discovers the local token.
 */
export function triggerSecretsReload(): void {
  const r = spawnSync("openclaw", ["secrets", "reload", "--json"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  if (r.status !== 0) {
    log(
      `⚠ [byot-sync] secrets reload returned non-zero (${r.status}): ${r.stderr?.trim() || r.stdout?.trim() || ""}`,
    );
    return;
  }
  log(`[byot-sync] secrets reload ok${r.stdout?.trim() ? ` — ${r.stdout.trim()}` : ""}`);
}

/**
 * One-shot sync for a single customer — apply the desired state and
 * trigger secrets reload if anything actually changed on disk.
 */
export function syncByotForCustomer(userData: {
  byotActive?: boolean;
  workspaceSlug?: string;
  provisioning?: { openclaw?: { slug?: string; status?: string } };
}): void {
  const desired = deriveDesiredByotState(userData);
  const slug = userData.workspaceSlug || userData.provisioning?.openclaw?.slug;
  if (!slug) return;

  const changed = applyByotState(slug, desired.enabled);
  if (changed) triggerSecretsReload();
}
