import * as crypto from "crypto";
import { FieldValue } from "firebase-admin/firestore";
import { log } from "../config.js";
import { db } from "../firebase.js";
import {
  workspaceGeneralChannelName,
  workspaceCoachChannelName,
} from "@octogee/shared/types/identity";
import {
  computeWorkspaceDisplayName,
  WORKSPACE_CHANNEL_DISPLAY_NAMES,
} from "@octogee/shared/types/display-names";
import { mmApiCall, assertMattermostConfigured } from "./client.js";
import { customerChannelMembers } from "./channel-members.js";
import { mintAndPersistCoachToken } from "./coach-pat.js";
import { createOrRestoreChannel } from "./channels.js";
import { mmUploadAvatar } from "./avatars.js";

interface MmEntity {
  id: string;
  delete_at?: number;
  token?: string;
  [key: string]: unknown;
}

export interface ProvisionMattermostUserInput {
  uid: string;
  slug: string;
  firstName: string;
  email: string;
  vibe?: string | null;
  lastName?: string;
  photoURL?: string;
}

function generatePassword(): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%";
  let pass = "";
  for (let i = 0; i < 24; i++) pass += chars[crypto.randomInt(chars.length)];
  return pass;
}

async function backfillCoachIdentity(
  uid: string,
  slug: string,
): Promise<{ coachUserId: string | null; personalToken: string | null }> {
  const coachSecretSnap = await db
    .collection("users").doc(uid)
    .collection("secrets").doc("coachMattermost")
    .get();
  if (coachSecretSnap.exists) {
    const persisted = coachSecretSnap.data()?.personalToken;
    const token = typeof persisted === "string" && persisted.length > 0 ? persisted : null;
    return { coachUserId: null, personalToken: token };
  }

  const agentSnap = await db.collection("agents").doc(uid).get();
  let coachUserId: string | null = agentSnap.data()?.mattermost?.userId ?? null;
  if (!coachUserId) {
    const coachLookup = await mmApiCall("GET", `/users/username/${slug}-coach`);
    coachUserId = coachLookup?.id ?? null;
  }
  if (!coachUserId) {
    log(`[mattermost] ⚠ coach PAT backfill skipped for ${slug}: no coach MM user found`);
    return { coachUserId: null, personalToken: null };
  }

  const minted = await mintAndPersistCoachToken(
    { mmApiCall, db, now: () => FieldValue.serverTimestamp(), log },
    uid,
    coachUserId,
  );
  if (!minted) {
    log(`[mattermost] ⚠ coach PAT backfill failed for ${slug} — coach will fall back to shared bot token`);
    return { coachUserId: null, personalToken: null };
  }
  log(`[mattermost] coach PAT backfilled for ${slug} on re-provision`);
  return { coachUserId, personalToken: minted.token };
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function existingTeamId(existing: unknown, workspace: unknown): string | null {
  return existing === null || existing === undefined
    ? nonEmptyString(workspace)
    : nonEmptyString(existing);
}

interface ExistingMattermostTopology {
  teamId: string;
  coachChannelId: string;
  generalChannelId: string;
  adminChannelId: string | null;
  channelName: string;
}

async function loadExistingMattermostTopology(
  slug: string,
  existingMattermost: Record<string, unknown>,
): Promise<ExistingMattermostTopology | null> {
  const [workspaceSnap, coachDmSnap, generalSnap, adminSnap] = await Promise.all([
    db.doc(`workspaces/${slug}`).get(),
    db.doc(`workspaces/${slug}/channels/coach-dm`).get(),
    db.doc(`workspaces/${slug}/channels/general`).get(),
    db.doc(`workspaces/${slug}/channels/admin`).get(),
  ]);
  const teamId = existingTeamId(
    existingMattermost.teamId,
    workspaceSnap.data()?.mattermost?.teamId,
  );
  const coachChannelId = nonEmptyString(coachDmSnap.data()?.mattermost?.channelId);
  const generalChannelId = nonEmptyString(generalSnap.data()?.mattermost?.channelId);
  const adminChannelId = nonEmptyString(adminSnap.data()?.mattermost?.channelId);
  if (!teamId || !coachChannelId || !generalChannelId) return null;
  return {
    teamId,
    coachChannelId,
    generalChannelId,
    adminChannelId,
    channelName: nonEmptyString(coachDmSnap.data()?.name) ?? workspaceCoachChannelName(slug),
  };
}

function existingProvisioningUpdate(input: {
  builderUserId: string;
  slug: string;
  existingMattermost: Record<string, unknown>;
  topology: ExistingMattermostTopology;
  coachUserId: string | null;
  personalToken: string | null;
}): Record<string, unknown> {
  const { builderUserId, slug, existingMattermost, topology, coachUserId, personalToken } = input;
  const update: Record<string, unknown> = {
    "mattermost.userId": builderUserId,
    "mattermost.username": nonEmptyString(existingMattermost.username) ?? slug,
    "mattermost.teamId": topology.teamId,
    "mattermost.channelId": topology.coachChannelId,
    "mattermost.channelName": topology.channelName,
    "mattermost.dmChannelId": topology.coachChannelId,
    "mattermost.generalChannelId": topology.generalChannelId,
    "mattermost.proxyUrl": process.env.API_PUBLIC_URL || "",
    ...(topology.adminChannelId ? { "mattermost.adminChannelId": topology.adminChannelId } : {}),
  };
  if (coachUserId) update["mattermost.coachUserId"] = coachUserId;
  if (personalToken) update._coachPersonalToken = personalToken;
  return update;
}

async function backfillExistingProvisioning(
  uid: string,
  slug: string,
): Promise<Record<string, unknown> | null> {
  const existingData = (await db.collection("users").doc(uid).get()).data() || {};
  const existingMattermost = (existingData.mattermost as Record<string, unknown> | undefined) ?? {};
  const builderUserId = nonEmptyString(existingMattermost.userId);
  if (!builderUserId) return null;

  const topology = await loadExistingMattermostTopology(slug, existingMattermost);
  if (!topology) return null;

  log(`[mattermost] user already provisioned (userId=${builderUserId}) — skipping MM creation`);
  const backfilledCoach = await backfillCoachIdentity(uid, slug);
  const coachUserId = backfilledCoach.coachUserId
    ?? nonEmptyString(existingMattermost.coachUserId);
  return existingProvisioningUpdate({
    builderUserId,
    slug,
    existingMattermost,
    topology,
    coachUserId,
    personalToken: backfilledCoach.personalToken,
  });
}

async function createOrFindBuilderUser(input: {
  uid: string;
  slug: string;
  email: string;
  firstName: string;
  lastName?: string;
}): Promise<MmEntity | null> {
  const { uid, slug, email, firstName, lastName } = input;
  const username = slug;
  let mmUser: MmEntity | null = await mmApiCall("POST", "/users", {
    email: email || `${uid}@octogee.local`,
    username,
    password: generatePassword(),
    first_name: firstName,
    last_name: lastName || "",
    nickname: firstName || slug,
    roles: "system_user",
  });

  if (!mmUser) {
    mmUser = await mmApiCall("GET", `/users/username/${username}`);
    if (mmUser) log(`[mattermost] user ${username} already exists, reusing`);
  }
  if (!mmUser) {
    const userEmail = email || `${uid}@octogee.local`;
    mmUser = await mmApiCall("GET", `/users/email/${encodeURIComponent(userEmail)}`);
    if (mmUser) {
      log(`[mattermost] found existing user by email (${userEmail}), reactivating + updating username`);
      if ((mmUser.delete_at ?? 0) > 0) {
        await mmApiCall("PUT", `/users/${mmUser.id}/active`, { active: true });
        log(`[mattermost] reactivated user ${mmUser.id}`);
      }
      await mmApiCall("PUT", `/users/${mmUser.id}/patch`, { username, first_name: firstName, last_name: lastName || "" });
    }
  }
  if (!mmUser) {
    log(`[mattermost] ⚠ failed to create or find user ${username}`);
    return null;
  }
  return mmUser;
}

async function createOrFindTeam(
  slug: string,
  firstName: string,
  vibe?: string | null,
): Promise<MmEntity | null> {
  const teamName = slug;
  const teamDisplayName = computeWorkspaceDisplayName({ slug, firstName, vibe });

  let team: MmEntity | null = await mmApiCall("POST", "/teams", {
    name: teamName,
    display_name: teamDisplayName,
    type: "I", // invite-only
  });
  if (!team) {
    team = await mmApiCall("GET", `/teams/name/${teamName}`);
    if (team) log(`[mattermost] team ${teamName} already exists, reusing`);
  }
  if (!team) {
    log(`[mattermost] ⚠ failed to create workspace team ${teamName}`);
    return null;
  }
  log(`[mattermost] workspace team created: ${teamName} (${team.id})`);
  return team;
}

async function setupWorkspaceTeam(opts: {
  teamId: string;
  slug: string;
  builderUserId: string;
  adminUserId?: string;
}): Promise<void> {
  const { teamId, slug, builderUserId, adminUserId } = opts;

  await mmApiCall("POST", `/teams/${teamId}/members`, {
    team_id: teamId,
    user_id: builderUserId,
    roles: "team_admin team_user",
  });

  for (const defaultName of ["town-square", "off-topic", "general"]) {
    try {
      const ch = await mmApiCall("GET", `/teams/${teamId}/channels/name/${defaultName}`);
      if (ch?.id) {
        await mmApiCall("DELETE", `/channels/${ch.id}`);
        log(`[mattermost] archived default channel #${defaultName} (${ch.id})`);
      }
    } catch {
      // Non-fatal — channel may not exist or already archived
    }
  }

  if (adminUserId) {
    await mmApiCall("POST", `/teams/${teamId}/members`, { team_id: teamId, user_id: adminUserId });
    log(`[mattermost] admin bot added to workspace team ${slug}`);
  }
}

async function uploadBuilderAvatar(builderUserId: string, email: string, photoURL?: string): Promise<void> {
  if (photoURL) {
    const ok = await mmUploadAvatar(builderUserId, photoURL);
    if (ok) log(`[mattermost] avatar uploaded from OAuth photo`);
    return;
  }
  if (email && !email.endsWith("@octogee.local")) {
    // eslint-disable-next-line sonarjs/hashing -- Gravatar API spec requires md5(email)
    const hash = crypto.createHash("md5").update(email.toLowerCase().trim()).digest("hex");
    const gravatarUrl = `https://gravatar.com/avatar/${hash}?d=identicon&s=200`;
    const ok = await mmUploadAvatar(builderUserId, gravatarUrl);
    if (ok) log(`[mattermost] avatar uploaded from Gravatar`);
  }
}

async function createChannelWithMembers(
  teamId: string,
  name: string,
  displayName: string,
  purpose: string,
  memberIds: string[],
): Promise<string | null> {
  const channel = await createOrRestoreChannel(teamId, name, displayName, "P", purpose);
  if (!channel) return null;
  for (const memberId of memberIds) {
    await mmApiCall("POST", `/channels/${channel.id}/members`, { user_id: memberId });
  }
  return channel.id;
}

async function persistBuilderToken(uid: string, tokenResult: MmEntity | null): Promise<void> {
  if (tokenResult?.token) {
    await db.collection("users").doc(uid).collection("secrets").doc("mattermost").set({
      personalToken: tokenResult.token,
      createdAt: FieldValue.serverTimestamp(),
    });
  } else {
    log(`[mattermost] ⚠ no personal token created — chat will be read-only until fixed`);
  }
}

async function createCoachBot(input: {
  uid: string;
  slug: string;
  firstName: string;
  teamId: string;
  coachChannelId: string;
  generalChannelId: string | null;
}): Promise<{ coachUserId: string | null; personalToken: string | null }> {
  const { uid, slug, firstName, teamId, coachChannelId, generalChannelId } = input;

  const coachUsername = `${slug}-coach`;
  const createdBot = await mmApiCall("POST", "/bots", {
    username: coachUsername,
    display_name: "Octo",
    description: `Coach for ${firstName || slug}`,
  });
  let coachMmUser: MmEntity | null = createdBot?.user_id ? { id: createdBot.user_id, ...createdBot } : null;
  if (!coachMmUser) {
    coachMmUser = await mmApiCall("GET", `/users/username/${coachUsername}`);
    if (coachMmUser) log(`[mattermost] coach bot ${coachUsername} already exists, reusing`);
  }
  if (!coachMmUser) {
    log(`[mattermost] ⚠ failed to create coach bot ${coachUsername} — coach identity will use defaults`);
    return { coachUserId: null, personalToken: null };
  }

  await mmApiCall("POST", `/teams/${teamId}/members`, { team_id: teamId, user_id: coachMmUser.id });
  await mmApiCall("POST", `/channels/${coachChannelId}/members`, { user_id: coachMmUser.id });
  if (generalChannelId) {
    await mmApiCall("POST", `/channels/${generalChannelId}/members`, { user_id: coachMmUser.id });
  }
  log(`[mattermost] coach bot created: ${coachUsername} (${coachMmUser.id})`);

  const coachToken = await mintAndPersistCoachToken(
    { mmApiCall, db, now: () => FieldValue.serverTimestamp() },
    uid,
    coachMmUser.id,
  );
  if (!coachToken) {
    log(`[mattermost] ⚠ coach PAT creation failed — coach identity will fall back to octogee-bot until re-provisioned`);
    return { coachUserId: coachMmUser.id, personalToken: null };
  }
  log(`[mattermost] coach PAT minted and persisted for ${coachUsername}`);
  return { coachUserId: coachMmUser.id, personalToken: coachToken.token };
}

async function createWorkspaceChannels(
  teamId: string,
  slug: string,
  firstName: string,
  builderUserId: string,
  adminMmUserId: string | null,
): Promise<{
  coachChannelId: string;
  coachChannelName: string;
  generalChannelId: string | null;
} | null> {
  const ownerLabel = firstName || slug;

  const coachChannelName = workspaceCoachChannelName(slug);
  const coachChannelId = await createChannelWithMembers(
    teamId,
    coachChannelName,
    WORKSPACE_CHANNEL_DISPLAY_NAMES.coach,
    `${ownerLabel}'s Octogee workspace`,
    customerChannelMembers("coach", { customerMmUserId: builderUserId, coachMmUserId: null, adminMmUserId }),
  );
  if (!coachChannelId) {
    log(`[mattermost] ⚠ failed to create channel for ${slug}`);
    return null;
  }

  const generalChannelName = workspaceGeneralChannelName(slug);
  const generalChannelId = await createChannelWithMembers(
    teamId,
    generalChannelName,
    WORKSPACE_CHANNEL_DISPLAY_NAMES.general,
    `${ownerLabel}'s workspace — general discussion`,
    customerChannelMembers("general", { customerMmUserId: builderUserId, coachMmUserId: null, adminMmUserId }),
  );
  if (generalChannelId) log(`[mattermost] general channel created: #${generalChannelName} (${generalChannelId})`);
  else log(`[mattermost] ⚠ failed to create general channel for ${slug} — non-fatal`);

  return { coachChannelId, coachChannelName, generalChannelId };
}

function buildResultMap(args: {
  builderUserId: string;
  slug: string;
  teamId: string;
  coachChannelId: string;
  coachChannelName: string;
  generalChannelId: string | null;
  coach: { coachUserId: string | null; personalToken: string | null };
}): Record<string, unknown> {
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

export async function provisionMattermostUser(
  input: ProvisionMattermostUserInput,
): Promise<Record<string, unknown>> {
  const { uid, slug, firstName, email, vibe, lastName, photoURL } = input;
  const MM_ADMIN_USER_ID = process.env.MM_ADMIN_USER_ID;

  assertMattermostConfigured();

  try {
    const backfilled = await backfillExistingProvisioning(uid, slug);
    if (backfilled) return backfilled;

    const mmUser = await createOrFindBuilderUser({ uid, slug, email, firstName, lastName });
    if (!mmUser) return {};

    const team = await createOrFindTeam(slug, firstName, vibe);
    if (!team) return {};
    const teamId = team.id;

    await setupWorkspaceTeam({
      teamId,
      slug,
      builderUserId: mmUser.id,
      adminUserId: MM_ADMIN_USER_ID,
    });
    await uploadBuilderAvatar(mmUser.id, email, photoURL);

    const channels = await createWorkspaceChannels(teamId, slug, firstName, mmUser.id, MM_ADMIN_USER_ID ?? null);
    if (!channels) return {};
    const { coachChannelId, coachChannelName, generalChannelId } = channels;

    const tokenResult = await mmApiCall("POST", `/users/${mmUser.id}/tokens`, {
      description: "Octogee workspace chat",
    });
    log(`[mattermost] ✅ provisioned: ${slug} (${mmUser.id}), channel: ${coachChannelId} (#${coachChannelName})`);
    await persistBuilderToken(uid, tokenResult);

    const coach = await createCoachBot({
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
  } catch (e: unknown) {
    log(`[mattermost] ⚠ provisioning failed: ${e instanceof Error ? e.message : String(e)} — continuing without chat`);
    return {};
  }
}
