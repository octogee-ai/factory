import { log } from "../config.js";
import {
  projectGeneralChannelName,
} from "../../../shared/types/identity.js";
import { computeProjectChannelDisplayName } from "../../../shared/types/display-names.js";
import { mmApiCall } from "./client.js";
import { customerChannelMembers } from "./channel-members.js";

export async function createOrRestoreChannel(
  teamId: string, name: string, displayName: string, type: string, purpose: string,
): Promise<any | null> {
  let channel = await mmApiCall("POST", "/channels", {
    team_id: teamId, name, display_name: displayName, type, purpose,
  });
  if (channel) return channel;

channel = await mmApiCall("GET", `/teams/${teamId}/channels/name/${name}`);
  if (channel) return channel;

const search = await mmApiCall("POST", `/teams/${teamId}/channels/search`, {
    term: name, include_deleted: true,
  });
  const archived = Array.isArray(search)
    ? search.find((c: any) => c.name === name && c.delete_at > 0)
    : null;
  if (archived) {
    channel = await mmApiCall("POST", `/channels/${archived.id}/restore`);
    if (channel) log(`[mattermost] restored archived channel: ${name}`);
    return channel;
  }

  return null;
}

export async function createProjectChannel(
  teamId: string,         // workspace team ID (Phase 4: team-per-workspace)
  slug: string,
  projectSlug: string,
  customerMmUserId: string,
  projectName: string,
): Promise<string | null> {
  const MM_ADMIN_USER_ID = process.env.MM_ADMIN_USER_ID;

  const effectiveTeamId = teamId;
  if (!process.env.MM_URL || !effectiveTeamId) {
    log(`[mattermost] skipping project channel — MM env vars not set`);
    return null;
  }

const channelName = projectGeneralChannelName(slug, projectSlug);
  const displayName = computeProjectChannelDisplayName({ projectName, channelName: "General" });

  let channel = await mmApiCall("POST", "/channels", {
    team_id: effectiveTeamId,
    name: channelName,
    display_name: displayName,
    type: "P",
    purpose: `Project channel for ${projectName}`,
  });

  if (!channel) {
    channel = await mmApiCall("GET", `/teams/${effectiveTeamId}/channels/name/${channelName}`);
  }

  if (!channel) {
    log(`[mattermost] ⚠ failed to create project channel ${channelName}`);
    return null;
  }

for (const memberId of customerChannelMembers("project", {
    customerMmUserId,
    coachMmUserId: null,
    adminMmUserId: MM_ADMIN_USER_ID ?? null,
  })) {
    await mmApiCall("POST", `/channels/${channel.id}/members`, { user_id: memberId });
  }

  log(`[mattermost] ✅ project channel created: #${channelName} (${channel.id})`);
  return channel.id;
}
