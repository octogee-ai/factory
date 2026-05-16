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
    if (!SAFE_AGENT_ID.test(agentId)) {
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
        targetPath: path.join(
          opts.openclawDir,
          "agents",
          agentId,
          "agent",
          "codex-home",
          "auth.json",
        ),
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
