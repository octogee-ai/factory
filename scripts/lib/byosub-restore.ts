import * as fs from "fs";
import * as path from "path";
import {
  buildCodexAuthProfilesStore,
  OPENAI_CODEX_DEFAULT_PROFILE_ID,
} from "./byot-multi-provider-config.js";
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
  targetPath: string;

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

export function codexAuthProfilesPath(
  openclawDir: string,
  agentId: string,
): string {
  return path.join(codexAgentDir(openclawDir, agentId), "auth-profiles.json");
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
      log(
        `byosub: ${agentId} provider=anthropic deferred to Chunk E — skipping`,
      );
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
}): Promise<{ restored: number; failed: number; skipped: number }> {
  const log = opts.logFn ?? (() => {});
  let restored = 0;
  let failed = 0;
  let skipped = 0;
  for (const item of opts.plan) {
    const tmp = `${item.targetPath}.tmp`;

const apPath = codexAuthProfilesPath(item.openclawDir, item.agentId);
    const apTmp = `${apPath}.tmp`;

if (item.provider === "openai") {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path-traversal-guarded per-agent path (codexAuthProfilesPath / SAFE_AGENT_ID)
      const authProfilesPresent = fs.existsSync(apPath);
      const authStatePath = codexAuthStatePath(item.openclawDir, item.agentId);
      let authStateText: string | null = null;
      try {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- guarded per-agent agentDir (see above)
        authStateText = fs.readFileSync(authStatePath, "utf8");
      } catch {
        authStateText = null; 
      }
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

const codexStore =
        item.provider === "openai" ? buildCodexAuthProfilesStore(payload) : null;

// eslint-disable-next-line security/detect-non-literal-fs-filename -- path-traversal-guarded per-agent codex-home (SAFE_AGENT_ID)
      fs.mkdirSync(path.dirname(item.targetPath), { recursive: true });
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- guarded per-agent codex-home (see above)
      fs.writeFileSync(tmp, payload, { mode: 0o600 });
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- guarded per-agent codex-home (see above)
      fs.chmodSync(tmp, 0o600);
      if (codexStore) {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- guarded per-agent agentDir (see above)
        fs.writeFileSync(apTmp, JSON.stringify(codexStore, null, 2) + "\n", {
          mode: 0o600,
        });
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- guarded per-agent agentDir (see above)
        fs.chmodSync(apTmp, 0o600);
      }
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- guarded per-agent codex-home (see above)
      fs.renameSync(tmp, item.targetPath);
      if (codexStore) {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- guarded per-agent agentDir (see above)
        fs.renameSync(apTmp, apPath);
      }
      restored++;
      log(`byosub: restored ${item.provider} credential for ${item.agentId}`);
    } catch (e) {
      failed++;
      log(
        `byosub: WARN failed to restore ${item.agentId} (${item.secretName}) — ${(e as Error).message}`,
      );
      try {
        fs.rmSync(tmp, { force: true });
        fs.rmSync(apTmp, { force: true });
      } catch {
        // best-effort temp cleanup
      }
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
  });
  return { ...r, planned: plan.length };
}
