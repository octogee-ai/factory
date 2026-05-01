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

/**
 * Marker file we drop in the agent dir whenever BYOT writes one of the
 * BYOT_FILES. Its sole purpose is to disambiguate "BYOT wrote this
 * auth-profiles.json" from "OpenClaw's own per-agent auth profile cache
 * wrote this auth-profiles.json" — they share the same filename and the
 * same directory.
 *
 * Without this marker, the BYOT-off branch below would happily delete
 * OpenClaw's auth cache on every Firestore user-doc tick (every agent
 * turn writes a token-usage update → fires the onSnapshot watcher in
 * scripts/local-provisioner.ts → calls applyByotState(slug, null) →
 * sees auth-profiles.json on disk → removes it → returns changed=true
 * → triggers `secrets.reload` on the gateway → channels restart → next
 * turn slow, OpenClaw rewrites auth-profiles.json, loop). The marker
 * is the proof of prior management; without it, the file belongs to
 * OpenClaw and we leave it alone.
 */
const BYOT_MARKER = ".byot-managed";

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
  const filePath = (f: string) => path.join(dir, f);
  const markerPath = filePath(BYOT_MARKER);

  // Disabled — only act if we previously managed BYOT for this slug
  // (i.e. the marker is on disk). Without the marker, any
  // auth-profiles.json in this dir belongs to OpenClaw's own auth
  // caching layer and must not be touched. See the BYOT_MARKER comment
  // for why this matters: every agent turn writes a usage update to
  // Firestore which would otherwise have us delete OpenClaw's cache.
  if (!input) {
    if (!fs.existsSync(markerPath)) {
      return false;
    }
    let changed = false;
    for (const f of BYOT_FILES) changed = removeIfExists(filePath(f)) || changed;
    // Remove the marker last so a partial failure leaves us in
    // "still managed" state and the next call retries cleanup.
    changed = removeIfExists(markerPath) || changed;
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

    if (want == null) {
      changed = removeIfExists(target) || changed;
      continue;
    }
    if (existing === want) continue;
    writeAtomic(target, want);
    changed = true;
  }

  // Always drop the marker when BYOT is enabled and it's missing, even
  // if `changed=false` because the BYOT_FILES on disk already match the
  // desired content. That covers two cases the prior gating missed:
  //   1. Pre-marker rollouts: customers whose auth-profiles.json was
  //      written by an earlier code path (or this code before marker
  //      support) come into this turn with files matching desired
  //      content → changed=false → marker never created → BYOT-off
  //      becomes a permanent no-op for them.
  //   2. Idempotent re-enable: enable BYOT, get marker; remove marker
  //      manually for any reason; next enable call sees content
  //      matching → would skip marker recreation under the old gating.
  if (!fs.existsSync(markerPath)) {
    writeAtomic(markerPath, JSON.stringify({ managedSince: new Date().toISOString() }) + "\n");
  }

  if (changed) {
    log(`[byot-sync] ${slug}: BYOT config updated (provider=${input.provider}${input.model ? ` model=${input.model}` : ""})`);
  }
  return changed;
}

