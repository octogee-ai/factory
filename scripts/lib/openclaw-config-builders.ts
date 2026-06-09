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

export function resolveCoachIdentity(
  custom: CoachIdentity | undefined,
  defaults: CoachIdentityDefaults,
): CoachIdentity {
  return {
    name: (custom?.name && custom.name.length > 0) ? custom.name : defaults.name,
    emoji: (custom?.emoji && custom.emoji.length > 0) ? custom.emoji : defaults.emoji,
  };
}

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

commands?: {
    native: false;
  };
}

export function buildMattermostAccounts(
  customers: ReadonlyArray<MattermostAccountInput>,
  coachTokens: ReadonlyMap<string, string>,
  adminMmUserId?: string | null,
  _warn?: (msg: string) => void,
): Record<string, MattermostAccountEntry> {
  const accounts: Record<string, MattermostAccountEntry> = {};
  for (const c of customers) {
    const token = coachTokens.get(c.uid);
    if (!token) continue;
    // Group channels: the coach answers any member of the channels it has been
    // added to. Mattermost channel membership IS the access boundary (auditable
    // + revocable in MM, and the coach is only ever added to channels its owner
    // controls). The prior owner+admin `allowlist` duplicated that boundary and
    // silently dropped invited guests — breaking shared channels, the headline
    // feature. `groupAllowFrom` is retained as an advisory seed (ignored under
    // "open") for a possible future "synced allowlist" mode. See PR.
    const groupAllowFrom = [c.customerMmUserId, adminMmUserId].filter(
      (id): id is string => typeof id === "string" && id.length > 0,
    );
    accounts[`${c.slug}-coach`] = {
      botToken: token,
      groupPolicy: "open",
      ...(groupAllowFrom.length > 0 ? { groupAllowFrom } : {}),
      commands: { native: false },
    };
  }
  return accounts;
}

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

export interface OpenClawBinding {
  agentId: string;
  match: {
    channel: "mattermost";
    accountId: string;
    peer: { kind: "group"; id: string };
  };
}

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
