/**
 * Lane-aware PAT resolution for the chat broker.
 *
 * The PAT is the capability boundary (DECISIONS "Vegas: per-project agents"):
 *   - The WORKSPACE agent acts on behalf of the Builder, so it reads with the
 *     Builder's own MM PAT — the human's full context (workspace + any project
 *     channels they are in), which is exactly what "the user's agent always has
 *     the user's context" means.
 *   - A PROJECT agent reads with its own bot PAT, whose MM channel membership
 *     is that project's channels ONLY. Under injection it cannot reach what the
 *     PAT cannot see.
 *
 * No fallback lanes: a missing secret is a refusal, never a broader token.
 */

import { parseAgentId } from "@octogee/shared/types/identity";
import { parseProjectRetention } from "@octogee/shared/types/project-retention";
import { projectAgentSecretDocId } from "@octogee/core/mattermost/project-agent";

export type ChatPatErrorCode =
  | "invalid-agent"
  | "foreign-agent"
  | "no-builder-pat"
  | "no-coach-identity"
  | "no-project-pat"
  | "project-archived";

export class ChatPatError extends Error {
  constructor(
    public readonly code: ChatPatErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ChatPatError";
  }
}

interface SecretsDb {
  doc(path: string): { get(): Promise<{ data(): Record<string, unknown> | undefined }> };
}

export interface ChatIdentityInput {
  uid: string;
  /** The workspace slug the caller was validated as assigned to. */
  slug: string;
  agentId: string;
}

export interface ResolvedChatIdentity {
  lane: "workspace" | "project";
  pat: string;
  /** The agent's own MM user id — its authored posts are labeled `self: true` in results. */
  coachMmUserId: string;
  /** Credential for the `unread` direction: the AGENT's own catch-up cursor. MM only
   *  serves a user's unread state to that user, so this must be the bot's own PAT —
   *  running unread under the builder PAT would either 403 (coach id) or advance the
   *  HUMAN's read marker (`me`), silently clearing their unread badges. */
  unread: { pat: string; mmUserId: string };
  includeArchivedProjectHistory?: true;
}

async function secretData(
  db: SecretsDb,
  uid: string,
  docId: string,
): Promise<Record<string, unknown>> {
  const snap = await db.doc(`users/${uid}/secrets/${docId}`).get();
  return snap.data() ?? {};
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

async function projectArchiveAccess(
  db: SecretsDb,
  uid: string,
): Promise<{ blocksProjectAgent: boolean; historyReadable: boolean }> {
  const user = await db.doc(`users/${uid}`).get();
  const retention = parseProjectRetention(user.data()?.projectRetention);
  if (!retention || retention.status === "active") {
    return { blocksProjectAgent: false, historyReadable: false };
  }
  return {
    blocksProjectAgent: true,
    historyReadable:
      retention.status === "archived" &&
      retention.deleteAfter !== null &&
      retention.deleteAfter.getTime() > Date.now(),
  };
}

export async function resolveChatIdentity(
  db: SecretsDb,
  input: ChatIdentityInput,
): Promise<ResolvedChatIdentity> {
  const parsed = parseAgentId(input.agentId);
  if (parsed.kind === "unknown") {
    throw new ChatPatError("invalid-agent", `unparseable agent id ${input.agentId}`);
  }
  if (parsed.username !== input.slug) {
    throw new ChatPatError(
      "foreign-agent",
      `agent ${input.agentId} does not belong to workspace ${input.slug}`,
    );
  }

  const archiveAccess = await projectArchiveAccess(db, input.uid);

  if (parsed.kind === "project") {
    if (archiveAccess.blocksProjectAgent) {
      throw new ChatPatError(
        "project-archived",
        `project agent ${input.agentId} is disabled while its owner is on Free`,
      );
    }
    const secret = await secretData(
      db,
      input.uid,
      projectAgentSecretDocId(parsed.project),
    );
    const pat = nonEmptyString(secret.personalToken);
    const mmUserId = nonEmptyString(secret.mmUserId);
    if (!pat || !mmUserId) {
      throw new ChatPatError(
        "no-project-pat",
        `project agent ${input.agentId} has no minted PAT — agent disabled or not yet provisioned`,
      );
    }
    return {
      lane: "project",
      pat,
      coachMmUserId: mmUserId,
      unread: { pat, mmUserId },
    };
  }

  const builderSecret = await secretData(db, input.uid, "mattermost");
  const builderPat = nonEmptyString(builderSecret.personalToken);
  if (!builderPat) {
    throw new ChatPatError(
      "no-builder-pat",
      `no builder MM PAT at users/{uid}/secrets/mattermost for ${input.slug} — re-run provisioning`,
    );
  }
  const coachSecret = await secretData(db, input.uid, "coachMattermost");
  const coachMmUserId = nonEmptyString(coachSecret.coachMmUserId);
  const coachPat = nonEmptyString(coachSecret.personalToken);
  if (!coachMmUserId || !coachPat) {
    throw new ChatPatError(
      "no-coach-identity",
      `incomplete users/{uid}/secrets/coachMattermost for ${input.slug} — cannot self-label the agent's own posts or read its unread cursor`,
    );
  }
  return {
    lane: "workspace",
    pat: builderPat,
    coachMmUserId,
    unread: { pat: coachPat, mmUserId: coachMmUserId },
    ...(archiveAccess.historyReadable ? { includeArchivedProjectHistory: true as const } : {}),
  };
}
