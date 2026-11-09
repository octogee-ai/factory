import * as crypto from "crypto";
import { log } from "../config.js";
import { db, platformStateStore } from "../firebase.js";
import { workspaceGeneralChannelName, workspaceCoachChannelName, } from "@octogee/shared/types/identity";
import { computeWorkspaceDisplayName, WORKSPACE_CHANNEL_DISPLAY_NAMES, } from "@octogee/shared/types/display-names";
import { customerChannelMembers } from "./channel-members.js";
import { mintAndPersistCoachToken } from "./coach-pat.js";
import { BUILDER_PAT_DESCRIPTION } from "./builder-pat.js";
import { mmUploadAvatar } from "./avatars.js";
async function backfillCoachIdentity(host, uid, slug) {
    const coachSecret = await platformStateStore.secrets.get(uid, "coachMattermost");
    if (coachSecret !== null) {
        const persisted = coachSecret.kind === "coach-mattermost" ? coachSecret.personalToken : null;
        const token = typeof persisted === "string" && persisted.length > 0 ? persisted : null;
        return { coachUserId: null, personalToken: token };
    }
    let coachUserId = (await platformStateStore.workspaces.agentIdentities.get(uid))?.mattermostUserId ?? null;
    if (!coachUserId) {
        const coachLookup = await host.findUser(`${slug}-coach`);
        coachUserId = coachLookup?.id ?? null;
    }
    if (!coachUserId) {
        log(`[mattermost] ⚠ coach PAT backfill skipped for ${slug}: no coach MM user found`);
        return { coachUserId: null, personalToken: null };
    }
    const minted = await mintAndPersistCoachToken({ channelHost: host, secrets: platformStateStore.secrets, now: () => SERVER_NOW }, uid, coachUserId);
    if (!minted) {
        log(`[mattermost] ⚠ coach PAT backfill failed for ${slug} — coach will fall back to shared bot token`);
        return { coachUserId: null, personalToken: null };
    }
    log(`[mattermost] coach PAT backfilled for ${slug} on re-provision`);
    return { coachUserId, personalToken: minted.token };
}
const SERVER_NOW = { serverNow: true };
function nonEmptyString(value) {
    return typeof value === "string" && value.length > 0 ? value : null;
}
async function loadExistingMattermostTopology(slug) {
    const scope = { workspaceSlug: slug, projectSlug: null };
    const { records, channels } = platformStateStore.workspaces;
    const [workspace, coachDm, general, admin, coachDmPresentation] = await Promise.all([
        records.get(slug),
        channels.get(scope, "coach-dm"),
        channels.get(scope, "general"),
        channels.get(scope, "admin"),
        db.doc(`workspaces/${slug}/channels/coach-dm`).get(),
    ]);
    const teamId = nonEmptyString(workspace?.mattermostTeamId);
    const coachChannelId = nonEmptyString(coachDm?.mattermostChannelId);
    const generalChannelId = nonEmptyString(general?.mattermostChannelId);
    if (!teamId || !coachChannelId || !generalChannelId)
        return null;
    return {
        teamId,
        coachChannelId,
        generalChannelId,
        adminChannelId: nonEmptyString(admin?.mattermostChannelId),
        channelName: nonEmptyString(coachDmPresentation.data()?.name) ?? workspaceCoachChannelName(slug),
    };
}
function existingProvisioningUpdate(input) {
    const { builderUserId, username, topology, coachUserId, personalToken } = input;
    const update = {
        "mattermost.userId": builderUserId,
        "mattermost.username": username,
        "mattermost.teamId": topology.teamId,
        "mattermost.channelId": topology.coachChannelId,
        "mattermost.channelName": topology.channelName,
        "mattermost.dmChannelId": topology.coachChannelId,
        "mattermost.generalChannelId": topology.generalChannelId,
        "mattermost.proxyUrl": process.env.API_PUBLIC_URL || "",
        ...(topology.adminChannelId ? { "mattermost.adminChannelId": topology.adminChannelId } : {}),
    };
    if (coachUserId)
        update["mattermost.coachUserId"] = coachUserId;
    if (personalToken)
        update._coachPersonalToken = personalToken;
    return update;
}
async function backfillExistingProvisioning(host, uid, slug) {
    const [builder, userDoc] = await Promise.all([
        platformStateStore.builders.records.get(uid),
        db.doc(`users/${uid}`).get(),
    ]);
    const builderUserId = nonEmptyString(builder?.mattermostUserId);
    if (!builderUserId)
        return null;
    const topology = await loadExistingMattermostTopology(slug);
    if (!topology)
        return null;
    log(`[mattermost] user already provisioned (userId=${builderUserId}) — skipping MM creation`);
    const backfilledCoach = await backfillCoachIdentity(host, uid, slug);
    const coachUserId = backfilledCoach.coachUserId
        ?? nonEmptyString((await platformStateStore.workspaces.agentIdentities.get(uid))?.mattermostUserId);
    return existingProvisioningUpdate({
        builderUserId,
        username: nonEmptyString(userDoc.data()?.mattermost?.username) ?? slug,
        topology,
        coachUserId,
        personalToken: backfilledCoach.personalToken,
    });
}
async function createOrFindBuilderUser(host, input) {
    const { uid, slug, email, firstName, lastName } = input;
    const username = slug;
    const mmUser = await host.ensureUser({
        username,
        email: email || `${uid}@octogee.local`,
        firstName,
        lastName: lastName || "",
        nickname: firstName || slug,
    });
    if (!mmUser) {
        log(`[mattermost] ⚠ failed to create or find user ${username}`);
        return null;
    }
    return mmUser;
}
async function createOrFindTeam(host, slug, firstName, vibe) {
    const teamName = slug;
    const teamDisplayName = computeWorkspaceDisplayName({ slug, firstName, vibe });
    const team = await host.ensureTeam({
        name: teamName,
        displayName: teamDisplayName,
        inviteOnly: true,
    });
    if (!team) {
        log(`[mattermost] ⚠ failed to create workspace team ${teamName}`);
        return null;
    }
    log(`[mattermost] workspace team created: ${teamName} (${team.id})`);
    return team;
}
async function setupWorkspaceTeam(host, opts) {
    const { teamId, slug, builderUserId, adminUserId } = opts;
    await host.addMember({ teamId }, builderUserId, "team_admin team_user");
    for (const defaultName of ["town-square", "off-topic", "general"]) {
        try {
            const archivedId = await host.archiveChannel({ teamId, name: defaultName });
            if (archivedId) {
                log(`[mattermost] archived default channel #${defaultName} (${archivedId})`);
            }
        }
        catch {
            // Non-fatal — channel may not exist or already archived
        }
    }
    if (adminUserId) {
        await host.addMember({ teamId }, adminUserId);
        log(`[mattermost] admin bot added to workspace team ${slug}`);
    }
}
async function uploadBuilderAvatar(builderUserId, email, photoURL) {
    if (photoURL) {
        const ok = await mmUploadAvatar(builderUserId, photoURL);
        if (ok)
            log(`[mattermost] avatar uploaded from OAuth photo`);
        return;
    }
    if (email && !email.endsWith("@octogee.local")) {
        // eslint-disable-next-line sonarjs/hashing -- Gravatar API spec requires md5(email)
        const hash = crypto.createHash("md5").update(email.toLowerCase().trim()).digest("hex");
        const gravatarUrl = `https://gravatar.com/avatar/${hash}?d=identicon&s=200`;
        const ok = await mmUploadAvatar(builderUserId, gravatarUrl);
        if (ok)
            log(`[mattermost] avatar uploaded from Gravatar`);
    }
}
async function createChannelWithMembers(host, spec, memberIds) {
    const channel = await host.ensureChannel({ ...spec, private: true });
    if (!channel)
        return null;
    for (const memberId of memberIds) {
        await host.addMember({ channelId: channel.id }, memberId);
    }
    return channel.id;
}
async function persistBuilderToken(uid, builderUserId, token) {
    if (token) {
        await platformStateStore.secrets.put(uid, {
            kind: "builder-mattermost",
            secretId: "mattermost",
            projectId: null,
            personalToken: token,
            mattermostUserId: builderUserId,
            createdAt: SERVER_NOW,
            rotatedAt: null,
        });
    }
    else {
        log(`[mattermost] ⚠ no personal token created — chat will be read-only until fixed`);
    }
}
async function createCoachBot(host, input) {
    const { uid, slug, firstName, teamId, coachChannelId, generalChannelId } = input;
    const coachUsername = `${slug}-coach`;
    const coachMmUser = await host.ensureBot({
        username: coachUsername,
        displayName: "Octo",
        description: `Coach for ${firstName || slug}`,
    });
    if (!coachMmUser) {
        log(`[mattermost] ⚠ failed to create coach bot ${coachUsername} — coach identity will use defaults`);
        return { coachUserId: null, personalToken: null };
    }
    await host.addMember({ teamId }, coachMmUser.id);
    await host.addMember({ channelId: coachChannelId }, coachMmUser.id);
    if (generalChannelId) {
        await host.addMember({ channelId: generalChannelId }, coachMmUser.id);
    }
    log(`[mattermost] coach bot created: ${coachUsername} (${coachMmUser.id})`);
    const coachToken = await mintAndPersistCoachToken({ channelHost: host, secrets: platformStateStore.secrets, now: () => SERVER_NOW }, uid, coachMmUser.id);
    if (!coachToken) {
        log(`[mattermost] ⚠ coach PAT creation failed — coach identity will fall back to octogee-bot until re-provisioned`);
        return { coachUserId: coachMmUser.id, personalToken: null };
    }
    log(`[mattermost] coach PAT minted and persisted for ${coachUsername}`);
    return { coachUserId: coachMmUser.id, personalToken: coachToken.token };
}
async function createWorkspaceChannels(host, input) {
    const { teamId, slug, firstName, builderUserId, adminMmUserId } = input;
    const ownerLabel = firstName || slug;
    const coachChannelName = workspaceCoachChannelName(slug);
    const coachChannelId = await createChannelWithMembers(host, {
        teamId,
        name: coachChannelName,
        displayName: WORKSPACE_CHANNEL_DISPLAY_NAMES.coach,
        purpose: `${ownerLabel}'s Octogee workspace`,
    }, customerChannelMembers("coach", { customerMmUserId: builderUserId, coachMmUserId: null, adminMmUserId }));
    if (!coachChannelId) {
        log(`[mattermost] ⚠ failed to create channel for ${slug}`);
        return null;
    }
    const generalChannelName = workspaceGeneralChannelName(slug);
    const generalChannelId = await createChannelWithMembers(host, {
        teamId,
        name: generalChannelName,
        displayName: WORKSPACE_CHANNEL_DISPLAY_NAMES.general,
        purpose: `${ownerLabel}'s workspace — general discussion`,
    }, customerChannelMembers("general", { customerMmUserId: builderUserId, coachMmUserId: null, adminMmUserId }));
    if (generalChannelId)
        log(`[mattermost] general channel created: #${generalChannelName} (${generalChannelId})`);
    else
        log(`[mattermost] ⚠ failed to create general channel for ${slug} — non-fatal`);
    return { coachChannelId, coachChannelName, generalChannelId };
}
function buildResultMap(args) {
    const { builderUserId, slug, teamId, coachChannelId, coachChannelName, generalChannelId, coach } = args;
    return {
        "mattermost.userId": builderUserId,
        "mattermost.username": slug,
        "mattermost.teamId": teamId,
        "mattermost.channelId": coachChannelId,
        "mattermost.channelName": coachChannelName,
        "mattermost.dmChannelId": coachChannelId,
        "mattermost.generalChannelId": generalChannelId || null,
        "mattermost.proxyUrl": process.env.API_PUBLIC_URL || "",
        ...(coach.coachUserId ? { "mattermost.coachUserId": coach.coachUserId } : {}),
        ...(coach.personalToken ? { _coachPersonalToken: coach.personalToken } : {}),
    };
}
export async function provisionMattermostUser(input, host) {
    const { uid, slug, firstName, email, vibe, lastName, photoURL } = input;
    const MM_ADMIN_USER_ID = process.env.MM_ADMIN_USER_ID;
    try {
        const backfilled = await backfillExistingProvisioning(host, uid, slug);
        if (backfilled)
            return backfilled;
        const mmUser = await createOrFindBuilderUser(host, { uid, slug, email, firstName, lastName });
        if (!mmUser)
            return {};
        const team = await createOrFindTeam(host, slug, firstName, vibe);
        if (!team)
            return {};
        const teamId = team.id;
        await setupWorkspaceTeam(host, {
            teamId,
            slug,
            builderUserId: mmUser.id,
            adminUserId: MM_ADMIN_USER_ID,
        });
        await uploadBuilderAvatar(mmUser.id, email, photoURL);
        const channels = await createWorkspaceChannels(host, {
            teamId,
            slug,
            firstName,
            builderUserId: mmUser.id,
            adminMmUserId: MM_ADMIN_USER_ID ?? null,
        });
        if (!channels)
            return {};
        const { coachChannelId, coachChannelName, generalChannelId } = channels;
        const builderToken = await host.issueToken(mmUser.id, BUILDER_PAT_DESCRIPTION);
        log(`[mattermost] ✅ provisioned: ${slug} (${mmUser.id}), channel: ${coachChannelId} (#${coachChannelName})`);
        await persistBuilderToken(uid, mmUser.id, builderToken);
        const coach = await createCoachBot(host, {
            uid,
            slug,
            firstName,
            teamId,
            coachChannelId,
            generalChannelId,
        });
        return buildResultMap({
            builderUserId: mmUser.id,
            slug,
            teamId,
            coachChannelId,
            coachChannelName,
            generalChannelId,
            coach,
        });
    }
    catch (e) {
        log(`[mattermost] ⚠ provisioning failed: ${e instanceof Error ? e.message : String(e)} — continuing without chat`);
        return {};
    }
}
