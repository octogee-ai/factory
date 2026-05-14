export interface ProjectRestoreInput {
  customerSlug: string;
  projectSlug: string;
  giteaRepoName: string | null;
  provisioningState?: string;
}

export function projectsNeedingClone(
  inputs: readonly ProjectRestoreInput[],
  isProjectCloned: (customerSlug: string, projectSlug: string) => boolean,
): ProjectRestoreInput[] {
  return inputs.filter((p) => {
    if (!p.giteaRepoName) return false;
    if (p.provisioningState !== undefined && p.provisioningState !== "active") return false;
    if (isProjectCloned(p.customerSlug, p.projectSlug)) return false;
    return true;
  });
}

export interface CustomerAgentInput {
  uid: string;
  slug: string;
  customerDir: string;
  agentDir: string;
  coach: { name: string; emoji: string; model: string };
}

export function buildCustomerAgent(
  c: CustomerAgentInput,
): Record<string, unknown> {
  const agentId = `octogee-${c.slug}-coach`;
  // Parenthetical is the workspace slug, intentionally — not a human "business
  // name." It's the canonical identifier visible in OpenClaw's agent list and
  // helps disambiguate when an operator has multiple Builders' agents loaded.
  return {
    id: agentId,
    name: `${c.coach.name} (${c.slug})`,
    workspace: c.customerDir,
    agentDir: c.agentDir,
    model: c.coach.model,
    identity: { name: c.coach.name, emoji: c.coach.emoji },
    heartbeat: { every: "60m", target: "last", lightContext: true },
    tools: { fs: { workspaceOnly: true } },
  };
}

/** DI-friendly deps so the loop can be tested with a plain object mock. */
export interface CoachIdentityDeps {
  db: {
    collection: (name: string) => {
      doc: (id: string) => {
        get: () => Promise<{ exists: boolean; data: () => any }>;
      };
    };
  };
  log: (msg: string) => void;
}

export interface CoachIdentity {
  name: string;
  emoji: string;
}

export interface CoachIdentityDefaults {
  name: string;
  emoji: string;
}

/**
 * Resolve the final `{ name, emoji }` pair for an agent's `identity` block.
 *
 * Contract:
 *   - custom absent  → defaults
 *   - custom.name="" → defaults.name  (empty string is NOT customization)
 *   - custom.emoji=""→ defaults.emoji
 *   - partial        → fill each field independently
 */
export function resolveCoachIdentity(
  custom: CoachIdentity | undefined,
  defaults: CoachIdentityDefaults,
): CoachIdentity {
  return {
    name: (custom?.name && custom.name.length > 0) ? custom.name : defaults.name,
    emoji: (custom?.emoji && custom.emoji.length > 0) ? custom.emoji : defaults.emoji,
  };
}

/**
 * Read each customer's coach identity from `agents/{uid}`. Missing docs /
 * missing fields / per-customer Firestore errors log a structured warning
 * and are omitted from the map — callers fall back to the platform default
 * coach identity. Reads only the public display fields; no secrets involved.
 */
export async function fetchCoachIdentities(
  deps: CoachIdentityDeps,
  customers: ReadonlyArray<{ uid: string; slug: string }>,
): Promise<Map<string, CoachIdentity>> {
  const out = new Map<string, CoachIdentity>();
  for (const c of customers) {
    try {
      const snap = await deps.db.collection("agents").doc(c.uid).get();
      if (!snap.exists) {
        deps.log(
          `⚠ no agents/${c.uid} doc for ${c.slug} — using default coach identity`,
        );
        continue;
      }
      const data = snap.data() ?? {};
      const name = typeof data.name === "string" && data.name ? data.name : null;
      const emoji =
        typeof data.avatarEmoji === "string" && data.avatarEmoji ? data.avatarEmoji : null;
      if (!name && !emoji) {
        deps.log(
          `⚠ agents/${c.uid} has no name/avatarEmoji for ${c.slug} — using defaults`,
        );
        continue;
      }
      out.set(c.uid, {
        name: name ?? "",
        emoji: emoji ?? "",
      });
    } catch (err) {
      deps.log(
        `⚠ agents/${c.uid} read failed for ${c.slug}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return out;
}

export interface CoachTokenDeps {
  db: {
    collection: (name: string) => {
      doc: (id: string) => {
        collection: (name: string) => {
          doc: (id: string) => {
            get: () => Promise<{ exists: boolean; data: () => any }>;
          };
        };
      };
    };
  };
  log: (msg: string) => void;
}

/**
 * Read each customer's coach PAT from `users/{uid}/secrets/coachMattermost`.
 * Callers MUST skip emitting an OpenClaw account entry for any customer
 * whose token is absent — config with a null/empty botToken would fail
 * OpenClaw's schema validation and brick the gateway for every tenant.
 */
export async function fetchCoachTokens(
  deps: CoachTokenDeps,
  customers: ReadonlyArray<{ uid: string; slug: string }>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const c of customers) {
    try {
      const snap = await deps.db
        .collection("users").doc(c.uid)
        .collection("secrets").doc("coachMattermost")
        .get();
      if (!snap.exists) {
        deps.log(
          `⚠ no users/${c.uid}/secrets/coachMattermost for ${c.slug} — coach has no PAT; re-run provisioning`,
        );
        continue;
      }
      const data = snap.data() ?? {};
      const token = typeof data.personalToken === "string" ? data.personalToken : "";
      if (!token) {
        deps.log(
          `⚠ users/${c.uid}/secrets/coachMattermost missing personalToken for ${c.slug}`,
        );
        continue;
      }
      out.set(c.uid, token);
    } catch (err) {
      deps.log(
        `⚠ users/${c.uid}/secrets/coachMattermost read failed for ${c.slug}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return out;
}

export interface MattermostAccountInput {
  uid: string;
  slug: string;
  customerMmUserId?: string | null;
}

export interface MattermostAccountEntry {
  botToken: string;
  groupPolicy?: "open" | "allowlist" | "disabled";
  groupAllowFrom?: string[];
  /**
   * We always pin `native: false` because Octogee doesn't use `/commands`
   * — leaving at OpenClaw's default causes the MM monitor to register
   * 5+ slash commands across every team on every account mount (+ every
   * reconnect), stacking 50-100+ serial HTTP calls per cycle and
   * starving the gateway's WS ping window.
   */
  commands?: {
    native: false;
  };
}

/**
 * Per-customer coach accounts use `groupPolicy: "allowlist"` with
 * `groupAllowFrom` scoped to [customer MM user id, admin MM user id].
 * OpenClaw flags `groupPolicy: "open"` as a CRITICAL security warning
 * and refuses to start the channel.
 *
 * Customers without a PAT are OMITTED — caller must not emit a binding
 * that references a missing account. We intentionally do NOT emit an
 * `admin` account — OpenClaw's env-var `${MM_BOT_TOKEN}` substitution
 * only fires for the account literally named `"default"`, so any other
 * name would get the LITERAL placeholder string as a bearer token →
 * 401 → endless reconnect loop.
 */
export function buildMattermostAccounts(
  customers: ReadonlyArray<MattermostAccountInput>,
  coachTokens: ReadonlyMap<string, string>,
  adminMmUserId?: string | null,
  warn?: (msg: string) => void,
): Record<string, MattermostAccountEntry> {
  const accounts: Record<string, MattermostAccountEntry> = {};
  for (const c of customers) {
    const token = coachTokens.get(c.uid);
    if (!token) continue;
    const groupAllowFrom = [c.customerMmUserId, adminMmUserId].filter(
      (id): id is string => typeof id === "string" && id.length > 0,
    );
    // Fail loud, not quiet. `groupPolicy: "allowlist"` with an empty
    // `groupAllowFrom` silently drops every group message. If neither
    // the workspace owner nor the platform admin is identified, refuse
    // to emit the account so the missing data surfaces as "coach offline"
    // (highly visible) rather than "coach silently ignores messages".
    if (groupAllowFrom.length === 0) {
      warn?.(
        `⚠ skipping ${c.slug}-coach account: no customerMmUserId and no MM_ADMIN_USER_ID — empty allowlist would silently drop every group message. Re-provision with the customer's MM user id to restore.`,
      );
      continue;
    }
    accounts[`${c.slug}-coach`] = {
      botToken: token,
      groupPolicy: "allowlist",
      groupAllowFrom,
      commands: { native: false },
    };
  }
  return accounts;
}

/**
 * Merge pure-builder coach accounts with existing on-disk accounts, keeping
 * `default` from existing but everything else from the fresh coach list.
 *
 * `accounts.default` — where MM_BOT_TOKEN lives — must be preserved, because
 * OpenClaw's channel-init hangs indefinitely without it. `pre-boot-config.ts`
 * runs before the first customer patch and keeps `accounts.default.botToken`
 * synced with the `MM_BOT_TOKEN` env var.
 */
export function mergeAccountsPreservingDefault(
  existingAccounts: Record<string, unknown>,
  coachAccounts: Record<string, MattermostAccountEntry>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...coachAccounts };
  if (existingAccounts.default) {
    merged.default = existingAccounts.default;
  }
  return merged;
}

/** Shape of a single channel binding emitted to openclaw.json. */
export interface OpenClawBinding {
  agentId: string;
  match: {
    channel: "mattermost";
    accountId: string;
    peer: { kind: "group"; id: string };
  };
}

/**
 * Every binding pins `match.accountId` to `{slug}-coach` so OpenClaw
 * delivers events to the right agent based on which MM auth account
 * received the WS push. Without accountId, a channelId collision would
 * fan events out to every agent that binds it — multi-tenant bleed.
 */
export function buildCustomerBindings(
  customers: ReadonlyArray<{ slug: string; channels: ReadonlyArray<{ channelId: string }> }>,
): OpenClawBinding[] {
  return customers.flatMap((c) => {
    const agentId = `octogee-${c.slug}-coach`;
    const accountId = `${c.slug}-coach`;
    return c.channels.map((binding) => ({
      agentId,
      match: {
        channel: "mattermost" as const,
        accountId,
        peer: { kind: "group" as const, id: binding.channelId },
      },
    }));
  });
}
