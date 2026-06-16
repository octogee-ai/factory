import * as crypto from "crypto";
import { FieldValue } from "firebase-admin/firestore";
import { log } from "../config.js";
import { db } from "../firebase.js";
import {
  workspaceGeneralChannelName,
  workspaceCoachChannelName,
  workspaceAdminChannelName,
} from "../../../shared/types/identity.js";
import {
  computeWorkspaceDisplayName,
  WORKSPACE_CHANNEL_DISPLAY_NAMES,
} from "../../../shared/types/display-names.js";
import { mmApiCall, assertMattermostConfigured } from "./client.js";
import { customerChannelMembers } from "./channel-members.js";
import { mintAndPersistCoachToken } from "./coach-pat.js";
import { createOrRestoreChannel } from "./channels.js";
import { communityChannelIds } from "./community.js";
import { mmUploadAvatar } from "./avatars.js";

export async function provisionMattermostUser(
  uid: string, slug: string, firstName: string, email: string,
  vibe?: string | null, lastName?: string, photoURL?: string,
): Promise<Record<string, any>> {
  const MM_ADMIN_USER_ID = process.env.MM_ADMIN_USER_ID;
  const MM_COMMUNITY_TEAM_ID = process.env.MM_COMMUNITY_TEAM_ID;

  assertMattermostConfigured();

  const generatePassword = (): string => {

const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%";
    let pass = "";
    for (let i = 0; i < 24; i++) pass += chars[crypto.randomInt(chars.length)];
    return pass;
  };

  try {

const existingUserDoc = await db.collection("users").doc(uid).get();
    const existingData = existingUserDoc.data() || {};
    if (existingData.mattermost?.userId) {
      const coachDmSnap = await db.doc(`workspaces/${slug}/channels/coach-dm`).get();
      const existingChannelId = coachDmSnap.data()?.mattermost?.channelId;
      if (existingChannelId) {
        log(`[mattermost] user already provisioned (userId=${existingData.mattermost.userId}) — skipping MM creation`);

const coachSecretSnap = await db
          .collection("users").doc(uid)
          .collection("secrets").doc("coachMattermost")
          .get();
        let backfilledCoachUserId: string | null = null;
        let backfilledCoachPersonalToken: string | null = null;

if (coachSecretSnap.exists) {
          const persisted = coachSecretSnap.data()?.personalToken;
          if (typeof persisted === "string" && persisted.length > 0) {
            backfilledCoachPersonalToken = persisted;
          }
        }
        if (!coachSecretSnap.exists) {

const agentSnap = await db.collection("agents").doc(uid).get();
          let coachUserId: string | null = agentSnap.data()?.mattermost?.userId ?? null;
          if (!coachUserId) {
            const coachLookup = await mmApiCall("GET", `/users/username/${slug}-coach`);
            coachUserId = coachLookup?.id ?? null;
          }
          if (coachUserId) {
            const minted = await mintAndPersistCoachToken(
              { mmApiCall, db, now: () => FieldValue.serverTimestamp(), log },
              uid,
              coachUserId,
            );
            if (minted) {
              backfilledCoachUserId = coachUserId;
              backfilledCoachPersonalToken = minted.token;
              log(`[mattermost] coach PAT backfilled for ${slug} on re-provision`);
            } else {
              log(`[mattermost] ⚠ coach PAT backfill failed for ${slug} — coach will fall back to shared bot token`);
            }
          } else {
            log(`[mattermost] ⚠ coach PAT backfill skipped for ${slug}: no coach MM user found`);
          }
        }

        return {
          "mattermost.userId": existingData.mattermost.userId,
          "mattermost.username": existingData.mattermost.username || slug,
          "mattermost.channelId": existingChannelId,
          "mattermost.dmChannelId": existingChannelId,
          ...(backfilledCoachUserId ? { "mattermost.coachUserId": backfilledCoachUserId } : {}),

...(backfilledCoachPersonalToken
            ? { _coachPersonalToken: backfilledCoachPersonalToken }
            : {}),
        };
      }
    }

const username = slug;
    let mmUser = await mmApiCall("POST", "/users", {
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
        if (mmUser.delete_at > 0) {
          await mmApiCall("PUT", `/users/${mmUser.id}/active`, { active: true });
          log(`[mattermost] reactivated user ${mmUser.id}`);
        }
        await mmApiCall("PUT", `/users/${mmUser.id}/patch`, { username, first_name: firstName, last_name: lastName || "" });
      }
    }

    if (!mmUser) {
      log(`[mattermost] ⚠ failed to create or find user ${username}`);
      return {};
    }

const teamName = slug;
    const teamDisplayName = computeWorkspaceDisplayName({ slug, firstName, vibe });
    let teamId: string | null = null;

    let team = await mmApiCall("POST", "/teams", {
      name: teamName,
      display_name: teamDisplayName,
      type: "I", // invite-only
    });
    if (!team) {
      
      team = await mmApiCall("GET", `/teams/name/${teamName}`);
      if (team) log(`[mattermost] team ${teamName} already exists, reusing`);
    }

    if (team) {
      teamId = team.id;
      log(`[mattermost] workspace team created: ${teamName} (${team.id})`);
    } else {
      log(`[mattermost] ⚠ failed to create workspace team ${teamName}`);
      return {};
    }

    if (!teamId) return {};

await mmApiCall("POST", `/teams/${teamId}/members`, {
      team_id: teamId,
      user_id: mmUser.id,
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

    if (MM_ADMIN_USER_ID) {
      await mmApiCall("POST", `/teams/${teamId}/members`, {
        team_id: teamId,
        user_id: MM_ADMIN_USER_ID,
      });
      log(`[mattermost] admin bot added to workspace team ${teamName}`);
    }

    const communityTeamId = MM_COMMUNITY_TEAM_ID;
    if (communityTeamId && communityTeamId !== teamId) {
      await mmApiCall("POST", `/teams/${communityTeamId}/members`, {
        team_id: communityTeamId,
        user_id: mmUser.id,
      });
      log(`[mattermost] joined community team ${communityTeamId}`);
    }

    if (photoURL) {
      const ok = await mmUploadAvatar(mmUser.id, photoURL);
      if (ok) log(`[mattermost] avatar uploaded from OAuth photo`);
    } else if (email && !email.endsWith("@octogee.local")) {

// eslint-disable-next-line sonarjs/hashing -- Gravatar API spec requires md5(email)
      const hash = crypto.createHash("md5").update(email.toLowerCase().trim()).digest("hex");
      const gravatarUrl = `https://gravatar.com/avatar/${hash}?d=identicon&s=200`;
      const ok = await mmUploadAvatar(mmUser.id, gravatarUrl);
      if (ok) log(`[mattermost] avatar uploaded from Gravatar`);
    }

for (const chId of communityChannelIds) {
      await mmApiCall("POST", `/channels/${chId}/members`, {
        user_id: mmUser.id,
      });
    }
    if (communityChannelIds.length > 0) {
      log(`[mattermost] joined ${communityChannelIds.length} community chat channels`);
    }

const channelName = workspaceCoachChannelName(slug);
    const channelDisplayName = WORKSPACE_CHANNEL_DISPLAY_NAMES.coach;
    const channel = await createOrRestoreChannel(
      teamId, channelName, channelDisplayName, "P",
      `${firstName || slug}'s Octogee workspace`,
    );
    if (!channel) {
      log(`[mattermost] ⚠ failed to create channel for ${slug}`);
      return {};
    }

for (const memberId of customerChannelMembers("coach", {
      customerMmUserId: mmUser.id,
      coachMmUserId: null, // added below when coach user is created
      adminMmUserId: MM_ADMIN_USER_ID ?? null,
    })) {
      await mmApiCall("POST", `/channels/${channel.id}/members`, { user_id: memberId });
    }

const generalChannelName = workspaceGeneralChannelName(slug);
    const generalDisplayName = WORKSPACE_CHANNEL_DISPLAY_NAMES.general;
    const generalChannel = await createOrRestoreChannel(
      teamId, generalChannelName, generalDisplayName, "P",
      `${firstName || slug}'s workspace — general discussion`,
    );
    let generalChannelId: string | null = null;
    if (generalChannel) {
      generalChannelId = generalChannel.id;
      
      for (const memberId of customerChannelMembers("general", {
        customerMmUserId: mmUser.id,
        coachMmUserId: null, // added below when coach user is created
        adminMmUserId: MM_ADMIN_USER_ID ?? null,
      })) {
        await mmApiCall("POST", `/channels/${generalChannel.id}/members`, { user_id: memberId });
      }
      log(`[mattermost] general channel created: #${generalChannelName} (${generalChannel.id})`);
    } else {
      log(`[mattermost] ⚠ failed to create general channel for ${slug} — non-fatal`);
    }

const adminChannelName = workspaceAdminChannelName(slug);
    const adminDisplayName = WORKSPACE_CHANNEL_DISPLAY_NAMES.admin;
    const adminChannel = await createOrRestoreChannel(
      teamId, adminChannelName, adminDisplayName, "P",
      `Founder-to-agent guidance for ${firstName || slug}. Customer not a member.`,
    );
    let adminChannelId: string | null = null;
    if (adminChannel) {
      adminChannelId = adminChannel.id;

for (const memberId of customerChannelMembers("admin", {
        customerMmUserId: null, // #170: customer not invited to admin
        coachMmUserId: null,    // added below when coach user is created
        adminMmUserId: MM_ADMIN_USER_ID ?? null,
      })) {
        await mmApiCall("POST", `/channels/${adminChannel.id}/members`, { user_id: memberId });
      }
      log(`[mattermost] admin channel created: #${adminChannelName} (${adminChannel.id})`);
    } else {
      log(`[mattermost] ⚠ failed to create admin channel for ${slug} — non-fatal`);
    }

    const tokenResult = await mmApiCall("POST", `/users/${mmUser.id}/tokens`, {
      description: "Octogee workspace chat",
    });

    log(`[mattermost] ✅ provisioned: ${username} (${mmUser.id}), channel: ${channel.id} (#${channelName})`);

    if (tokenResult?.token) {
      await db.collection("users").doc(uid).collection("secrets").doc("mattermost").set({
        personalToken: tokenResult.token,
        createdAt: FieldValue.serverTimestamp(),
      });
    } else {
      log(`[mattermost] ⚠ no personal token created — chat will be read-only until fixed`);
    }

const coachUsername = `${slug}-coach`;
    const createdBot = await mmApiCall("POST", "/bots", {
      username: coachUsername,
      display_name: "Octo",
      description: `Coach for ${firstName || slug}`,
    });
    let coachMmUser: any = createdBot?.user_id
      ? { id: createdBot.user_id, ...createdBot }
      : null;
    if (!coachMmUser) {
      coachMmUser = await mmApiCall("GET", `/users/username/${coachUsername}`);
      if (coachMmUser) log(`[mattermost] coach bot ${coachUsername} already exists, reusing`);
    }

    let coachMmUserId: string | null = null;
    let coachPersonalToken: string | null = null;
    if (coachMmUser) {
      coachMmUserId = coachMmUser.id;
      
      await mmApiCall("POST", `/teams/${teamId}/members`, {
        team_id: teamId,
        user_id: coachMmUser.id,
      });
      await mmApiCall("POST", `/channels/${channel.id}/members`, { user_id: coachMmUser.id });

if (generalChannelId) {
        await mmApiCall("POST", `/channels/${generalChannelId}/members`, { user_id: coachMmUser.id });
      }
      
      if (adminChannelId) {
        await mmApiCall("POST", `/channels/${adminChannelId}/members`, { user_id: coachMmUser.id });
      }
      log(`[mattermost] coach bot created: ${coachUsername} (${coachMmUser.id})`);

const coachToken = await mintAndPersistCoachToken(
        { mmApiCall, db, now: () => FieldValue.serverTimestamp() },
        uid,
        coachMmUser.id,
      );
      if (coachToken) {
        coachPersonalToken = coachToken.token;
        log(`[mattermost] coach PAT minted and persisted for ${coachUsername}`);

        // NOTE: The onboarding greeting used to post HERE, inline after the
        // PAT mint. That ordering was wrong — it fired before the coach
        // agent was bound in openclaw.json, so any reply the Builder sent
        // to the greeting hit an unmounted coach. The post + its outcome
        // mirror are now owned by `provisionCustomer` (workspace.ts),
        // which runs them AFTER `applyConfigPatch` lands the binding.
      } else {
        log(`[mattermost] ⚠ coach PAT creation failed — coach identity will fall back to octogee-bot until re-provisioned`);
      }
    } else {
      log(`[mattermost] ⚠ failed to create coach bot ${coachUsername} — coach identity will use defaults`);
    }

    return {
      "mattermost.userId": mmUser.id,
      "mattermost.username": username,
      "mattermost.teamId": teamId,
      "mattermost.channelId": channel.id,
      "mattermost.channelName": channelName,
      "mattermost.dmChannelId": channel.id,
      "mattermost.generalChannelId": generalChannelId || null,
      "mattermost.proxyUrl": process.env.API_PUBLIC_URL || "",
      ...(coachMmUserId ? { "mattermost.coachUserId": coachMmUserId } : {}),

...(coachPersonalToken ? { _coachPersonalToken: coachPersonalToken } : {}),
      ...(adminChannelId ? { "mattermost.adminChannelId": adminChannelId } : {}),
      // The boot-greeting outcome key is owned by the customer-lifecycle
      // orchestrator — it schedules the cron AFTER verify-channel-ready
      // passes and persists the cron jobId. Letting the schedule live here
      // would re-open the ordering race the cron cutover closed (greeting
      // fires before the coach agent is bound). See the regression guard
      // in scripts/__tests__/provisioner-greeting-ordering.spec.ts.
    };
  } catch (e: any) {
    log(`[mattermost] ⚠ provisioning failed: ${e.message} — continuing without chat`);
    return {};
  }
}
