import * as fs from "fs";
import * as path from "path";
import {
  buildByotConfigForProvider,
  isOauthProvider,
  PROVIDERS,
  type Provider,
  type ByotConfigInput,
} from "./byot-multi-provider-config.js";
import { AGENTS_DIR, log } from "./config.js";

function agentIdForSlug(slug: string): string {
  return `octogee-${slug}-coach`;
}

function agentDirForSlug(slug: string, agentsDir: string = AGENTS_DIR): string {
  return path.join(agentsDir, agentIdForSlug(slug), "agent");
}

const BYOT_FILES = ["auth-profiles.json", "models.json"] as const;
type ByotFile = (typeof BYOT_FILES)[number];

const BYOT_MARKER = ".byot-managed";

// One source of truth for the credential-config shape (was a byte-copy
// of ByotConfigInput).
export type ByotInput = ByotConfigInput;

export function deriveDesiredByotState(userData: {
  byotActive?: boolean;
  username?: string;
  provisioning?: { openclaw?: { status?: string } };
  systemConfig?: { byot?: { provider?: string; baseUrl?: string; model?: string } };
}): { enabled: boolean; input: ByotInput | null } {
  const status = userData.provisioning?.openclaw?.status;
  const slug = userData.username;
  if (!userData.byotActive || !slug || status !== "complete") {
    return { enabled: false, input: null };
  }
  const cfg = userData.systemConfig?.byot;
  // Data-driven: any provider in the PROVIDERS registry is recognized
  // (BYOT api_key + BYOS oauth + future google/github/openrouter rows) —
  // no per-provider OR-list. Unknown/absent → anthropic (api_key default).
  const p = cfg?.provider;
  const provider: Provider =
    p && Object.prototype.hasOwnProperty.call(PROVIDERS, p)
      ? (p as Provider)
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

export function applyByotState(
  slug: string,
  input: ByotInput | null,
  // Explicit agents base so a caller that restored the codex-home under a
  // specific openclawDir writes auth-profiles.json under the SAME base
  // (else AGENTS_DIR/OPENCLAW_AGENTS_DIR can decouple cred from profile).
  agentsDir: string = AGENTS_DIR,
): boolean {
  const dir = agentDirForSlug(slug, agentsDir);
  const filePath = (f: string) => path.join(dir, f);
  const markerPath = filePath(BYOT_MARKER);

  if (!input) {
    if (!fs.existsSync(markerPath)) {
      return false;
    }
    let changed = false;
    for (const f of BYOT_FILES) changed = removeIfExists(filePath(f)) || changed;
    changed = removeIfExists(markerPath) || changed;
    if (changed) log(`[byot-sync] ${slug}: removed BYOT files (BYOT off)`);
    return changed;
  }

  if (!fs.existsSync(dir)) {
    log(`⚠ [byot-sync] ${slug}: agent dir missing (provisioning incomplete?) — skipping BYOT write`);
    return false;
  }

  const cfg = buildByotConfigForProvider(input);

  const desired: Record<ByotFile, string | null> = {
    "auth-profiles.json": cfg.authProfiles ? JSON.stringify(cfg.authProfiles, null, 2) : null,
    "models.json":        cfg.models        ? JSON.stringify(cfg.models, null, 2)        : null,
  };

  let changed = false;
  for (const f of BYOT_FILES) {
    // Plane-1 OAuth (codex/BYOS): byosub-restore is the SOLE writer of
    // auth-profiles.json — it embeds the live OAuthCredential mapped from
    // the restored codex auth.json. applyByotState must not stub-write or
    // null-delete it here: restoreOauthStoreForSlug calls applyByotState
    // *after* the restore, so touching it would clobber the credential.
    if (f === "auth-profiles.json" && isOauthProvider(input.provider)) continue;
    const target = filePath(f);
    const want = desired[f];
    const existing = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;

    if (want == null) {
      changed = removeIfExists(target) || changed;
      continue;
    }
    if (existing === want) continue;
    writeAtomic(target, want);
    changed = true;
  }

  if (!fs.existsSync(markerPath)) {
    writeAtomic(markerPath, JSON.stringify({ managedSince: new Date().toISOString() }) + "\n");
  }

  if (changed) {
    log(`[byot-sync] ${slug}: BYOT config updated (provider=${input.provider}${input.model ? ` model=${input.model}` : ""})`);
  }
  return changed;
}

