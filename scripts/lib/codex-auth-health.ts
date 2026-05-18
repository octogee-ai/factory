/**
 * R8 detection — pure. openclaw owns auth-death detection: it persists a
 * per-agent auth-profile state file (`resolveAuthStatePath(agentDir)` →
 * `<agentAuthDir>/<AUTH_STATE_FILENAME>`) and, on a permanent OAuth failure,
 * records `usageStats[profileId] = { disabledReason:"auth_permanent",
 * disabledUntil }`. This reads that structured file (the same per-agent dir
 * Chunk A writes `auth-profiles.json`) — never a 401 intercept, chat-message
 * parse, or log scrape. Only an ACTIVE `auth_permanent` disable window for
 * the codex profile is reauth-worthy; transient cooldowns and `billing`
 * (different remediation) are not. See BYO-SUBSCRIPTION-OAUTH-SPEC.md §12-R8.
 */

export type CodexAuthHealth = "ok" | "needs_reauth";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * `authStateText` = raw contents of openclaw's auth-state file for the agent
 * (or null/undefined when absent — absence of state is not a failure).
 * Fail-safe: a recorded `auth_permanent` with no clearly-elapsed window is
 * surfaced (never silently "ok" on a known permanent auth failure).
 */
export function deriveCodexAuthHealth(
  authStateText: string | null | undefined,
  profileId: string,
  now: number,
): CodexAuthHealth {
  if (typeof authStateText !== "string" || authStateText.trim() === "") {
    return "ok";
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(authStateText);
  } catch {
    return "ok";
  }
  if (!isRecord(parsed) || !isRecord(parsed.usageStats)) {
    return "ok";
  }
  // eslint-disable-next-line security/detect-object-injection -- caller-supplied typed profileId read from a parsed-JSON record (no write, no proto access)
  const stats = parsed.usageStats[profileId];
  if (!isRecord(stats) || stats.disabledReason !== "auth_permanent") {
    return "ok";
  }
  const until = stats.disabledUntil;
  if (typeof until === "number" && Number.isFinite(until) && until <= now) {
    return "ok"; // disable window elapsed — openclaw will retry on its own
  }
  return "needs_reauth";
}

/**
 * R8 periodic detection sweep — pure orchestration, all I/O injected. For
 * each mounted agent: read openclaw's auth-state file, derive health, and
 * signal workspace-api on `needs_reauth`. Per-item isolation: one bad
 * read/signal logs + continues, never aborts the sweep, never throws (the
 * reconcile loop must not be wedged by a degraded agent). Tally lets the
 * caller log. See BYO-SUBSCRIPTION-OAUTH-SPEC.md §12-R8.
 */
export async function checkCodexAuthHealthForAgents(opts: {
  agentIds: string[];
  profileId: string;
  now: number;
  /** Contents of the agent's `auth-state.json`, or null when absent. */
  readAuthState: (agentId: string) => string | null;
  /** Server-mediated R2 signal → workspace-api (no credential). */
  signalNeedsReauth: (agentId: string) => Promise<void>;
  logFn?: (m: string) => void;
}): Promise<{ checked: number; needsReauth: number; signalled: number }> {
  const log = opts.logFn ?? (() => {});
  let checked = 0;
  let needsReauth = 0;
  let signalled = 0;
  for (const agentId of opts.agentIds) {
    let stateText: string | null;
    try {
      stateText = opts.readAuthState(agentId);
    } catch (e) {
      log(
        `codex-auth-health: WARN read failed for ${agentId} — ${(e as Error).message}`,
      );
      continue;
    }
    checked++;
    if (deriveCodexAuthHealth(stateText, opts.profileId, opts.now) !== "needs_reauth") {
      continue;
    }
    needsReauth++;
    try {
      await opts.signalNeedsReauth(agentId);
      signalled++;
      log(`codex-auth-health: ${agentId} codex auth dead — signalled needs_reauth`);
    } catch (e) {
      log(
        `codex-auth-health: WARN signal failed for ${agentId} — ${(e as Error).message}`,
      );
    }
  }
  return { checked, needsReauth, signalled };
}
