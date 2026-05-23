

export type CodexAuthHealth = "ok" | "needs_reauth";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

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
    return "ok"; 
  }
  return "needs_reauth";
}

export async function checkCodexAuthHealthForAgents(opts: {
  agentIds: string[];
  profileId: string;
  now: number;
  
  readAuthState: (agentId: string) => string | null;
  
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
