import { log } from "../config.js";
import { getMmAdminToken, mmApiCall } from "./client.js";

export async function destroyMmUser(userId: string): Promise<void> {
  if (!process.env.MM_URL || !userId) return;

  const MM_URL = process.env.MM_URL;
  const token = await getMmAdminToken();
  if (!token) return;

  const resp = await fetch(`${MM_URL}/api/v4/users/${userId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });

  if (resp.ok || resp.status === 404) {
    log(`[mm-nuke] User ${userId} deleted (or already gone)`);
  } else {
    const text = await resp.text().catch(() => "");
    log(`⚠ [mm-nuke] Failed to delete user ${userId}: ${resp.status} ${text.slice(0, 200)}`);
  }
}

/**
 * Archive a Mattermost channel (soft delete — preserves message history in MM admin).
 * DELETE /channels/{channelId} archives by default in MM.
 * Idempotent: 404 treated as success.
 */
export async function destroyMmChannel(channelId: string): Promise<void> {
  if (!process.env.MM_URL || !channelId) return;

  const MM_URL = process.env.MM_URL;
  const token = await getMmAdminToken();
  if (!token) return;

  const resp = await fetch(`${MM_URL}/api/v4/channels/${channelId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });

  if (resp.ok || resp.status === 404) {
    log(`[mm-nuke] Channel ${channelId} deleted (or already gone)`);
  } else {
    const text = await resp.text().catch(() => "");
    log(`⚠ [mm-nuke] Failed to delete channel ${channelId}: ${resp.status} ${text.slice(0, 200)}`);
  }
}

/**
 * Get all channel IDs for a user in a team.
 */
export async function getMmUserChannels(userId: string, teamId: string): Promise<string[]> {
  if (!process.env.MM_URL || !userId || !teamId) return [];

  const channels = await mmApiCall("GET", `/users/${userId}/teams/${teamId}/channels`);
  if (!Array.isArray(channels)) return [];
  // channels is an array of channel objects with id property
  return channels.map((c: { id: string }) => c.id);
}
