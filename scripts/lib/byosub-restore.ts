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
}

/** Pure: the openclaw agent ids present in a parsed openclaw.json. */
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

// Agent ids come from Firestore (`glmGateways/{id}.byosub` keys) and are
// interpolated into a filesystem path — must be path-safe AND length-bounded
// (the guard is the security boundary; don't rely on the agent-present check).
// Real ids are `octogee-{slug}-coach` — 64 is generous.
const SAFE_AGENT_ID = /^[a-z0-9-]{1,64}$/;

/**
 * The shared agent-id path-safety boundary. Agent ids reach the gateway
 * from Firestore (`glmGateways/{id}.byosub` keys, Chunk A) and from the
 * device-auth start request (Chunk C1b) before being interpolated into a
 * filesystem path AND a spawned process env — validate at every ingress;
 * never rely on a downstream presence check.
 */
export function isSafeAgentId(agentId: string): boolean {
  return typeof agentId === "string" && SAFE_AGENT_ID.test(agentId);
}

/**
 * The per-agent codex-home directory. Single source of truth for the
 * "where codex auth.json lives" invariant shared by Chunk A (restore),
 * Chunk B (sync-back watch) and Chunk C1b (device-auth onboarding) —
 * openclaw runs the codex app-server with this exact `CODEX_HOME`
 * (verified live). Callers that interpolate an agentId into a filesystem
 * path remain responsible for validating it (`SAFE_AGENT_ID`).
 */
export function codexHomeDir(openclawDir: string, agentId: string): string {
  return path.join(openclawDir, "agents", agentId, "agent", "codex-home");
}

/** The codex `auth.json` inside the per-agent codex-home. */
export function codexAuthJsonPath(openclawDir: string, agentId: string): string {
  return path.join(codexHomeDir(openclawDir, agentId), "auth.json");
}

/**
 * A *staging* codex-home, a sibling of the live one. The C1b device-auth
 * child runs against this so a failed/expired/abandoned `codex login`
 * never mutates the live per-agent `auth.json` — a re-Connect can never
 * break an already-working agent (the "never break Bender" invariant).
 * The live home is replaced only by an atomic promote of a *successfully
 * captured* staged credential, or by Chunk A restore from Secret Manager.
 */
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

/**
 * The per-agent agent dir openclaw resolves `auth-profiles.json` AND
 * `auth-state.json` into (parent of codex-home). Single source of truth so
 * the Chunk A restore *writer* and the R8 auth-state *reader* can never
 * drift on where these live.
 */
export function codexAgentDir(openclawDir: string, agentId: string): string {
  return path.join(openclawDir, "agents", agentId, "agent");
}

/**
 * openclaw's persisted auth-profile state file (`AUTH_STATE_FILENAME` =
 * `auth-state.json`), a sibling of `auth-profiles.json`. openclaw records
 * permanent OAuth death here (`usageStats[profileId].disabledReason =
 * "auth_permanent"`); the R8 detection reads it. See
 * BYO-SUBSCRIPTION-OAUTH-SPEC.md §12-R8.
 */
export function codexAuthStatePath(
  openclawDir: string,
  agentId: string,
): string {
  return path.join(codexAgentDir(openclawDir, agentId), "auth-state.json");
}

/**
 * Conservative-restore keystone (BYO-SUBSCRIPTION-OAUTH-SPEC.md §12-R8). The
 * on-disk per-agent credential is *authoritative* in steady state: openclaw
 * owns it and rotates the refresh token in place. Optimistically rewriting
 * it from Secret Manager clobbers openclaw's freshly-rotated token with a
 * stale one — the `refresh_token_reused` root cause. So replacement is the
 * RECOVERY path, never routine:
 *  - **cold start** (no on-disk auth-profiles.json) → write (nothing to clobber)
 *  - **recovery** (openclaw flagged the codex profile `auth_permanent`) →
 *    write (the on-disk cred is provably dead — replace it)
 *  - **steady state** (healthy on-disk cred) → SKIP (hands off; never clobber
 *    a working, possibly-rotated token)
 */
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

/**
 * Pure: resolve which per-agent codex-home `auth.json` files to restore for
 * this gateway. One shared gateway hosts many customers; each present agent
 * with an `openai` ref maps to its own per-agent codex-home (verified live:
 * openclaw runs the codex app-server with
 * `CODEX_HOME=<openclawDir>/agents/<agentId>/agent/codex-home`). Anthropic
 * is deferred to Chunk E. Unsafe ids / absent agents / bad refs are skipped
 * and logged (no silent drops). See BYO-SUBSCRIPTION-OAUTH-SPEC.md.
 */
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

/**
 * Restore each planned credential: fetch the owner-scoped secret, write it
 * atomically (temp + rename, 0600) into the agent's codex-home. Per-item
 * isolation — one failure logs + counts, never aborts the others, never
 * throws (boot must not be blocked by a degraded secret/customer). codex
 * hard-fails on a partial auth.json, hence the atomic temp+rename.
 */
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
    // codex (provider "openai"): openclaw beta.6's @openclaw/codex reads the
    // OAuth credential from <agentDir>/auth-profiles.json (openai-codex:
    // default) — NOT codex-home/auth.json. agentDir = parent of codex-home.
    const agentDir = path.dirname(path.dirname(item.targetPath));
    const apPath = path.join(agentDir, "auth-profiles.json");
    const apTmp = `${apPath}.tmp`;
    // Conservative-restore keystone: openclaw owns the on-disk credential
    // and rotates it in place; optimistically rewriting it from Secret
    // Manager clobbers a freshly-rotated refresh token (the
    // `refresh_token_reused` root cause). Replace only on cold start or a
    // recovery signal — never over a healthy on-disk cred. apPath /
    // authStatePath derive from item.targetPath (planByosubRestores,
    // SAFE_AGENT_ID-guarded), same provenance as the writes below.
    if (item.provider === "openai") {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path-traversal-guarded per-agent agentDir (SAFE_AGENT_ID)
      const authProfilesPresent = fs.existsSync(apPath);
      const authStatePath = path.join(agentDir, "auth-state.json");
      let authStateText: string | null = null;
      try {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- guarded per-agent agentDir (see above)
        authStateText = fs.readFileSync(authStatePath, "utf8");
      } catch {
        authStateText = null; // absent/unreadable → openclaw recorded no failure
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
      // Validate + map BEFORE any write so an unusable blob fails the item
      // cleanly (preserves "never flip routing without the cred on disk").
      const codexStore =
        item.provider === "openai" ? buildCodexAuthProfilesStore(payload) : null;
      // targetPath is built in planByosubRestores from openclawDir + fixed
      // segments + a SAFE_AGENT_ID-validated agentId (path-traversal guarded);
      // apPath/apTmp derive from it (dirname×2 + literal filename), same
      // guarded provenance. codex hard-fails on a partial auth.json, and the
      // openclaw-read routing store (auth-profiles.json) must never appear
      // without its codex-home sibling → cross-pair atomicity: stage BOTH
      // temps (validated, 0600) before promoting EITHER, so a disk-full /
      // perms / bad-payload failure aborts the item with nothing promoted;
      // then promote codex-home first and auth-profiles.json LAST, so its
      // presence is the atomic "item live + sibling already in place"
      // signal. A crash strictly between the two renames self-heals on the
      // next (idempotent) restore; routing is never flipped without the
      // credential on disk. (No delete-rollback: removing a freshly-promoted
      // file would destroy a previously-working agent's credential — the
      // "never break Bender" invariant — and is strictly worse than the
      // benign new-codex-home / prior-valid-auth-profiles residue.)
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

/**
 * The single shared byosub restore orchestration: plan + restore for a
 * set of agents. Used by BOTH pre-boot (all config agents at boot) and
 * the per-customer sync (one mounted agent post-boot). Deps injected —
 * the caller fetches `byosub` from `glmGateways/{gatewayId}` and supplies
 * `fetchSecret`. Never throws (a degraded secret must not block boot or
 * a mount). `planned` lets the caller decide whether to log/reload.
 */
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
