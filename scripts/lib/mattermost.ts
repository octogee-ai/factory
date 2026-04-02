/**
 * Octogee Provisioner — Mattermost Integration
 */

import { randomBytes } from "crypto";
import * as crypto from "crypto";
import { FieldValue } from "firebase-admin/firestore";
import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import { log } from "./config.js";
import { db } from "./firebase.js";

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
  const MM_TEAM_ID = process.env.MM_TEAM_ID; // fallback for migration
  const MM_BOT_USER_ID = process.env.MM_BOT_USER_ID;
  const MM_ADMIN_USER_ID = process.env.MM_ADMIN_USER_ID;
  const MM_PUBLIC_URL = process.env.MM_PUBLIC_URL || process.env.MM_URL;
  const MM_COMMUNITY_TEAM_ID = process.env.MM_COMMUNITY_TEAM_ID;

  if (!process.env.MM_URL || !process.env.MM_BOT_TOKEN || !MM_BOT_USER_ID) {
    log(`[mattermost] skipping — MM env vars not set`);
    return {};
  }
  if (!MM_TEAM_ID) {
    log(`[mattermost] ⚠ MM_TEAM_ID not set — will create workspace team only (no fallback)`);
  }

  const generatePassword = (): string => {
    const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%";
    let pass = "";
    const bytes = randomBytes(24);
    for (let i = 0; i < 24; i++) pass += chars[bytes[i] % chars.length];
    return pass;
  };

  try {
    // Check if already provisioned
    const existingUserDoc = await db.collection("users").doc(uid).get();
    const existingData = existingUserDoc.data() || {};
    const existingChannelId = existingData.mattermost?.channelId || existingData.mattermost?.dmChannelId;
    if (existingData.mattermost?.userId && existingChannelId) {
      log(`[mattermost] user already provisioned (userId=${existingData.mattermost.userId}) — skipping MM creation`);
      return {
        "mattermost.userId": existingData.mattermost.userId,
        "mattermost.username": existingData.mattermost.username || slug,
        "mattermost.channelId": existingChannelId,
        "mattermost.dmChannelId": existingChannelId,
        "mattermost.proxyUrl": existingData.mattermost.proxyUrl || process.env.CHAT_PROXY_URL || "",
      };
    }

    // Create Mattermost user
    const username = slug.replace(/[^a-z0-9-]/g, "").slice(0, 22);
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
    const teamName = `ws-${slug}`;
    const teamDisplayName = workspaceName || `${firstName}'s Workspace`;
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
    } else if (MM_TEAM_ID) {
      // Graceful degradation: fall back to shared team
      teamId = MM_TEAM_ID;
      log(`[mattermost] ⚠ failed to create workspace team ${teamName} — falling back to shared team`);
    } else {
      log(`[mattermost] ⚠ failed to create workspace team ${teamName} and no MM_TEAM_ID fallback`);
      return {};
    }

    if (!teamId) return {};  // TS narrowing — unreachable after fallback above

    // Add user as team_admin of workspace team
    // Note: team_id is required in body for Team Edition (not just the URL)
    await mmApiCall("POST", `/teams/${teamId}/members`, {
      team_id: teamId,
      user_id: mmUser.id,
      roles: "team_admin team_user",
    });

    // Add Octo bot to workspace team
    await mmApiCall("POST", `/teams/${teamId}/members`, {
      team_id: teamId,
      user_id: MM_BOT_USER_ID,
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
    const communityTeamId = MM_COMMUNITY_TEAM_ID || MM_TEAM_ID;
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

    // Octo DM channel (private channel rendered as DM in the UI)
    const channelName = `octogee-${slug}`;
    const channelDisplayName = firstName ? `${firstName}'s Workspace` : `${slug} Workspace`;
    const channel = await createOrRestoreChannel(
      teamId, channelName, channelDisplayName, "P",
      `${firstName || slug}'s Octogee workspace`,
    );
    if (!channel) {
      log(`[mattermost] ⚠ failed to create channel for ${slug}`);
      return {};
    }

    // Add bot, customer, and admin to the Octo DM channel
    await mmApiCall("POST", `/channels/${channel.id}/members`, { user_id: MM_BOT_USER_ID });
    await mmApiCall("POST", `/channels/${channel.id}/members`, { user_id: mmUser.id });
    if (MM_ADMIN_USER_ID) {
      await mmApiCall("POST", `/channels/${channel.id}/members`, { user_id: MM_ADMIN_USER_ID });
      log(`[mattermost] admin added to channel ${channelName}`);
    }

    // #general channel — workspace lobby, visible to all workspace members
    // Prefixed with octogee- so admin sidebar groups it under the customer slug.
    const generalChannelName = `octogee-${slug}-general`;
    const generalDisplayName = `General`;
    const generalChannel = await createOrRestoreChannel(
      teamId, generalChannelName, generalDisplayName, "P",
      `${firstName || slug}'s workspace — general discussion`,
    );
    let generalChannelId: string | null = null;
    if (generalChannel) {
      generalChannelId = generalChannel.id;
      await mmApiCall("POST", `/channels/${generalChannel.id}/members`, { user_id: MM_BOT_USER_ID });
      await mmApiCall("POST", `/channels/${generalChannel.id}/members`, { user_id: mmUser.id });
      if (MM_ADMIN_USER_ID) {
        await mmApiCall("POST", `/channels/${generalChannel.id}/members`, { user_id: MM_ADMIN_USER_ID });
      }
      log(`[mattermost] general channel created: #${generalChannelName} (${generalChannel.id})`);
    } else {
      log(`[mattermost] ⚠ failed to create general channel for ${slug} — non-fatal`);
    }

    // Admin channel — founder-to-agent guidance, customer NOT invited (#170)
    const adminChannelName = `octogee-${slug}-admin`;
    const adminDisplayName = `Admin — ${firstName || slug}`;
    const adminChannel = await createOrRestoreChannel(
      teamId, adminChannelName, adminDisplayName, "P",
      `Founder-to-agent guidance for ${firstName || slug}. Customer not a member.`,
    );
    let adminChannelId: string | null = null;
    if (adminChannel) {
      adminChannelId = adminChannel.id;
      // Add bot + admin — NOT the customer
      await mmApiCall("POST", `/channels/${adminChannel.id}/members`, { user_id: MM_BOT_USER_ID });
      if (MM_ADMIN_USER_ID) {
        await mmApiCall("POST", `/channels/${adminChannel.id}/members`, { user_id: MM_ADMIN_USER_ID });
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

    // Create per-customer coach MM user
    const coachUsername = `octogee-${slug}-coach`;
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
      // Add coach bot to admin channel too (#170)
      if (adminChannelId) {
        await mmApiCall("POST", `/channels/${adminChannelId}/members`, { user_id: coachMmUser.id });
      }
      log(`[mattermost] coach user created: ${coachUsername} (${coachMmUser.id})`);
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
  const MM_TEAM_ID = process.env.MM_TEAM_ID;
  const MM_BOT_USER_ID = process.env.MM_BOT_USER_ID;
  const MM_ADMIN_USER_ID = process.env.MM_ADMIN_USER_ID;

  // Use provided teamId, fall back to MM_TEAM_ID for legacy workspaces
  const effectiveTeamId = teamId || MM_TEAM_ID;
  if (!process.env.MM_URL || !effectiveTeamId || !MM_BOT_USER_ID) {
    log(`[mattermost] skipping project channel — MM env vars not set`);
    return null;
  }

  const channelName = `proj-${slug}-${projectSlug}`;

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

  // Add bot, customer, and admin
  await mmApiCall("POST", `/channels/${channel.id}/members`, { user_id: MM_BOT_USER_ID });
  await mmApiCall("POST", `/channels/${channel.id}/members`, { user_id: customerMmUserId });
  if (MM_ADMIN_USER_ID) {
    await mmApiCall("POST", `/channels/${channel.id}/members`, { user_id: MM_ADMIN_USER_ID });
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
  // Use MM_COMMUNITY_TEAM_ID (Phase 4), fall back to MM_TEAM_ID for migration
  const communityTeamId = process.env.MM_COMMUNITY_TEAM_ID || process.env.MM_TEAM_ID;
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

  const slug = data.businessSlug;

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
