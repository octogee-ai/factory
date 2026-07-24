/**
 * Lane-aware PAT resolution for the chat broker.
 *
 * The broker is the WORKSPACE capability boundary: it uses the Builder PAT but
 * returns data only from canonical channels the Builder owns or has joined.
 *   - A PROJECT agent reads with its own bot PAT, whose MM channel membership
 *     is that project's channels ONLY. Under injection it cannot reach what the
 *     PAT cannot see.
 *
 * No fallback lanes: a missing secret is a refusal, never a broader token.
 */

import { parseAgentId } from "@octogee/shared/types/identity";
import { parseProjectRetention } from "@octogee/shared/types/project-retention";
import { projectAgentSecretDocId } from "@octogee/core/mattermost/project-agent";
import { isCanonicalWorkspaceMembership } from "@octogee/core/gateway-principal-access";

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
  doc(path: string): {
    get(): Promise<{
      exists?: boolean;
      data(): Record<string, unknown> | undefined;
    }>;
  };
  collectionGroup(name: string): {
    where(field: string, op: "==", value: unknown): {
      get(): Promise<{
        docs: Array<{
          ref: { path: string };
          data(): Record<string, unknown> | undefined;
        }>;
      }>;
    };
  };
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
  canReadChannel?: (channelId: string) => Promise<boolean>;
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

async function matchingChannelPaths(
  db: SecretsDb,
  channelId: string,
): Promise<string[]> {
  const snapshots = await Promise.all(
    ["mattermost.channelId", "mattermost.activityChannelId"].map((field) =>
      db.collectionGroup("channels").where(field, "==", channelId).get()
    ),
  );
  return [...new Set(snapshots.flatMap((snapshot) =>
    snapshot.docs.map((doc) => doc.ref.path)
  ))];
}

async function workspaceChannelReadable(
  db: SecretsDb,
  uid: string,
  assignedSlug: string,
  workspaceSlug: string,
  channelDocId: string,
): Promise<boolean> {
  if (channelDocId === "admin") return false;
  if (workspaceSlug === assignedSlug) return true;
  const [workspace, membership] = await Promise.all([
    db.doc(`workspaces/${workspaceSlug}`).get(),
    db.doc(`workspaces/${workspaceSlug}/members/${uid}`).get(),
  ]);
  return workspace.data()?.ownerUid === uid ||
    (membership.exists === true &&
      isCanonicalWorkspaceMembership(membership.data()));
}

async function projectChannelReadable(
  db: SecretsDb,
  uid: string,
  workspaceSlug: string,
  projectSlug: string,
): Promise<boolean> {
  const projectPath = `workspaces/${workspaceSlug}/projects/${projectSlug}`;
  const [project, membership] = await Promise.all([
    db.doc(projectPath).get(),
    db.doc(`${projectPath}/members/${uid}`).get(),
  ]);
  const membershipData = membership.data();
  return project.data()?.ownerUid === uid ||
    (membership.exists === true &&
      membershipData?.id === uid &&
      (membershipData.role === "owner" || membershipData.role === "member"));
}

async function canonicalChannelReadable(
  db: SecretsDb,
  uid: string,
  assignedSlug: string,
  channelId: string,
): Promise<boolean> {
  const paths = await matchingChannelPaths(db, channelId);
  for (const path of paths) {
    const workspaceMatch = /^workspaces\/([^/]+)\/channels\/([^/]+)$/u.exec(path);
    if (
      workspaceMatch &&
      await workspaceChannelReadable(
        db,
        uid,
        assignedSlug,
        workspaceMatch[1],
        workspaceMatch[2],
      )
    ) {
      return true;
    }
    const projectMatch =
      /^workspaces\/([^/]+)\/projects\/([^/]+)\/channels\/([^/]+)$/u.exec(path);
    if (
      projectMatch &&
      await projectChannelReadable(db, uid, projectMatch[1], projectMatch[2])
    ) {
      return true;
    }
  }
  return false;
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
    canReadChannel: (channelId) =>
      canonicalChannelReadable(db, input.uid, input.slug, channelId),
    ...(archiveAccess.historyReadable ? { includeArchivedProjectHistory: true as const } : {}),
  };
}
