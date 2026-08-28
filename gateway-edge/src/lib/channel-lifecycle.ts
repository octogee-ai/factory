import { db } from "./db.js";
import { mmApi } from "./mattermost.js";
import { logger } from "../middleware/logging.js";
import {
  projectChannelName,
  workspaceAdminChannelName,
  workspaceCoachChannelName,
  workspaceCustomChannelName,
  workspaceGeneralChannelName,
} from "@octogee/shared/types/identity";

export class MattermostChannelBindingError extends Error {
  override readonly name = "MattermostChannelBindingError";
}

export class MattermostIdentityMissingError extends Error {
  override readonly name = "MattermostIdentityMissingError";
}

export interface MattermostMembershipErrorResponse {
  status: number;
  body: { error: string };
}

export function mapMattermostMembershipError(err: unknown): MattermostMembershipErrorResponse | null {
  if (err instanceof MattermostIdentityMissingError) {
    return {
      status: 422,
      body: { error: "Your chat account could not be found. Please contact support to restore access." },
    };
  }
  return null;
}

export async function removeChannelMember(
  channelDocPath: string,
  mmUserId: string,
): Promise<void> {
  await deleteMember(await verifiedPrimaryChannelIdFor(channelDocPath), mmUserId);
}

export async function addChannelMember(
  channelDocPath: string,
  mmUserId: string,
): Promise<void> {
  const channelId = await verifiedPrimaryChannelIdFor(channelDocPath);
  await ensureActiveMattermostUser(mmUserId);
  await addMember(channelId, mmUserId);
}

export async function setStoredPrimaryChannelArchived(
  channelDocPath: string,
  archived: boolean,
): Promise<void> {
  const stored = await readStoredChannel(channelDocPath);
  const primary = await requireMattermostChannel(stored.primaryChannelId, "primary");
  assertChannelBinding(primary, stored.binding, "primary");
  await setMattermostChannelArchived(primary.id, archived);
}

export async function setStoredChannelArchived(
  channelDocPath: string,
  archived: boolean,
): Promise<void> {
  await setStoredPrimaryChannelArchived(channelDocPath, archived);
}

export async function ensureActiveMattermostUser(mmUserId: string): Promise<void> {
  const user = await requireMattermostUser(mmUserId);
  if (user.deleteAt > 0) {
    try {
      await mmApi(`/users/${mmUserId}/active`, "PUT", { active: true });
    } catch (error) {
      logger.error(`[mattermost] reactivation failed for soft-deleted Mattermost user ${mmUserId}:`, { err: error });
      throw error;
    }
    logger.warn(`[mattermost] reactivated soft-deleted Mattermost user ${mmUserId}`);
  }
}

export async function assertMattermostUserExists(mmUserId: string): Promise<void> {
  await requireMattermostUser(mmUserId);
}

interface StoredChannel {
  primaryChannelId: string;
  binding: ExpectedBinding;
}

interface ExpectedBinding {
  primaryName: string;
  teamId: string;
}

interface StoredMattermostChannel {
  id: string;
  name: string;
  teamId: string;
  type: "P" | "O";
}

async function verifiedPrimaryChannelIdFor(channelDocPath: string): Promise<string> {
  const stored = await readStoredChannel(channelDocPath);
  const primary = await requireMattermostChannel(stored.primaryChannelId, "primary");
  assertChannelBinding(primary, stored.binding, "primary");
  return primary.id;
}

async function readStoredChannel(channelDocPath: string): Promise<StoredChannel> {
  const snap = await db.doc(channelDocPath).get();
  if (!snap.exists) {
    throw new MattermostChannelBindingError(`channel document ${channelDocPath} was not found`);
  }
  const data = snap.data() ?? {};
  const mattermost = (data.mattermost ?? {}) as Record<string, unknown>;
  const primaryChannelId = typeof mattermost.channelId === "string" ? mattermost.channelId : "";
  if (!primaryChannelId) {
    throw new MattermostChannelBindingError(`channel document ${channelDocPath} has no primary channel`);
  }
  return {
    primaryChannelId,
    binding: await expectedBinding(channelDocPath),
  };
}

async function requireMattermostChannel(
  channelId: string,
  label: string,
): Promise<StoredMattermostChannel> {
  const channel = await readMattermostChannel(`/channels/${encodeURIComponent(channelId)}`);
  if (!channel) throw new MattermostChannelBindingError(`${label} channel ${channelId} was not found`);
  return channel;
}

async function readMattermostChannel(path: string): Promise<StoredMattermostChannel | null> {
  let raw: unknown;
  try {
    raw = await mmApi(path);
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
  if (!raw || typeof raw !== "object") {
    throw new MattermostChannelBindingError(`Mattermost returned an invalid channel for ${path}`);
  }
  const record = raw as Record<string, unknown>;
  if (
    typeof record.id !== "string"
    || typeof record.name !== "string"
    || typeof record.team_id !== "string"
    || (record.type !== "P" && record.type !== "O")
  ) {
    throw new MattermostChannelBindingError(`Mattermost returned an invalid channel for ${path}`);
  }
  return { id: record.id, name: record.name, teamId: record.team_id, type: record.type };
}

function assertChannelBinding(
  channel: StoredMattermostChannel,
  binding: ExpectedBinding,
  label: string,
): void {
  if (channel.teamId !== binding.teamId || channel.name !== binding.primaryName) {
    throw new MattermostChannelBindingError(
      `${label} channel binding mismatch: expected ${binding.teamId}/${binding.primaryName}, got ${channel.teamId}/${channel.name}`,
    );
  }
}

async function setMattermostChannelArchived(channelId: string, archived: boolean): Promise<void> {
  if (archived) {
    await mmApi(`/channels/${channelId}`, "DELETE");
    return;
  }
  await mmApi(`/channels/${channelId}/restore`, "POST");
}

async function requireMattermostUser(mmUserId: string): Promise<{ id: string; deleteAt: number }> {
  const user = await readMattermostUser(mmUserId);
  if (!user) throw new MattermostIdentityMissingError(`Mattermost user ${mmUserId} was not found`);
  return user;
}

async function readMattermostUser(mmUserId: string): Promise<{ id: string; deleteAt: number } | null> {
  let raw: unknown;
  try {
    raw = await mmApi(`/users/${mmUserId}`);
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
  if (!raw || typeof raw !== "object") {
    throw new MattermostChannelBindingError(`Mattermost returned an invalid user for ${mmUserId}`);
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.id !== "string") {
    throw new MattermostChannelBindingError(`Mattermost returned an invalid user for ${mmUserId}`);
  }
  return { id: record.id, deleteAt: typeof record.delete_at === "number" ? record.delete_at : 0 };
}

function isNotFoundError(error: unknown): boolean {
  const status = typeof error === "object" && error !== null
    ? (error as { status?: unknown }).status
    : undefined;
  if (status === 404) return true;
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("404") || message.includes("not_found");
}

async function addMember(channelId: string, mmUserId: string): Promise<void> {
  try {
    await mmApi(`/channels/${channelId}/members`, "POST", { user_id: mmUserId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("409") && !message.includes("user_already_in_channel")) throw error;
  }
}

async function deleteMember(channelId: string, mmUserId: string): Promise<void> {
  try {
    await mmApi(`/channels/${channelId}/members/${mmUserId}`, "DELETE");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("404") && !message.includes("not_found")) throw error;
  }
}

async function expectedBinding(channelDocPath: string): Promise<ExpectedBinding> {
  const parts = channelDocPath.split("/");
  const workspaceId = parts[0] === "workspaces" ? parts[1] : undefined;
  if (!workspaceId) throw new MattermostChannelBindingError(`unsupported channel document path ${channelDocPath}`);
  const workspace = await db.doc(`workspaces/${workspaceId}`).get();
  const teamId = workspace.data()?.mattermost?.teamId;
  if (typeof teamId !== "string" || !teamId) {
    throw new MattermostChannelBindingError(`workspace ${workspaceId} has no Mattermost team binding`);
  }
  if (parts[2] === "channels" && parts[3]) {
    return { primaryName: workspacePrimaryName(workspaceId, parts[3]), teamId };
  }
  if (parts[2] === "projects" && parts[3] && parts[4] === "channels" && parts[5]) {
    return { primaryName: projectChannelName(workspaceId, parts[3], parts[5]), teamId };
  }
  throw new MattermostChannelBindingError(`unsupported channel document path ${channelDocPath}`);
}

function workspacePrimaryName(workspaceId: string, channelId: string): string {
  if (channelId === "general") return workspaceGeneralChannelName(workspaceId);
  if (channelId === "coach-dm") return workspaceCoachChannelName(workspaceId);
  if (channelId === "admin") return workspaceAdminChannelName(workspaceId);
  return workspaceCustomChannelName(workspaceId, channelId);
}
