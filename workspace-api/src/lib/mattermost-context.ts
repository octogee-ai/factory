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

  const [wsSnap, generalSnap, coachDmSnap, adminSnap, agentSnap] = await Promise.all([
    db.doc(`workspaces/${slug}`).get(),
    db.doc(`workspaces/${slug}/channels/general`).get(),
    db.doc(`workspaces/${slug}/channels/coach-dm`).get(),
    db.doc(`workspaces/${slug}/channels/admin`).get(),
    db.doc(`agents/${ownerUid}`).get(),
  ]);

  return {
    ownerUid,
    slug,
    teamId: wsSnap.data()?.mattermost?.teamId ?? null,
    userId: u.mattermost?.userId ?? null,
    username: u.mattermost?.username ?? null,
    coachUserId: agentSnap.data()?.mattermost?.userId ?? null,
    coachDmChannelId: coachDmSnap.data()?.mattermost?.channelId ?? null,
    generalChannelId: generalSnap.data()?.mattermost?.channelId ?? null,
    adminChannelId: adminSnap.data()?.mattermost?.channelId ?? null,
  };
}
