/**
 * Channel create / restore + project channel provisioning.
 *
 * `createOrRestoreChannel` is the internal helper that handles the
 * "name already taken by an archived channel" case — MM returns 400 on
 * the create, 404 on the name lookup, so we fall through to a search
 * with `include_deleted` and restore.
 *
 * `createProjectChannel` is the public entry point used when a new
 * project gets its own MM channel under the workspace team.
 */

import { log } from "../config.js";
import {
  projectGeneralChannelName,
} from "../../../shared/types/identity.js";
import { computeProjectChannelDisplayName } from "../../../shared/types/display-names.js";
import { mmApiCall } from "./client.js";
import { customerChannelMembers } from "./channel-members.js";

/**
 * Create or restore a channel. Handles the case where the channel name exists
 * but is archived (MM returns 400 on create, 404 on name lookup).
 */
export async function createOrRestoreChannel(
  teamId: string, name: string, displayName: string, type: string, purpose: string,
): Promise<any | null> {
  let channel = await mmApiCall("POST", "/channels", {
    team_id: teamId, name, display_name: displayName, type, purpose,
  });
  if (channel) return channel;

  // Name might be claimed by an active channel
  channel = await mmApiCall("GET", `/teams/${teamId}/channels/name/${name}`);
  if (channel) return channel;

  // Search for archived channel and restore
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

/** Create a private Mattermost channel for a project. Returns channel ID or null. */
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

  // Canonical slug: {wsSlug}-proj-{projSlug}-general.
  // Display name follows the "{ProjectName} {ChannelName}" convention so the
  // UI sidebar can group channels under their project by a prefix-match-and-
  // strip rule (no per-channel grouping metadata). Spec:
  // WORKSPACE-NAMING-CANONICAL-SPEC §"Project channels". Future per-project
  // channels (Design, Testing, etc.) reuse computeProjectChannelDisplayName
  // with the same rule — keeps the grouping contract honest.
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

  // Project channel members: customer + admin. Coach is added by
  // workspace-api when the coach user id is known at call time (or on the
  // next provisioner sweep).
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
