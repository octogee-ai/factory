/**
 * BYOT state sync — pure logic + filesystem reconciliation for
 * per-agent auth-profiles.json files. NO gateway RPC, NO subprocess
 * dependencies live here.
 *
 * The runtime hand-off (in-memory snapshot reload via gateway-rpc) lives
 * in `byot-sync-runtime.ts`. This split is intentional: the cross-package
 * `tests/` workspace typechecks specs that import from this file, and
 * pulling `gateway-rpc` (→ `ws`) into its transitive type graph would
 * force `tests/` to declare a `ws` dep it never uses at runtime.
 * Splitting keeps the pure-logic surface free of runtime deps.
 *
 * Idempotent: re-writing an existing file with identical content is a
 * no-op (file-content diff). Removing a non-existent file is safe.
 */

import * as fs from "fs";
import * as path from "path";
import {
  buildByotConfigForProvider,
  type Provider,
} from "./byot-multi-provider-config.js";
import { AGENTS_DIR, log } from "./config.js";

/** The agent id whose `agent/` dir we write per-agent BYOT files into. */
function agentIdForSlug(slug: string): string {
  return `octogee-${slug}-coach`;
}

function agentDirForSlug(slug: string): string {
  return path.join(AGENTS_DIR, agentIdForSlug(slug), "agent");
}

const BYOT_FILES = ["auth-profiles.json", "models.json"] as const;
type ByotFile = (typeof BYOT_FILES)[number];

export interface ByotInput {
  slug: string;
  provider: Provider;
  baseUrl?: string;
  model?: string;
}

/**
 * Pure — given Firestore user data, decide whether the customer should
 * have BYOT files written, and if so what provider config to render.
 */
export function deriveDesiredByotState(userData: {
  byotActive?: boolean;
  username?: string;
  provisioning?: { openclaw?: { status?: string } };
  systemConfig?: { byot?: { provider?: string; baseUrl?: string; model?: string } };
}): { enabled: boolean; input: ByotInput | null } {
  const status = userData.provisioning?.openclaw?.status;
  // Username IS the workspace slug per DATA-MODEL-REVIEW §11.
  const slug = userData.username;
  if (!userData.byotActive || !slug || status !== "complete") {
    return { enabled: false, input: null };
  }
  // Default to anthropic for backwards compat with Phase 1 metadata
  // that pre-dated the `provider` field on system/config.byot.
  const cfg = userData.systemConfig?.byot;
  const provider: Provider =
    cfg?.provider === "openai" || cfg?.provider === "openai-compatible"
      ? cfg.provider
      : "anthropic";
  return {
    enabled: true,
    input: { slug, provider, baseUrl: cfg?.baseUrl, model: cfg?.model },
  };
}

function writeAtomic(target: string, content: string): void {
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, target);
}

function removeIfExists(target: string): boolean {
  if (!fs.existsSync(target)) return false;
  fs.rmSync(target);
  return true;
}

/**
 * Detect a house-key auth-profiles.json (written by house-key-sync.ts at
 * throttle level 3 for non-BYOT customers). The two writers share the
 * same on-disk filename, so byot-sync MUST not delete or overwrite a
 * house-key file when BYOT is off — it would silently undo the §9.4
 * plan demotion every snapshot tick.
 *
 * Mirrors `isHouseKeyFile` in scripts/lib/house-key-sync.ts. Duplicated
 * here (vs. importing) to keep byot-sync.ts dependency-free of the
 * house-key module — they're meant to fail closed independently.
 */
function isHouseKeyAuthProfiles(content: string): boolean {
  try {
    const parsed = JSON.parse(content);
    const entry = parsed?.profiles?.["anthropic:default"];
    return entry?.__octogeeHouseKey === true;
  } catch {
    return false;
  }
}

/**
 * Reconcile every per-agent BYOT file (auth-profiles.json, models.json)
 * with the desired state. Returns true iff any file actually changed on
 * disk — caller uses that signal to decide whether to invoke
 * `openclaw secrets reload`.
 *
 * - When disabled, removes any of the BYOT files that exist.
 * - When enabled, writes the file(s) the chosen provider needs and
 *   removes any leftover files from the previous provider (e.g. switching
 *   anthropic → openai-compatible removes the auth-profiles.json that
 *   anthropic produced and writes models.json).
 */
export function applyByotState(slug: string, input: ByotInput | null): boolean {
  const dir = agentDirForSlug(slug);
  const filePath = (f: ByotFile) => path.join(dir, f);

  // Disabled — remove all BYOT files that exist, EXCEPT a house-key
  // auth-profiles.json (owned by house-key-sync.ts at level 3). Without
  // this guard, every provisioner snapshot tick on a non-BYOT L3
  // customer would clobber the just-written house-key file, leaving
  // OpenClaw to resolve the platform key from openclaw.json and
  // undermining §9.4 entirely. See review of PR #734.
  if (!input) {
    let changed = false;
    for (const f of BYOT_FILES) {
      const target = filePath(f);
      if (f === "auth-profiles.json" && fs.existsSync(target)) {
        const existing = fs.readFileSync(target, "utf8");
        if (isHouseKeyAuthProfiles(existing)) continue;
      }
      changed = removeIfExists(target) || changed;
    }
    if (changed) log(`[byot-sync] ${slug}: removed BYOT files (BYOT off)`);
    return changed;
  }

  // Enabled but agent dir doesn't exist — provisioning hasn't finished
  // yet. Refuse to materialize an orphan dir; next provisioner tick
  // will try again.
  if (!fs.existsSync(dir)) {
    log(`⚠ [byot-sync] ${slug}: agent dir missing (provisioning incomplete?) — skipping BYOT write`);
    return false;
  }

  const cfg = buildByotConfigForProvider(input);

  // Decide what content each file should have (or null = remove).
  const desired: Record<ByotFile, string | null> = {
    "auth-profiles.json": cfg.authProfiles ? JSON.stringify(cfg.authProfiles, null, 2) : null,
    "models.json":        cfg.models        ? JSON.stringify(cfg.models, null, 2)        : null,
  };

  let changed = false;
  for (const f of BYOT_FILES) {
    const target = filePath(f);
    const want = desired[f];
    const existing = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;

    // §9.4 coexistence: a house-key auth-profiles.json signals "this
    // non-BYOT customer is currently plan-demoted." If BYOT is enabled
    // (input != null) the customer is paying their own way, so BYOT
    // wins — overwrite the house-key file. Otherwise (caller bug —
    // input only reaches this branch when BYOT is enabled), refuse.
    if (f === "auth-profiles.json" && existing !== null && isHouseKeyAuthProfiles(existing) && want === null) {
      // Should be unreachable: input != null → desired["auth-profiles.json"]
      // is non-null for anthropic + openai providers. The openai-compatible
      // case writes models.json, not auth-profiles.json — so we'd want to
      // remove auth-profiles.json; but we still don't clobber a house-key
      // file. Skip the remove and keep the L3 plan demote in effect.
      continue;
    }

    if (want == null) {
      changed = removeIfExists(target) || changed;
      continue;
    }
    if (existing === want) continue;
    writeAtomic(target, want);
    changed = true;
  }

  if (changed) {
    log(`[byot-sync] ${slug}: BYOT config updated (provider=${input.provider}${input.model ? ` model=${input.model}` : ""})`);
  }
  return changed;
}

