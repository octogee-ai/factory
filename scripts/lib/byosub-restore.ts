import * as fs from "fs";
import * as path from "path";

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
}): Promise<{ restored: number; failed: number }> {
  const log = opts.logFn ?? (() => {});
  let restored = 0;
  let failed = 0;
  for (const item of opts.plan) {
    const tmp = `${item.targetPath}.tmp`;
    try {
      const payload = await opts.fetchSecret(item.secretName);
      // targetPath is built in planByosubRestores from openclawDir + fixed
      // segments + a SAFE_AGENT_ID-validated agentId (path-traversal guarded).
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path-traversal-guarded per-agent codex-home (SAFE_AGENT_ID)
      fs.mkdirSync(path.dirname(item.targetPath), { recursive: true });
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- guarded per-agent codex-home (see above)
      fs.writeFileSync(tmp, payload, { mode: 0o600 });
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- guarded per-agent codex-home (see above)
      fs.chmodSync(tmp, 0o600);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- guarded per-agent codex-home (see above)
      fs.renameSync(tmp, item.targetPath);
      restored++;
      log(`byosub: restored ${item.provider} credential for ${item.agentId}`);
    } catch (e) {
      failed++;
      log(
        `byosub: WARN failed to restore ${item.agentId} (${item.secretName}) — ${(e as Error).message}`,
      );
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // best-effort temp cleanup
      }
    }
  }
  return { restored, failed };
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
}): Promise<{ restored: number; failed: number; planned: number }> {
  const plan = planByosubRestores({
    agentIds: opts.agentIds,
    byosub: opts.byosub,
    openclawDir: opts.openclawDir,
    logFn: opts.logFn,
  });
  if (plan.length === 0) return { restored: 0, failed: 0, planned: 0 };
  const r = await restoreByosubCredentials({
    plan,
    fetchSecret: opts.fetchSecret,
    logFn: opts.logFn,
  });
  return { ...r, planned: plan.length };
}
