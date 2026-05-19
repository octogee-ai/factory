import * as fs from "fs";
import * as path from "path";
import {
  buildByotConfigForProvider,
  codexRuntimeConfig,
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

type CodexModelsDef = Record<string, { agentRuntime: { id: "codex" } }>;
export interface CoachModelPatch {
  agents: {
    list: Array<{ id: string; model: string }>;
    defaults?: { models: CodexModelsDef };
  };
}

/**
 * The openclaw config-patch that points a customer's coach agent at the
 * model their BYOT/BYOS provider requires (#1001). `buildByotConfigForProvider`
 * is the single source of truth for the model (`agentModelOverride`):
 * codex/openai → an explicit model; anthropic / tool-only oauth → null
 * (keep the gateway-default model — no per-agent override). codex also
 * needs the `agentRuntime:codex` registry row so the per-agent gpt-5.5
 * override routes through the @openclaw/codex harness (codexRuntimeConfig).
 * Returns null when no per-agent model change is required.
 *
 * Applied from the DURABLE desired state (deriveDesiredByotState) on every
 * sync, so a BYOS Connect actually switches the agent AND every later sync
 * / post-reschedule mount re-asserts it — closing the #1001 gap where only
 * the customer-lifecycle add path set this (gated on a transient caller
 * flag the Connect path never drove), leaving the agent on the default.
 */
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

