/**
 * Octogee Provisioner — Mattermost Integration
 */

import { randomBytes } from "crypto";
import * as crypto from "crypto";
import { FieldValue } from "firebase-admin/firestore";
import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import { log } from "./config.js";
import { db } from "./firebase.js";
import {
  workspaceGeneralChannelName,
  workspaceCoachChannelName,
  workspaceAdminChannelName,
  projectGeneralChannelName,
} from "./channelNames.js";

const secretClient = new SecretManagerServiceClient();

// ── Admin Token ─────────────────────────────────────────────────────────────────

let _mmAdminToken: string | null = null;

/**
 * Get an admin session token by logging in with MM_ADMIN_USER/MM_ADMIN_PASS.
 * Caches the token for the lifetime of the process.
 */
export async function getMmAdminToken(): Promise<string | null> {
  if (_mmAdminToken) return _mmAdminToken;

  if (process.env.MM_ADMIN_TOKEN) {
    _mmAdminToken = process.env.MM_ADMIN_TOKEN;
    return _mmAdminToken;
  }

  const MM_URL = process.env.MM_URL;
  const user = process.env.MM_ADMIN_USER;
  const pass = process.env.MM_ADMIN_PASS;
  if (MM_URL && user && pass) {
    try {
      const resp = await fetch(`${MM_URL}/api/v4/users/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ login_id: user, password: pass }),
      });
      if (resp.ok) {
        const token = resp.headers.get("token");
        if (token) {
          _mmAdminToken = token;
          log("[mattermost] Admin session token acquired via login");
          return _mmAdminToken;
        }
      }
      const text = await resp.text().catch(() => "");
      log(`⚠ [mattermost] Admin login failed (${resp.status}): ${text.slice(0, 200)}`);
    } catch (e: any) {
      log(`⚠ [mattermost] Admin login error: ${e.message}`);
    }
  }

  if (process.env.MM_BOT_TOKEN) {
    log("[mattermost] ⚠ Using bot token — some operations (personal access tokens) will fail");
    _mmAdminToken = process.env.MM_BOT_TOKEN;
    return _mmAdminToken;
  }

  return null;
}

// ── API Call ────────────────────────────────────────────────────────────────────

export async function mmApiCall(method: string, endpoint: string, body?: any): Promise<any | null> {
  const MM_URL = process.env.MM_URL;
  const token = await getMmAdminToken();
  if (!MM_URL || !token) return null;

  const resp = await fetch(`${MM_URL}/api/v4${endpoint}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    log(`⚠ [mattermost] API ${resp.status}: ${text.slice(0, 200)}`);
    return null;
  }
  return resp.json();
}

/**
 * Decide which MM user ids become members of each kind of customer channel
 * during provisioning.
 *
 * Post MM-COACH-IDENTITY-SPEC (D4) `octogee-bot` is never a customer-
 * channel member — the coach authenticates with its own PAT from PR2 and
 * the shared bot's only remaining role is global admin-PAT work (team +
 * channel creation), not chat membership. Customer channels get:
 *   - `coach`, `general`, `project` → customer + coach + admin
 *   - `admin`                         → coach + admin (customer NOT invited, #170)
 *
 * Pure function so tests can prove the bot never appears in the result.
 */
export type CustomerChannelKind = "coach" | "general" | "admin" | "project";

export interface CustomerChannelMemberIds {
  customerMmUserId: string | null;
  coachMmUserId: string | null;
  adminMmUserId: string | null;
}

export function customerChannelMembers(
  kind: CustomerChannelKind,
  ids: CustomerChannelMemberIds,
): string[] {
  const nonEmpty = (s: string | null | undefined): s is string =>
    typeof s === "string" && s.length > 0;
  if (kind === "admin") {
    // Admin channel lists the platform operator first by convention (this
    // is the founder-to-agent channel; operator is the canonical actor).
    // Non-admin channels list customer-first. Order is immaterial at the
    // MM /channels/{id}/members call site (which loops and POSTs each
    // member independently), but the tests lock it to prevent drift.
    return [ids.adminMmUserId, ids.coachMmUserId].filter(nonEmpty);
  }
  return [ids.customerMmUserId, ids.coachMmUserId, ids.adminMmUserId].filter(nonEmpty);
}

/**
 * Mint a personal access token for a `{slug}-coach` MM user and persist it
 * to `users/{uid}/secrets/coachMattermost`. Dependency-injected so the
 * provisioner, smoke tests, and unit tests can all feed it the mm caller +
 * Firestore handle they have in hand.
 *
 * Replace-not-append semantics: before minting, list existing tokens on the
 * coach user and revoke any prior "Octogee coach agent (OpenClaw)" PATs.
 * MM's `POST /users/{id}/tokens` has no get-or-create — without this step,
 * every re-provision would leak a stale valid token on the MM user.
 *
 * Failure semantics: any miss (MM throws, MM returns no token, missing
 * coachMmUserId) returns null and writes NOTHING. Callers get a single
 * unambiguous signal — no half-provisioned state. A failed revoke is
 * logged and DOES NOT block the mint, since a new token is strictly
 * safer than an aborted provision.
 *
 * Spec: docs/MM-COACH-IDENTITY-SPEC.md — Decision D2, acceptance M1.
 */
export const COACH_PAT_DESCRIPTION = "Octogee coach agent (OpenClaw)";

export interface CoachPatMintDeps {
  mmApiCall: (method: string, endpoint: string, body?: any) => Promise<any>;
  db: { collection: (name: string) => any };
  now: () => unknown;
  log?: (msg: string) => void;
}

async function revokeStaleCoachTokens(
  deps: CoachPatMintDeps,
  coachMmUserId: string,
): Promise<void> {
  const warn = deps.log ?? (() => {});
  let existing: any;
  try {
    existing = await deps.mmApiCall("GET", `/users/${coachMmUserId}/tokens`);
  } catch (err) {
    warn(
      `[mattermost] ⚠ list coach tokens failed for ${coachMmUserId} — proceeding with mint: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return;
  }
  if (!Array.isArray(existing) || existing.length === 0) return;
  const stale = existing.filter(
    (t: any) => t?.description === COACH_PAT_DESCRIPTION && typeof t?.id === "string",
  );
  for (const t of stale) {
    try {
      await deps.mmApiCall("POST", "/users/tokens/revoke", { token_id: t.id });
    } catch (err) {
      warn(
        `[mattermost] ⚠ revoke stale coach token ${t.id} failed — continuing: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

export async function mintAndPersistCoachToken(
  deps: CoachPatMintDeps,
  uid: string,
  coachMmUserId: string,
): Promise<{ token: string } | null> {
  if (!coachMmUserId) return null;
  // Revoke any prior coach PATs we minted for this user so the MM user
  // carries at most one active "Octogee coach agent (OpenClaw)" token at
  // any time. Non-blocking — a failed revoke is logged but does not
  // prevent the new mint.
  await revokeStaleCoachTokens(deps, coachMmUserId);
  let result: any;
  try {
    result = await deps.mmApiCall("POST", `/users/${coachMmUserId}/tokens`, {
      description: COACH_PAT_DESCRIPTION,
    });
  } catch {
    return null;
  }
  if (!result || typeof result.token !== "string" || !result.token) return null;
  await deps.db
    .collection("users").doc(uid)
    .collection("secrets").doc("coachMattermost")
    .set({
      personalToken: result.token,
      coachMmUserId,
      createdAt: deps.now(),
    });
  return { token: result.token };
}

/**
 * Create or restore a channel. Handles the case where the channel name exists
 * but is archived (MM returns 400 on create, 404 on name lookup).
 */
async function createOrRestoreChannel(
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

// ── Avatar Upload ───────────────────────────────────────────────────────────────

export async function mmUploadAvatar(userId: string, imageUrl: string): Promise<boolean> {
  const MM_URL = process.env.MM_URL;
  const token = await getMmAdminToken();
  if (!MM_URL || !token) return false;

  try {
    const imgResp = await fetch(imageUrl);
    if (!imgResp.ok) return false;
    const buffer = Buffer.from(await imgResp.arrayBuffer());
    const contentType = imgResp.headers.get("content-type") || "image/png";
    const ext = contentType.includes("jpeg") || contentType.includes("jpg") ? ".jpg" : ".png";

    const blob = new Blob([buffer], { type: contentType });
    const form = new FormData();
    form.append("image", blob, `avatar${ext}`);

    const resp = await fetch(`${MM_URL}/api/v4/users/${userId}/image`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      log(`⚠ [mattermost] avatar upload ${resp.status}: ${text.slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (err) {
    log(`⚠ [mattermost] avatar upload failed: ${err}`);
    return false;
  }
}

// ── Provision Mattermost User ───────────────────────────────────────────────────

export async function provisionMattermostUser(
  uid: string, slug: string, firstName: string, email: string,
  workspaceName?: string, lastName?: string, photoURL?: string,
): Promise<Record<string, any>> {
  const MM_BOT_USER_ID = process.env.MM_BOT_USER_ID;
  const MM_ADMIN_USER_ID = process.env.MM_ADMIN_USER_ID;
  const MM_PUBLIC_URL = process.env.MM_PUBLIC_URL || process.env.MM_URL;
  const MM_COMMUNITY_TEAM_ID = process.env.MM_COMMUNITY_TEAM_ID;

  if (!process.env.MM_URL || !process.env.MM_BOT_TOKEN || !MM_BOT_USER_ID) {
    log(`[mattermost] skipping — MM env vars not set`);
    return {};
  }

  const generatePassword = (): string => {
    const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%";
    let pass = "";
    const bytes = randomBytes(24);
    for (let i = 0; i < 24; i++) pass += chars[bytes[i] % chars.length];
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
    // Display name falls back to `{username}'s Workspace` when no explicit
    // workspaceName/firstName is provided (v3 §2 dropped firstName, so most
    // calls now hit the slug fallback). MM defaults to "Office" when display
    // is empty — explicit fallback prevents that.
    const teamName = slug;
    const teamDisplayName =
      workspaceName ||
      (firstName ? `${firstName}'s Workspace` : `${slug}'s Workspace`);
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

    // octogee-bot is NOT added to the customer's team.
    // MM-COACH-IDENTITY-SPEC D4: the shared bot's only role is global
    // admin-PAT work (team + channel creation via system-admin
    // privileges, which don't require team membership). Per-workspace
    // posting flows through {slug}-coach's PAT (PR1 + PR2).

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
      const hash = crypto.createHash("md5").update(email.toLowerCase().trim()).digest("hex");
      const gravatarUrl = `https://gravatar.com/avatar/${hash}?d=identicon&s=200`;
      const ok = await mmUploadAvatar(mmUser.id, gravatarUrl);
      if (ok) log(`[mattermost] avatar uploaded from Gravatar`);
    }

    // Auto-join community channels (legacy — for workspaces using shared team)
    for (const chId of communityChannelIds) {
      await mmApiCall("POST", `/channels/${chId}/members`, {
        user_id: mmUser.id,
      });
    }
    if (communityChannelIds.length > 0) {
      log(`[mattermost] joined ${communityChannelIds.length} community channels`);
    }

    // ── Create channels in workspace team ───────────────────────────────────

    // Octo coach channel — private channel rendered as a DM in the UI
    // (canonical name: {wsSlug}-coach).
    const channelName = workspaceCoachChannelName(slug);
    const channelDisplayName = firstName ? `${firstName}'s Workspace` : `${slug} Workspace`;
    const channel = await createOrRestoreChannel(
      teamId, channelName, channelDisplayName, "P",
      `${firstName || slug}'s Octogee workspace`,
    );
    if (!channel) {
      log(`[mattermost] ⚠ failed to create channel for ${slug}`);
      return {};
    }

    // Coach channel members: customer + (coach later) + admin. Coach is
    // added below once coachMmUser exists. octogee-bot excluded per D4.
    for (const memberId of customerChannelMembers("coach", {
      customerMmUserId: mmUser.id,
      coachMmUserId: null, // added below when coach user is created
      adminMmUserId: MM_ADMIN_USER_ID ?? null,
    })) {
      await mmApiCall("POST", `/channels/${channel.id}/members`, { user_id: memberId });
    }

    // #general channel — workspace lobby, visible to all workspace members.
    // Canonical name: {wsSlug}-general.
    const generalChannelName = workspaceGeneralChannelName(slug);
    const generalDisplayName = `General`;
    const generalChannel = await createOrRestoreChannel(
      teamId, generalChannelName, generalDisplayName, "P",
      `${firstName || slug}'s workspace — general discussion`,
    );
    let generalChannelId: string | null = null;
    if (generalChannel) {
      generalChannelId = generalChannel.id;
      // General channel members: customer + (coach added below) + admin.
      // octogee-bot excluded per D4.
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

    // Admin channel — founder-to-agent guidance, customer NOT invited (#170).
    // Canonical name: {wsSlug}-admin.
    const adminChannelName = workspaceAdminChannelName(slug);
    const adminDisplayName = `Admin — ${firstName || slug}`;
    const adminChannel = await createOrRestoreChannel(
      teamId, adminChannelName, adminDisplayName, "P",
      `Founder-to-agent guidance for ${firstName || slug}. Customer not a member.`,
    );
    let adminChannelId: string | null = null;
    if (adminChannel) {
      adminChannelId = adminChannel.id;
      // Admin channel members: admin + coach. Customer NOT invited (#170).
      // octogee-bot excluded per D4. Coach added below when the user exists.
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

    // Create per-customer coach MM user. Handle = `{username}-coach` — hyphen
    // matches the platform-wide identifier convention (octogee-bot,
    // {slug}-general, etc.). Collision-safe because Builder usernames are
    // auto-derived slugs (`{noun}-{verb}-{hash4}`) and no Builder can pick
    // `{something}-coach` by hand — usernames come from the slugifier, not
    // free-form input. Display (first_name + nickname) is "Octo" by default;
    // user renames via Settings or milestone, sync'd by the workspace-api
    // PATCH /api/agents/me endpoint + the gateway sweep.
    const coachUsername = `${slug}-coach`;
    let coachMmUser = await mmApiCall("POST", "/users", {
      email: `coach-${slug}@octogee.local`,
      username: coachUsername,
      password: generatePassword(),
      first_name: "Octo",
      last_name: "",
      nickname: "Octo",
    });
    if (!coachMmUser) {
      coachMmUser = await mmApiCall("GET", `/users/username/${coachUsername}`);
      if (coachMmUser) log(`[mattermost] coach user ${coachUsername} already exists, reusing`);
    }

    let coachMmUserId: string | null = null;
    if (coachMmUser) {
      coachMmUserId = coachMmUser.id;
      // Add coach to workspace team (not shared team)
      await mmApiCall("POST", `/teams/${teamId}/members`, {
        team_id: teamId,
        user_id: coachMmUser.id,
      });
      await mmApiCall("POST", `/channels/${channel.id}/members`, { user_id: coachMmUser.id });
      // Coach is a member of general so it can author posts there and
      // surface as the canonical Octo in the Members panel (MM-COACH-IDENTITY
      // D4 + M5). Under PR3 the shared octogee-bot is out of customer
      // channels; the coach is the only bot-style identity the user sees.
      if (generalChannelId) {
        await mmApiCall("POST", `/channels/${generalChannelId}/members`, { user_id: coachMmUser.id });
      }
      // Admin channel too (#170) — founder-to-agent guidance.
      if (adminChannelId) {
        await mmApiCall("POST", `/channels/${adminChannelId}/members`, { user_id: coachMmUser.id });
      }
      log(`[mattermost] coach user created: ${coachUsername} (${coachMmUser.id})`);

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
        log(`[mattermost] coach PAT minted and persisted for ${coachUsername}`);
      } else {
        log(`[mattermost] ⚠ coach PAT creation failed — coach identity will fall back to octogee-bot until re-provisioned`);
      }
    } else {
      log(`[mattermost] ⚠ failed to create coach user ${coachUsername} — coach identity will use defaults`);
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
      ...(adminChannelId ? { "mattermost.adminChannelId": adminChannelId } : {}),
    };
  } catch (e: any) {
    log(`[mattermost] ⚠ provisioning failed: ${e.message} — continuing without chat`);
    return {};
  }
}

// ── Project Channel ─────────────────────────────────────────────────────────

/** Create a private Mattermost channel for a project. Returns channel ID or null. */
export async function createProjectChannel(
  teamId: string,         // workspace team ID (Phase 4: team-per-workspace)
  slug: string,
  projectSlug: string,
  customerMmUserId: string,
  projectName: string,
): Promise<string | null> {
  const MM_BOT_USER_ID = process.env.MM_BOT_USER_ID;
  const MM_ADMIN_USER_ID = process.env.MM_ADMIN_USER_ID;

  const effectiveTeamId = teamId;
  if (!process.env.MM_URL || !effectiveTeamId || !MM_BOT_USER_ID) {
    log(`[mattermost] skipping project channel — MM env vars not set`);
    return null;
  }

  // Canonical name: {wsSlug}-proj-{projSlug}-general.
  const channelName = projectGeneralChannelName(slug, projectSlug);

  let channel = await mmApiCall("POST", "/channels", {
    team_id: effectiveTeamId,
    name: channelName,
    display_name: projectName,
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
  // next provisioner sweep). octogee-bot excluded per MM-COACH-IDENTITY D4.
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


// ── Community Channels ──────────────────────────────────────────────────────────

export const COMMUNITY_CHANNELS = [
  { name: "community-general",       displayName: "General",       purpose: "Chat with the Octogee community" },
  { name: "community-introductions", displayName: "Introductions", purpose: "Introduce yourself and your project" },
  { name: "community-help",          displayName: "Help",          purpose: "Ask questions, get help from the community" },
];

export let communityChannelIds: string[] = [];

export async function ensureCommunityChannels(): Promise<void> {
  const communityTeamId = process.env.MM_COMMUNITY_TEAM_ID;
  if (!process.env.MM_URL || !communityTeamId) {
    log("[community] skipping — MM env vars not set");
    return;
  }

  const token = await getMmAdminToken();
  if (!token) {
    log("[community] skipping — no admin token");
    return;
  }

  communityChannelIds = [];

  for (const def of COMMUNITY_CHANNELS) {
    let channel = await mmApiCall("GET", `/teams/${communityTeamId}/channels/name/${def.name}`);
    if (channel) {
      communityChannelIds.push(channel.id);
      continue;
    }

    channel = await mmApiCall("POST", "/channels", {
      team_id: communityTeamId,
      name: def.name,
      display_name: def.displayName,
      type: "O",
      purpose: def.purpose,
    });

    if (channel) {
      communityChannelIds.push(channel.id);
      log(`[community] created #${def.name} (${channel.id})`);
    } else {
      log(`[community] ⚠ failed to create #${def.name}`);
    }
  }

  log(`[community] ${communityChannelIds.length}/${COMMUNITY_CHANNELS.length} channels ready (team: ${communityTeamId})`);
}

// ── Admin Credentials ────────────────────────────────────────────────────────────

/**
 * Ensure admin Mattermost credentials are stored in Firestore.
 * Called on provisioner startup. Writes to system/mattermostAdmin doc
 * so the adminMattermostToken CF can generate tickets for the admin user.
 */
export async function ensureAdminCredentials(): Promise<void> {
  const MM_URL = process.env.MM_URL;
  if (!MM_URL) {
    log("[admin-creds] skipping — MM_URL not set");
    return;
  }

  const token = await getMmAdminToken();
  if (!token) {
    log("[admin-creds] skipping — no admin token");
    return;
  }

  // Get admin user ID from env or look up by username
  let adminUserId = process.env.MM_ADMIN_USER_ID;
  if (!adminUserId) {
    const adminUser = process.env.MM_ADMIN_USER;
    if (adminUser) {
      const user = await mmApiCall("GET", `/users/username/${adminUser}`);
      if (user?.id) {
        adminUserId = user.id;
        log(`[admin-creds] looked up admin user ID: ${adminUserId}`);
      }
    }
  }

  if (!adminUserId) {
    log("[admin-creds] skipping — could not determine admin user ID (set MM_ADMIN_USER_ID or MM_ADMIN_USER)");
    return;
  }

  const proxyUrl = process.env.CHAT_PROXY_URL || "";

  // Write token to Secret Manager (not Firestore — it's a credential)
  const project = process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID || "octogee";
  const secretName = `projects/${project}/secrets/MM_ADMIN_TOKEN`;
  try {
    await secretClient.addSecretVersion({
      parent: secretName,
      payload: { data: Buffer.from(token) },
    });
    log(`[admin-creds] MM_ADMIN_TOKEN written to Secret Manager`);
  } catch (err: any) {
    if (err?.code === 5) {
      // Secret doesn't exist yet — create it
      await secretClient.createSecret({
        parent: `projects/${project}`,
        secretId: "MM_ADMIN_TOKEN",
        secret: { replication: { automatic: {} } },
      });
      await secretClient.addSecretVersion({
        parent: secretName,
        payload: { data: Buffer.from(token) },
      });
      log(`[admin-creds] MM_ADMIN_TOKEN created in Secret Manager`);
    } else {
      log(`[admin-creds] ⚠ failed to write MM_ADMIN_TOKEN to Secret Manager: ${err?.message}`);
    }
  }

  // Write non-sensitive metadata to Firestore (userId, proxyUrl — no token)
  await db.doc("system/mattermostAdmin").set({
    userId: adminUserId,
    proxyUrl,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  log(`[admin-creds] stored admin credentials for user ${adminUserId}`);
}

// ── Profile Sync ────────────────────────────────────────────────────────────────

export async function syncProfileToMattermost(uid: string, data: any): Promise<void> {
  const mmUserId = data.mattermost?.userId;
  if (!mmUserId || !process.env.MM_URL) return;

  const slug = data.username;

  const patch: Record<string, string> = {};
  if (data.firstName) patch.first_name = data.firstName;
  if (data.lastName !== undefined) patch.last_name = data.lastName || "";
  if (Object.keys(patch).length > 0) {
    const result = await mmApiCall("PUT", `/users/${mmUserId}/patch`, patch);
    if (result) log(`[profile-sync] ${slug}: updated MM user name → ${data.firstName} ${data.lastName || ""}`);
  }

  if (data._profileSync?.photoURL && data.photoURL) {
    const ok = await mmUploadAvatar(mmUserId, data.photoURL);
    if (ok) log(`[profile-sync] ${slug}: updated MM avatar`);
  }

  await db.doc(`users/${uid}`).update({ "_profileSync": FieldValue.delete() });
}

// ── Coach Profile Sync ───────────────────────────────────────────────────────

export async function syncCoachProfileToMattermost(
  slug: string,
  coachMmUserId: string,
  coachName: string
): Promise<void> {
  if (!process.env.MM_URL || !coachMmUserId || !coachName) return;

  const patch = { first_name: coachName, nickname: coachName };
  const result = await mmApiCall("PUT", `/users/${coachMmUserId}/patch`, patch);
  if (result) {
    log(`[coach-sync] ${slug}: updated coach display name → ${coachName}`);
  } else {
    log(`[coach-sync] ${slug}: ⚠ failed to update coach display name`);
  }
}

// ── Nuke Helpers ─────────────────────────────────────────────────────────────

/**
 * Permanently delete a Mattermost user (not deactivate — full delete).
 * Uses the MM admin API: DELETE /users/{userId}
 * Idempotent: 404 is treated as success.
 */
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
