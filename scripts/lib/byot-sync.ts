import * as fs from "fs";
import * as path from "path";
import {
  buildByotConfigForProvider,
  codexRuntimeConfig,
  claudeCliRuntimeConfig,
  isOauthProvider,
  PROVIDERS,
  type Provider,
  type ByotConfigInput,
} from "./byot-multi-provider-config.js";
import { AGENTS_DIR, log } from "./config.js";
import {
  deleteAuthProfileStore,
  readAuthProfileStore,
  writeAuthProfileStore,
} from "./auth-profile-sqlite.js";

function agentIdForSlug(slug: string): string {
  return `octogee-${slug}-coach`;
}

function agentDirForSlug(slug: string, agentsDir: string = AGENTS_DIR): string {
  return path.join(agentsDir, agentIdForSlug(slug), "agent");
}

// auth-profiles moved to SQLite in openclaw v2026.6.1+ (PR #89102) — we
// write that row directly via auth-profile-sqlite. models.json stayed as a
// file, so it's the only entry in this list.
const BYOT_FILES = ["models.json"] as const;
type ByotFile = (typeof BYOT_FILES)[number];

const BYOT_MARKER = ".byot-managed";

export type ByotInput = ByotConfigInput;

export function isShellRuntimeProvider(provider: Provider): boolean {
  return provider === "openai-codex" || provider === "claude-cli";
}

// Pins agentRuntime so a per-agent BYOS model override routes through the right
// harness (codex / claude-cli) rather than the platform provider key.
type RuntimeModelsDef = Record<string, { agentRuntime: { id: string } }>;
export interface CoachModelPatch {
  agents: {
    list: Array<{ id: string; model: string }>;
    defaults?: { models: RuntimeModelsDef };
  };
}

export function byosCoachConfigPatch(
  input: ByotInput | null,
): CoachModelPatch | null {
  if (!input) return null;
  const cfg = buildByotConfigForProvider(input);
  if (cfg.agentModelOverride == null) return null;
  const patch: CoachModelPatch = {
    agents: {
      list: [{ id: agentIdForSlug(input.slug), model: cfg.agentModelOverride }],
    },
  };
  if (input.provider === "openai-codex") {
    patch.agents.defaults = { models: codexRuntimeConfig().modelsDef };
  } else if (input.provider === "claude-cli") {
    patch.agents.defaults = { models: claudeCliRuntimeConfig().modelsDef };
  }
  return patch;
}

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
    // Clear the SQLite-backed auth-profiles row (no-op if the row or DB is
    // absent). The marker presence is the canonical "BYOT was on" signal,
    // so we don't need to know whether the row was actually there to log.
    if (readAuthProfileStore(dir) !== null) {
      deleteAuthProfileStore(dir);
      changed = true;
    }
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
    "models.json":        cfg.models        ? JSON.stringify(cfg.models, null, 2)        : null,
  };

  let changed = false;
  for (const f of BYOT_FILES) {
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

  // auth-profiles → SQLite. OAuth providers (codex) manage their own
  // auth-profiles via openclaw; skip them here, same as the JSON era.
  if (!isOauthProvider(input.provider)) {
    if (cfg.authProfiles) {
      const before = readAuthProfileStore(dir);
      if (JSON.stringify(before) !== JSON.stringify(cfg.authProfiles)) {
        writeAuthProfileStore(dir, cfg.authProfiles);
        changed = true;
      }
    } else if (readAuthProfileStore(dir) !== null) {
      deleteAuthProfileStore(dir);
      changed = true;
    }
  }

  if (!fs.existsSync(markerPath)) {
    writeAtomic(markerPath, JSON.stringify({ managedSince: new Date().toISOString() }) + "\n");
  }

  if (changed) {
    const modelSuffix = input.model ? ` model=${input.model}` : "";
    log(`[byot-sync] ${slug}: BYOT config updated (provider=${input.provider}${modelSuffix})`);
  }
  return changed;
}
