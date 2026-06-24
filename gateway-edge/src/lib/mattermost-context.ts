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

type RawDocData = Record<string, unknown>;

interface MattermostContextParts {
  workspace: Awaited<ReturnType<typeof readWorkspace>>;
  generalChan: Awaited<ReturnType<typeof readChannel>>;
  coachDmChan: Awaited<ReturnType<typeof readChannel>>;
  adminChan: Awaited<ReturnType<typeof readChannel>>;
  agent: Awaited<ReturnType<typeof readAgent>>;
}

export async function getWorkspaceMmContext(
  ownerUid: string,
  ownerSlug?: string,
  userDataHint?: unknown,
): Promise<WorkspaceMmContext | null> {
  const userData = await loadUserData(ownerUid, userDataHint);
  if (!userData) return null;
  const slug = resolveWorkspaceSlug(ownerSlug, userData);
  if (!slug) return null;

  const parts = await loadMattermostContextParts(ownerUid, slug);
  return buildWorkspaceMmContext(ownerUid, slug, userData, parts);
}

async function loadUserData(ownerUid: string, userDataHint: unknown): Promise<RawDocData | null> {
  const hinted = asRecord(userDataHint);
  if (hinted) return hinted;
  return asRecord((await db.doc(`users/${ownerUid}`).get()).data());
}

function resolveWorkspaceSlug(ownerSlug: string | undefined, userData: RawDocData): string | null {
  return ownerSlug || stringField(userData, "username") || stringField(userData, "workspaceId");
}

async function loadMattermostContextParts(ownerUid: string, slug: string): Promise<MattermostContextParts> {
  const [workspace, generalChan, coachDmChan, adminChan, agent] = await Promise.all([
    readWorkspace(slug),
    readChannel(db.doc(`workspaces/${slug}/channels/general`)),
    readChannel(db.doc(`workspaces/${slug}/channels/coach-dm`)),
    readChannel(db.doc(`workspaces/${slug}/channels/admin`)),
    readAgent(ownerUid),
  ]);
  return { workspace, generalChan, coachDmChan, adminChan, agent };
}

function buildWorkspaceMmContext(
  ownerUid: string,
  slug: string,
  userData: RawDocData,
  parts: MattermostContextParts,
): WorkspaceMmContext {
  const userMattermost = asRecord(userData.mattermost);
  return {
    ownerUid,
    slug,
    teamId: parts.workspace?.mattermost.teamId ?? null,
    userId: stringField(userMattermost, "userId"),
    username: stringField(userMattermost, "username"),
    coachUserId: parts.agent?.mattermost.userId ?? null,
    coachDmChannelId: parts.coachDmChan?.mattermost.channelId ?? null,
    generalChannelId: parts.generalChan?.mattermost.channelId ?? null,
    adminChannelId: parts.adminChan?.mattermost.channelId ?? null,
  };
}

function asRecord(value: unknown): RawDocData | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as RawDocData;
}

function stringField(record: RawDocData | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}
