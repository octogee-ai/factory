import * as fs from "fs";
import * as path from "path";
import {
  buildCodexAuthProfilesStore,
  buildClaudeCliAuthProfilesStore,
  buildClaudeCliNativeCredentialsJson,
  OPENAI_CODEX_DEFAULT_PROFILE_ID,
} from "./model-credential-materializer.js";
import {
  readAuthProfileState,
  readAuthProfileStore,
  writeAuthProfileStore,
} from "./auth-profile-sqlite.js";
import { deriveCodexAuthHealth } from "./codex-auth-health.js";

export type ByosubProvider = "openai" | "anthropic";

export interface ByosubRef {
  provider: ByosubProvider;
  secretName: string;
}

export interface ByosubRestorePlanItem {
  agentId: string;
  provider: ByosubProvider;
  secretName: string;
  // codex writes a codex-home auth.json here. claude-cli uses a separate
  // native Claude credential path when enabled for single-builder gateways.
  targetPath?: string;
  openclawDir: string;
}

export function agentIdsFromConfig(config: unknown): string[] {
  const list = (config as { agents?: { list?: unknown } } | null | undefined)
    ?.agents?.list;
  if (!Array.isArray(list)) return [];
  return list
    .map((a) =>
      a && typeof a === "object" ? (a as { id?: unknown }).id : undefined,
    )
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

const SAFE_AGENT_ID = /^[a-z0-9-]{1,64}$/;

export function isSafeAgentId(agentId: string): boolean {
  return typeof agentId === "string" && SAFE_AGENT_ID.test(agentId);
}

export function codexHomeDir(openclawDir: string, agentId: string): string {
  return path.join(openclawDir, "agents", agentId, "agent", "codex-home");
}

export function codexAuthJsonPath(openclawDir: string, agentId: string): string {
  return path.join(codexHomeDir(openclawDir, agentId), "auth.json");
}

export function claudeCliNativeCredentialsPath(homeDir: string): string {
  return path.join(homeDir, ".claude", ".credentials.json");
}

export function codexStagingHomeDir(
  openclawDir: string,
  agentId: string,
): string {
  return path.join(
    openclawDir,
    "agents",
    agentId,
    "agent",
    "codex-home.staging",
  );
}

export function codexStagingAuthJsonPath(
  openclawDir: string,
  agentId: string,
): string {
  return path.join(codexStagingHomeDir(openclawDir, agentId), "auth.json");
}

export function codexAgentDir(openclawDir: string, agentId: string): string {
  return path.join(openclawDir, "agents", agentId, "agent");
}

export function codexAuthStatePath(
  openclawDir: string,
  agentId: string,
): string {
  return path.join(codexAgentDir(openclawDir, agentId), "auth-state.json");
}

// codexAuthProfilesPath retired in 2026.6 — auth-profiles is now a SQLite
// row in {agentDir}/openclaw-agent.sqlite (upstream PR #89102). Use
// readAuthProfileStore / writeAuthProfileStore from auth-profile-sqlite.ts.

/**
 * Reads the codex auth-state payload as text — preferring the SQLite
 * auth_profile_state row (openclaw v2026.6.5+) and falling back to the
 * legacy auth-state.json file when the SQLite row is absent. Returns null
 * when neither source has data.
 *
 * Single source for both the restore decision (byosub-restore) and the
 * gateway-side health sweep (codex-auth-health-io). Keeps the text-in /
 * health-out contract of `deriveCodexAuthHealth` unchanged.
 */
export function readCodexAuthStateText(
  openclawDir: string,
  agentId: string,
): string | null {
  const stateRow = readAuthProfileState(codexAgentDir(openclawDir, agentId));
  if (stateRow !== null) return JSON.stringify(stateRow);
  try {
    return fs.readFileSync(codexAuthStatePath(openclawDir, agentId), "utf8");
  } catch {
    return null;
  }
}

export function shouldRestoreCodexCredential(opts: {
  authProfilesPresent: boolean;
  authStateText: string | null;
  profileId: string;
  now: number;
}): "write" | "skip" {
  if (!opts.authProfilesPresent) return "write";
  if (
    deriveCodexAuthHealth(opts.authStateText, opts.profileId, opts.now) ===
    "needs_reauth"
  ) {
    return "write";
  }
  return "skip";
}

function removeTempFile(tmp: string | undefined): void {
  if (!tmp) return;
  try {
    fs.rmSync(tmp, { force: true });
  } catch {
    // best-effort temp cleanup
  }
}

function restoreClaudeCliCredential(opts: {
  agentDir: string;
  payload: string;
  nativeHomeDir?: string;
}): { nativeRestored: boolean } {
  const nativeTarget = opts.nativeHomeDir
    ? claudeCliNativeCredentialsPath(opts.nativeHomeDir)
    : undefined;
  const nativeJson = nativeTarget
    ? buildClaudeCliNativeCredentialsJson(opts.payload)
    : null;
  if (nativeTarget && nativeJson === null) {
    throw new Error(
      "claude-cli native restore requires Claude SSO .credentials.json payload",
    );
  }

  let nativeTmp: string | undefined;
  try {
    if (nativeTarget && nativeJson !== null) {
      fs.mkdirSync(path.dirname(nativeTarget), { recursive: true });
      nativeTmp = `${nativeTarget}.tmp`;
      fs.writeFileSync(nativeTmp, nativeJson, { mode: 0o600 });
      fs.chmodSync(nativeTmp, 0o600);
    }
    writeAuthProfileStore(
      opts.agentDir,
      buildClaudeCliAuthProfilesStore(opts.payload, Date.now()),
    );
    if (nativeTarget && nativeTmp) {
      fs.renameSync(nativeTmp, nativeTarget);
      fs.chmodSync(nativeTarget, 0o600);
      nativeTmp = undefined;
    }
    return { nativeRestored: Boolean(nativeTarget) };
  } catch (err) {
    removeTempFile(nativeTmp);
    throw err;
  }
}

function restoreCodexCredential(item: ByosubRestorePlanItem, payload: string, agentDir: string): void {
  const targetPath = item.targetPath!;
  let tmp: string | undefined;
  try {
    tmp = `${targetPath}.tmp`;
    const codexStore = buildCodexAuthProfilesStore(payload);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(tmp, payload, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    // Write SQLite BEFORE promoting codex-home — preserves cross-pair
    // atomicity (the Copilot #989 invariant): if the auth-profiles store
    // can't be written, codex-home stays unpromoted, so we never half-flip
    // routing.
    writeAuthProfileStore(agentDir, codexStore);
    fs.renameSync(tmp, targetPath);
    tmp = undefined;
  } catch (err) {
    removeTempFile(tmp);
    throw err;
  }
}

export function planByosubRestores(opts: {
  agentIds: string[];
  byosub: Record<string, ByosubRef> | undefined;
  openclawDir: string;
  logFn?: (m: string) => void;
}): ByosubRestorePlanItem[] {
  const log = opts.logFn ?? (() => {});
  if (!opts.byosub || typeof opts.byosub !== "object") return [];
  const present = new Set(opts.agentIds);
  const plan: ByosubRestorePlanItem[] = [];
  for (const [agentId, ref] of Object.entries(opts.byosub)) {
    if (!isSafeAgentId(agentId)) {
      log(`byosub: skipping unsafe/invalid agent id ${JSON.stringify(agentId)}`);
      continue;
    }
    if (!present.has(agentId)) {
      log(`byosub: ${agentId} not present on this gateway — skipping`);
      continue;
    }
    if (
      !ref ||
      typeof ref !== "object" ||
      typeof ref.secretName !== "string" ||
      !ref.secretName
    ) {
      log(`byosub: ${agentId} has a malformed ref — skipping`);
      continue;
    }
    if (ref.provider === "openai") {
      plan.push({
        agentId,
        provider: "openai",
        secretName: ref.secretName,
        targetPath: codexAuthJsonPath(opts.openclawDir, agentId),
        openclawDir: opts.openclawDir,
      });
    } else if (ref.provider === "anthropic") {
      // Claude SUBSCRIPTION (claude-cli) — store-only, no auth.json targetPath.
      plan.push({
        agentId,
        provider: "anthropic",
        secretName: ref.secretName,
        openclawDir: opts.openclawDir,
      });
    } else {
      log(
        `byosub: ${agentId} unknown provider ${JSON.stringify(ref.provider)} — skipping`,
      );
    }
  }
  return plan;
}

export async function restoreByosubCredentials(opts: {
  plan: ByosubRestorePlanItem[];
  fetchSecret: (secretName: string) => Promise<string>;
  logFn?: (m: string) => void;
  claudeCliNativeHomeDir?: string;
}): Promise<{ restored: number; failed: number; skipped: number }> {
  const log = opts.logFn ?? (() => {});
  let restored = 0;
  let failed = 0;
  let skipped = 0;
  for (const item of opts.plan) {
    const agentDir = codexAgentDir(item.openclawDir, item.agentId);

    if (item.provider === "openai") {
      const authProfilesPresent = readAuthProfileStore(agentDir) !== null;
      const authStateText = readCodexAuthStateText(item.openclawDir, item.agentId);
      if (
        shouldRestoreCodexCredential({
          authProfilesPresent,
          authStateText,
          profileId: OPENAI_CODEX_DEFAULT_PROFILE_ID,
          now: Date.now(),
        }) === "skip"
      ) {
        skipped++;
        log(
          `byosub: ${item.agentId} healthy on-disk credential — conservative skip (openclaw owns it; not clobbering)`,
        );
        continue;
      }
    }
    try {
      const payload = await opts.fetchSecret(item.secretName);

      if (item.provider === "anthropic") {
        const { nativeRestored } = restoreClaudeCliCredential({
          agentDir,
          payload,
          ...(opts.claudeCliNativeHomeDir
            ? { nativeHomeDir: opts.claudeCliNativeHomeDir }
            : {}),
        });
        restored++;
        log(
          `byosub: restored claude-cli credential for ${item.agentId}${
            nativeRestored ? " (native Claude CLI credential restored)" : ""
          }`,
        );
        continue;
      }

      restoreCodexCredential(item, payload, agentDir);
      restored++;
      log(`byosub: restored ${item.provider} credential for ${item.agentId}`);
    } catch (e) {
      failed++;
      log(
        `byosub: WARN failed to restore ${item.agentId} (${item.secretName}) — ${(e as Error).message}`,
      );
    }
  }
  return { restored, failed, skipped };
}

export async function restoreByosubForAgents(opts: {
  agentIds: string[];
  byosub: Record<string, ByosubRef> | undefined;
  openclawDir: string;
  fetchSecret: (secretName: string) => Promise<string>;
  logFn?: (m: string) => void;
  claudeCliNativeHomeDir?: string;
}): Promise<{
  restored: number;
  failed: number;
  skipped: number;
  planned: number;
}> {
  const plan = planByosubRestores({
    agentIds: opts.agentIds,
    byosub: opts.byosub,
    openclawDir: opts.openclawDir,
    logFn: opts.logFn,
  });
  if (plan.length === 0)
    return { restored: 0, failed: 0, skipped: 0, planned: 0 };
  const r = await restoreByosubCredentials({
    plan,
    fetchSecret: opts.fetchSecret,
    logFn: opts.logFn,
    ...(opts.claudeCliNativeHomeDir ? { claudeCliNativeHomeDir: opts.claudeCliNativeHomeDir } : {}),
  });
  return { ...r, planned: plan.length };
}
