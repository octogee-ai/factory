import { log } from "../config.js";
import { projectGeneralChannelName, } from "@octogee/shared/types/identity";
import { computeProjectChannelDisplayName } from "@octogee/shared/types/display-names";
import { mmApiCall } from "./client.js";
import { customerChannelMembers } from "./channel-members.js";
export async function createOrRestoreChannel(teamId, name, displayName, type, purpose) {
    let channel = (await mmApiCall("POST", "/channels", {
        team_id: teamId, name, display_name: displayName, type, purpose,
    }));
    if (channel)
        return channel;
    channel = (await mmApiCall("GET", `/teams/${teamId}/channels/name/${name}`));
    if (channel)
        return channel;
    const archived = await mmApiCall("GET", `/teams/${teamId}/channels/name/${name}?include_deleted=true`);
    if (isArchivedChannel(archived, name)) {
        channel = (await mmApiCall("POST", `/channels/${archived.id}/restore`));
        if (channel)
            log(`[mattermost] restored archived channel: ${name}`);
        return channel;
    }
    return null;
}
function isArchivedChannel(candidate, name) {
    if (typeof candidate !== "object" || candidate === null)
        return false;
    const channel = candidate;
    return channel.name === name && typeof channel.id === "string" && (channel.delete_at ?? 0) > 0;
}
export async function createProjectChannel(teamId, // workspace team ID (Phase 4: team-per-workspace)
slug, projectSlug, customerMmUserId, projectName) {
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
