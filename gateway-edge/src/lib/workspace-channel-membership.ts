import { isValidCustomChannelName, RESERVED_USERNAMES, USERNAME_RE } from "@octogee/shared/types/identity";
import { db } from "./db.js";
import { mmApi } from "./mattermost.js";
import { addActiveChannelMember, addChannelMember, removeChannelMember, verifiedPrimaryChannelIdFor } from "./channel-lifecycle.js";

const MEMBER_PAGE_SIZE = 200;
const MAX_WORKSPACE_CHANNELS = 512;

function workspaceChannelPath(workspaceSlug: string, name: string): string {
  if (!USERNAME_RE.test(workspaceSlug)) throw new Error("Invalid workspace channel scope");
  return `workspaces/${workspaceSlug}/channels/${name}`;
}

async function workspaceGroupPaths(workspaceSlug: string, includeArchived: boolean): Promise<string[]> {
  const generalPath = workspaceChannelPath(workspaceSlug, "general");
  const channels = await db.collection(`workspaces/${workspaceSlug}/channels`)
    .limit(MAX_WORKSPACE_CHANNELS + 1).get();
  if (channels.docs.length > MAX_WORKSPACE_CHANNELS) throw new Error("Workspace channel directory exceeded its limit");
  const paths = [generalPath];
  for (const channel of channels.docs) {
    if (["general", "coach-dm", "admin"].includes(channel.id)) continue;
    const data = channel.data();
    if (data.kind !== "session" || !isValidCustomChannelName(channel.id) || RESERVED_USERNAMES.has(channel.id)) {
      throw new Error(`Invalid workspace group channel ${channel.ref.path}`);
    }
    if (includeArchived || data.archivedAt === undefined || data.archivedAt === null) paths.push(channel.ref.path);
  }
  return [generalPath, ...paths.slice(1).sort()];
}

export async function addWorkspaceChannelMember(workspaceSlug: string, mmUserId: string): Promise<void> {
  await addChannelMember(workspaceChannelPath(workspaceSlug, "general"), mmUserId);
  const paths = await workspaceGroupPaths(workspaceSlug, false);
  for (const path of paths.slice(1)) await addChannelMember(path, mmUserId);
}

export async function removeWorkspaceChannelMember(workspaceSlug: string, mmUserId: string): Promise<void> {
  await removeChannelMember(workspaceChannelPath(workspaceSlug, "general"), mmUserId);
  const paths = await workspaceGroupPaths(workspaceSlug, true);
  const errors: unknown[] = [];
  for (const path of paths.slice(1)) {
    try {
      await removeChannelMember(path, mmUserId);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, "Workspace group membership removal failed");
}

export async function enrollWorkspaceChannelMembers(workspaceSlug: string, name: string): Promise<void> {
  if (!isValidCustomChannelName(name) || RESERVED_USERNAMES.has(name)) throw new Error("Invalid workspace group channel");
  const path = workspaceChannelPath(workspaceSlug, name);
  const generalId = await verifiedPrimaryChannelIdFor(workspaceChannelPath(workspaceSlug, "general"));
  const memberIds = await workspaceGeneralMemberIds(generalId);
  for (const mmUserId of memberIds) {
    if (!await addActiveChannelMember(path, mmUserId)) continue;
    try {
      await mmApi(`/channels/${generalId}/members/${encodeURIComponent(mmUserId)}`);
    } catch (error) {
      try {
        await removeChannelMember(path, mmUserId);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Workspace group enrollment cleanup failed");
      }
      if (!(error instanceof Error) || (error as Error & { status?: number }).status !== 404) throw error;
    }
  }
}

async function workspaceGeneralMemberIds(generalId: string): Promise<Set<string>> {
  const memberIds = new Set<string>();
  for (let page = 0; ; page++) {
    const members = await mmApi(`/channels/${generalId}/members?page=${page}&per_page=${MEMBER_PAGE_SIZE}`);
    if (!Array.isArray(members)) throw new Error("Invalid workspace General membership response");
    for (const member of members) {
      if (typeof member?.user_id !== "string" || !member.user_id) throw new Error("Invalid workspace General member");
      memberIds.add(member.user_id);
    }
    if (members.length < MEMBER_PAGE_SIZE) break;
  }
  return memberIds;
}
