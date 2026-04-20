/**
 * Workspace-scoped Mattermost context resolver.
 *
 * Per DATA-MODEL-REVIEW v3.1 §10.2: the root user-doc `mattermost` field
 * carries only {userId, username} (per-user MM identity for reverse
 * lookup). All workspace-scoped MM identifiers — teamId, coach DM channel,
 * general channel, admin channel, coach agent user ID — live on the
 * canonical workspace / channels / agents docs. This helper fans out the
 * reads in parallel and returns the resolved context for a given user.
 */
import { db } from "./db";
import { readAgent, readChannel, readWorkspace } from "./firestoreReads";

export interface WorkspaceMmContext {
  ownerUid: string;
  slug: string;
  teamId: string | null;
  userId: string | null;
  username: string | null;
  coachUserId: string | null;
  coachDmChannelId: string | null;
  generalChannelId: string | null;
  adminChannelId: string | null;
}

export async function getWorkspaceMmContext(
  ownerUid: string,
  ownerSlug?: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  userDataHint?: any,
): Promise<WorkspaceMmContext | null> {
  const u = userDataHint ?? (await db.doc(`users/${ownerUid}`).get()).data();
  if (!u) return null;
  const slug = ownerSlug || u.username || u.workspaceId;
  if (!slug) return null;

  const [workspace, generalChan, coachDmChan, adminChan, agent] = await Promise.all([
    readWorkspace(slug),
    readChannel(db.doc(`workspaces/${slug}/channels/general`)),
    readChannel(db.doc(`workspaces/${slug}/channels/coach-dm`)),
    readChannel(db.doc(`workspaces/${slug}/channels/admin`)),
    readAgent(ownerUid),
  ]);

  return {
    ownerUid,
    slug,
    teamId: workspace?.mattermost.teamId ?? null,
    userId: u.mattermost?.userId ?? null,
    username: u.mattermost?.username ?? null,
    coachUserId: agent?.mattermost.userId ?? null,
    coachDmChannelId: coachDmChan?.mattermost.channelId ?? null,
    generalChannelId: generalChan?.mattermost.channelId ?? null,
    adminChannelId: adminChan?.mattermost.channelId ?? null,
  };
}
