/**
 * `provisionMattermostUser` — the big end-to-end "new Builder MM setup"
 * flow. Called once per new customer during workspace provisioning.
 *
 * Does (in order):
 *   1. Idempotency short-circuit if user doc already has an MM userId
 *      (and backfills the coach PAT if missing — for pre-spec customers).
 *   2. Create MM user (reuse by username or email if it already exists,
 *      reactivating if deleted).
 *   3. Create the per-workspace team (`name = slug`; display name comes
 *      from `computeWorkspaceDisplayName`).
 *   4. Archive the auto-created `town-square` / `off-topic` / `general`
 *      MM channels so they don't clutter the admin sidebar.
 *   5. Join user + admin bot to the workspace team; join user to the
 *      community team.
 *   6. Upload avatar (OAuth photo > Gravatar > none).
 *   7. Auto-join community channels (legacy — for workspaces using the
 *      shared team).
 *   8. Create the three workspace channels (coach, general, admin — all
 *      type "P"). Admin channel EXCLUDES the builder (#170).
 *   9. Mint the builder's personal access token.
 *   10. Create the `{slug}-coach` MM bot, join it to the three channels,
 *      mint a PAT for it, and post the onboarding greeting to the coach
 *      channel.
 *
 * Returns the `mmUpdate` map that `markProvisioningComplete` flattens
 * onto `users/{uid}/system/config`. `_coachPersonalToken` is EPHEMERAL —
 * filtered out at write time because the authoritative copy lives at
 * `users/{uid}/secrets/coachMattermost`.
 */

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
import { mmApiCall } from "./client.js";
import { customerChannelMembers } from "./channel-members.js";
import { mintAndPersistCoachToken } from "./coach-pat.js";
import { createOrRestoreChannel } from "./channels.js";
import { communityChannelIds, communityActivityChannelIds } from "./community.js";
import { mmUploadAvatar } from "./avatars.js";

export async function provisionMattermostUser(
  uid: string, slug: string, firstName: string, email: string,
  vibe?: string | null, lastName?: string, photoURL?: string,
): Promise<Record<string, any>> {
  const MM_ADMIN_USER_ID = process.env.MM_ADMIN_USER_ID;
  const MM_PUBLIC_URL = process.env.MM_PUBLIC_URL || process.env.MM_URL;
  const MM_COMMUNITY_TEAM_ID = process.env.MM_COMMUNITY_TEAM_ID;

  if (!process.env.MM_URL || !process.env.MM_BOT_TOKEN) {
    log(`[mattermost] skipping — MM env vars not set`);
    return {};
  }

  const generatePassword = (): string => {
    // crypto.randomInt uses rejection sampling so each char is drawn
    // uniformly from the 67-char alphabet. The earlier `randomBytes(24)[i]
    // % chars.length` pattern introduced modulo bias (257 % 67 = 55 got
    // more representation than indices ≥ 55 % 67) — low-impact for a
    // 24-char password but CodeQL's js/biased-cryptographic-random flags it.
    const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%";
    let pass = "";
    for (let i = 0; i < 24; i++) pass += chars[crypto.randomInt(chars.length)];
    return pass;
  };

  try {
    // Idempotency check (v3.1): user doc carries only userId+username; the
    // coach DM channel now lives at workspaces/{slug}/channels/coach-dm.
    const existingUserDoc = await db.collection("users").doc(uid).get();
    const existingData = existingUserDoc.data() || {};
    if (existingData.mattermost?.userId) {
      const coachDmSnap = await db.doc(`workspaces/${slug}/channels/coach-dm`).get();
      const existingChannelId = coachDmSnap.data()?.mattermost?.channelId;
      if (existingChannelId) {
        log(`[mattermost] user already provisioned (userId=${existingData.mattermost.userId}) — skipping MM creation`);

        // Backfill the coach PAT when the secrets doc is missing. Pre-
        // MM-COACH-IDENTITY-SPEC workspaces have a coach MM user but no
        // PAT on disk; the short-circuit used to return without minting
        // and the coach was stuck with no token forever. Mint on-demand
        // so re-triggering onboarding for an existing customer self-
        // heals. Spec D2 / M1.
        const coachSecretSnap = await db
          .collection("users").doc(uid)
          .collection("secrets").doc("coachMattermost")
          .get();
        let backfilledCoachUserId: string | null = null;
        let backfilledCoachPersonalToken: string | null = null;
        // If the secret already exists, read the token so we still thread it
        // back through mmUpdate → `wireCoachMattermostAccount`. Otherwise an
        // existing-customer re-provision would leave `channels.mattermost.
        // accounts.{slug}-coach` unset and OpenClaw would drop the coach WS.
        if (coachSecretSnap.exists) {
          const persisted = coachSecretSnap.data()?.personalToken;
          if (typeof persisted === "string" && persisted.length > 0) {
            backfilledCoachPersonalToken = persisted;
          }
        }
        if (!coachSecretSnap.exists) {
          // Need the coach MM user id. Prefer agents/{uid}.mattermost.userId
          // (set during full provisioning); fall back to a MM lookup by the
          // canonical `{slug}-coach` username.
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
          // `_coachPersonalToken` (underscore prefix) is an EPHEMERAL field
          // read in-process by `wireCoachMattermostAccount` and explicitly
          // NOT written to Firestore — `markProvisioningComplete` filters
          // the mmUpdate map by `mattermost.*` prefix so the underscore
          // key falls out. The authoritative token lives at
          // `users/{uid}/secrets/coachMattermost`; duplicating it into
          // `users/{uid}/system/config.mattermost.coachPersonalToken`
          // would just widen its blast radius. Boot-sync reads the
          // authoritative copy directly (scripts/boot-sync.ts:fetchCoachTokens).
          ...(backfilledCoachPersonalToken
            ? { _coachPersonalToken: backfilledCoachPersonalToken }
            : {}),
        };
      }
    }

    // Per DATA-MODEL-REVIEW v3 §2: slug = username. MM username is the same
    // string, capped at USERNAME_MAX (16) to leave room for `-coach` suffix
    // inside MM's 22-char username limit.
    const username = slug;
    let mmUser = await mmApiCall("POST", "/users", {
      email: email || `${uid}@octogee.local`,
      username,
      password: generatePassword(),
      first_name: firstName,
      last_name: lastName || "",
      nickname: firstName || slug,
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

    // ── Create workspace team (team-per-workspace: Phase 4) ──────────────────
    // Team name = username (v3 §2 — username is everything).
    // Team display_name is MM-canonical and computed deterministically from
    // (slug, firstName, vibe). See shared/types/display-names.ts and the
    // WORKSPACE-NAMING-CANONICAL-SPEC for the rule. No Firestore read — the
    // vibe comes in as a function argument, not as a `users/{uid}.workspaceName`
    // field (that ghost field was removed).
    const teamName = slug;
    const teamDisplayName = computeWorkspaceDisplayName({ slug, firstName, vibe });
    let teamId: string | null = null;

    let team = await mmApiCall("POST", "/teams", {
      name: teamName,
      display_name: teamDisplayName,
      type: "I", // invite-only
    });
    if (!team) {
      // Team may already exist (re-provision)
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

    // Add user as team_admin of workspace team
    // Note: team_id is required in body for Team Edition (not just the URL)
    await mmApiCall("POST", `/teams/${teamId}/members`, {
      team_id: teamId,
      user_id: mmUser.id,
      roles: "team_admin team_user",
    });

    // Archive MM's auto-created default channels (town-square, off-topic, general).
    // MM creates these on every new team — they clutter the admin sidebar as orphaned
    // channels since they don't match the {slug}-* naming convention (#228, #229).
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

    // Add admin bot to workspace team
    if (MM_ADMIN_USER_ID) {
      await mmApiCall("POST", `/teams/${teamId}/members`, {
        team_id: teamId,
        user_id: MM_ADMIN_USER_ID,
      });
      log(`[mattermost] admin bot added to workspace team ${teamName}`);
    }

    // Join user to community team
    const communityTeamId = MM_COMMUNITY_TEAM_ID;
    if (communityTeamId && communityTeamId !== teamId) {
      await mmApiCall("POST", `/teams/${communityTeamId}/members`, {
        team_id: communityTeamId,
        user_id: mmUser.id,
      });
      log(`[mattermost] joined community team ${communityTeamId}`);
    }

    // Upload avatar
    if (photoURL) {
      const ok = await mmUploadAvatar(mmUser.id, photoURL);
      if (ok) log(`[mattermost] avatar uploaded from OAuth photo`);
    } else if (email && !email.endsWith("@octogee.local")) {
      // Gravatar protocol REQUIRES md5(email) as the URL identifier — see
      // https://docs.gravatar.com/api/avatars/. Not a security context;
      // the hash is just an opaque-to-us avatar key.
      // eslint-disable-next-line sonarjs/hashing -- Gravatar API spec requires md5(email)
      const hash = crypto.createHash("md5").update(email.toLowerCase().trim()).digest("hex");
      const gravatarUrl = `https://gravatar.com/avatar/${hash}?d=identicon&s=200`;
      const ok = await mmUploadAvatar(mmUser.id, gravatarUrl);
      if (ok) log(`[mattermost] avatar uploaded from Gravatar`);
    }

    // Auto-join community channels (legacy — for workspaces using shared team)
    // including their activity-stream siblings (spec OI5) so the bridge's
    // posts are visible to every member of the primary social channel.
    const joinIds = [...communityChannelIds, ...communityActivityChannelIds];
    for (const chId of joinIds) {
      await mmApiCall("POST", `/channels/${chId}/members`, {
        user_id: mmUser.id,
      });
    }
    if (joinIds.length > 0) {
      log(
        `[mattermost] joined ${communityChannelIds.length} community + ${communityActivityChannelIds.length} activity siblings`,
      );
    }

    // ── Create channels in workspace team ───────────────────────────────────

    // Octo coach channel — MM type "P" (private) so octogee-admin can
    // observe, but rendered as a DM in the UI by convention. Display name
    // is the plain word "Coach" — see WORKSPACE-NAMING-CANONICAL-SPEC.
    // Canonical slug: {wsSlug}-coach.
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

    // Coach channel members: customer + (coach later) + admin.
    // Coach is added below once coachMmUser exists. Under OpenClaw's
    // multi-account MM plugin, the coach's own PAT drives the WS
    // subscription — no shared bot needed as a channel member.
    for (const memberId of customerChannelMembers("coach", {
      customerMmUserId: mmUser.id,
      coachMmUserId: null, // added below when coach user is created
      adminMmUserId: MM_ADMIN_USER_ID ?? null,
    })) {
      await mmApiCall("POST", `/channels/${channel.id}/members`, { user_id: memberId });
    }

    // #general channel — workspace lobby, visible to all workspace members.
    // Canonical slug: {wsSlug}-general. Display name from the shared constant.
    const generalChannelName = workspaceGeneralChannelName(slug);
    const generalDisplayName = WORKSPACE_CHANNEL_DISPLAY_NAMES.general;
    const generalChannel = await createOrRestoreChannel(
      teamId, generalChannelName, generalDisplayName, "P",
      `${firstName || slug}'s workspace — general discussion`,
    );
    let generalChannelId: string | null = null;
    if (generalChannel) {
      generalChannelId = generalChannel.id;
      // General channel members: customer + (coach added below) + admin.
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

    // Admin channel — founder-to-agent guidance, Builder NOT invited (#170).
    // Canonical slug: {wsSlug}-admin. Display name from the shared constant —
    // plain "Admin", no per-customer suffix.
    const adminChannelName = workspaceAdminChannelName(slug);
    const adminDisplayName = WORKSPACE_CHANNEL_DISPLAY_NAMES.admin;
    const adminChannel = await createOrRestoreChannel(
      teamId, adminChannelName, adminDisplayName, "P",
      `Founder-to-agent guidance for ${firstName || slug}. Customer not a member.`,
    );
    let adminChannelId: string | null = null;
    if (adminChannel) {
      adminChannelId = adminChannel.id;
      // Admin channel members: admin + coach. Customer NOT invited (#170).
      // Coach added below when coach user is created.
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

    // Create personal access token
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

    // Create per-customer coach MM bot. Handle = `{username}-coach` — hyphen
    // matches the platform-wide identifier convention (mac-gw-prod,
    // {slug}-general, etc.). Collision-safe because Builder usernames are
    // auto-derived slugs (`{noun}-{verb}-{hash4}`) and no Builder can pick
    // `{something}-coach` by hand — usernames come from the slugifier, not
    // free-form input.
    //
    // Created as a Mattermost BOT (POST /bots, not POST /users) so the MM
    // UI tags it with the BOT badge — the coach IS an agent, not a person,
    // and the badge makes that honest. Mac (the gateway bot) follows the
    // same pattern, see scripts/setup-mattermost.sh. Bots have an underlying
    // user record so PATs, channel/team membership, and avatar upload all
    // work via the same /users/{id}/* endpoints. The bot create response
    // returns `{user_id, ...}` (not `{id, ...}`) — normalized below so
    // downstream code can treat the result like a user object.
    //
    // Display name is "Octo" by default; renamed via Settings or milestone,
    // synced by the workspace-api PATCH /api/agents/me endpoint + the
    // gateway sweep, which both call PUT /bots/{id} with `display_name`.
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
      // Add coach to workspace team (not shared team)
      await mmApiCall("POST", `/teams/${teamId}/members`, {
        team_id: teamId,
        user_id: coachMmUser.id,
      });
      await mmApiCall("POST", `/channels/${channel.id}/members`, { user_id: coachMmUser.id });
      // Coach is a member of general so it can author posts there and
      // surface as Octo in the Members panel.
      if (generalChannelId) {
        await mmApiCall("POST", `/channels/${generalChannelId}/members`, { user_id: coachMmUser.id });
      }
      // Admin channel too (#170) — founder-to-agent guidance.
      if (adminChannelId) {
        await mmApiCall("POST", `/channels/${adminChannelId}/members`, { user_id: coachMmUser.id });
      }
      log(`[mattermost] coach bot created: ${coachUsername} (${coachMmUser.id})`);

      // Mint a PAT for the coach and persist to `users/{uid}/secrets/coachMattermost`.
      // OpenClaw authenticates per-workspace using this token (PR2) so that
      // Octo posts as {slug}-coach rather than the shared octogee-bot.
      // MM-COACH-IDENTITY-SPEC D2 / M1.
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
      "mattermost.proxyUrl": process.env.CHAT_PROXY_URL || "",
      ...(coachMmUserId ? { "mattermost.coachUserId": coachMmUserId } : {}),
      // `_coachPersonalToken` is an EPHEMERAL field threaded through to
      // `wireCoachMattermostAccount` so the provisioner can upsert
      // `channels.mattermost.accounts.{slug}-coach` in openclaw.json at
      // signup time. Without it, the coach's WS never connects and Octo
      // stays silent until the gateway restarts and boot-sync rebuilds
      // the accounts map from Firestore.
      //
      // Underscore prefix is deliberate: `markProvisioningComplete`
      // filters mmUpdate by `mattermost.*` prefix when flattening to
      // `users/{uid}/system/config`, so this key falls out and the token
      // is NOT duplicated into Firestore. The authoritative copy lives
      // at `users/{uid}/secrets/coachMattermost` and boot-sync reads it
      // directly from there.
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
