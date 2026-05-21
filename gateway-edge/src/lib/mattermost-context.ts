import { db } from "./db.js";
import { readAgent, readChannel, readWorkspace } from "./firestoreReads.js";

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
