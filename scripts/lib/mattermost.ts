/**
 * Octogee Provisioner — Mattermost Integration
 */

import { randomBytes } from "crypto";
import * as crypto from "crypto";
import { FieldValue } from "firebase-admin/firestore";
import { log } from "./config.js";
import { db } from "./firebase.js";

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
  const MM_TEAM_ID = process.env.MM_TEAM_ID;
  const MM_BOT_USER_ID = process.env.MM_BOT_USER_ID;
  const MM_ADMIN_USER_ID = process.env.MM_ADMIN_USER_ID;
  const MM_PUBLIC_URL = process.env.MM_PUBLIC_URL || process.env.MM_URL;

  if (!process.env.MM_URL || !process.env.MM_BOT_TOKEN || !MM_TEAM_ID || !MM_BOT_USER_ID) {
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

    // Add to team
    await mmApiCall("POST", `/teams/${MM_TEAM_ID}/members`, {
      team_id: MM_TEAM_ID,
      user_id: mmUser.id,
    });

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

    // Auto-join community channels
    for (const chId of communityChannelIds) {
      await mmApiCall("POST", `/channels/${chId}/members`, {
        user_id: mmUser.id,
      });
    }
    if (communityChannelIds.length > 0) {
      log(`[mattermost] joined ${communityChannelIds.length} community channels`);
    }

    // Create private channel for customer
    const channelName = `octogee-${slug}`;
    let channel = await mmApiCall("POST", "/channels", {
      team_id: MM_TEAM_ID,
      name: channelName,
      display_name: "Octogee",
      type: "P",
      purpose: `${firstName || slug}'s Octogee workspace`,
    });
    if (!channel) {
      channel = await mmApiCall("GET", `/teams/${MM_TEAM_ID}/channels/name/${channelName}`);
    }
    if (!channel) {
      log(`[mattermost] ⚠ failed to create channel for ${slug}`);
      return {};
    }

    // Add bot, customer, and admin to the channel
    await mmApiCall("POST", `/channels/${channel.id}/members`, { user_id: MM_BOT_USER_ID });
    await mmApiCall("POST", `/channels/${channel.id}/members`, { user_id: mmUser.id });
    if (MM_ADMIN_USER_ID) {
      await mmApiCall("POST", `/channels/${channel.id}/members`, { user_id: MM_ADMIN_USER_ID });
      log(`[mattermost] admin added to channel ${channelName}`);
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
    });
    if (!coachMmUser) {
      coachMmUser = await mmApiCall("GET", `/users/username/${coachUsername}`);
      if (coachMmUser) log(`[mattermost] coach user ${coachUsername} already exists, reusing`);
    }

    let coachMmUserId: string | null = null;
    if (coachMmUser) {
      coachMmUserId = coachMmUser.id;
      await mmApiCall("POST", `/teams/${MM_TEAM_ID}/members`, {
        team_id: MM_TEAM_ID,
        user_id: coachMmUser.id,
      });
      await mmApiCall("POST", `/channels/${channel.id}/members`, { user_id: coachMmUser.id });
      log(`[mattermost] coach user created: ${coachUsername} (${coachMmUser.id})`);
    } else {
      log(`[mattermost] ⚠ failed to create coach user ${coachUsername} — coach identity will use defaults`);
    }

    return {
      "mattermost.userId": mmUser.id,
      "mattermost.username": username,
      "mattermost.channelId": channel.id,
      "mattermost.channelName": channelName,
      "mattermost.dmChannelId": channel.id,
      "mattermost.proxyUrl": process.env.CHAT_PROXY_URL || "",
      ...(coachMmUserId ? { "mattermost.coachUserId": coachMmUserId } : {}),
    };
  } catch (e: any) {
    log(`[mattermost] ⚠ provisioning failed: ${e.message} — continuing without chat`);
    return {};
  }
}

// ── Project Channel ─────────────────────────────────────────────────────────

/** Create a private Mattermost channel for a project. Returns channel ID or null. */
export async function createProjectChannel(
  slug: string,
  projectSlug: string,
  customerMmUserId: string,
  projectName: string,
): Promise<string | null> {
  const MM_TEAM_ID = process.env.MM_TEAM_ID;
  const MM_BOT_USER_ID = process.env.MM_BOT_USER_ID;
  const MM_ADMIN_USER_ID = process.env.MM_ADMIN_USER_ID;

  if (!process.env.MM_URL || !MM_TEAM_ID || !MM_BOT_USER_ID) {
    log(`[mattermost] skipping project channel — MM env vars not set`);
    return null;
  }

  const channelName = `proj-${slug}-${projectSlug}`;

  let channel = await mmApiCall("POST", "/channels", {
    team_id: MM_TEAM_ID,
    name: channelName,
    display_name: projectName,
    type: "P",
    purpose: `Project channel for ${projectName}`,
  });

  if (!channel) {
    channel = await mmApiCall("GET", `/teams/${MM_TEAM_ID}/channels/name/${channelName}`);
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

// ── Channel Invites ─────────────────────────────────────────────────────────────

export async function processInvite(inviteId: string, data: any): Promise<void> {
  const { channelId, inviteeMmUserId, inviteeEmail, inviteeFirstName } = data;

  if (!channelId || !inviteeMmUserId) {
    log(`[invite] ⚠ invite ${inviteId} missing channelId or inviteeMmUserId`);
    await db.doc(`invites/${inviteId}`).update({
      status: "failed",
      error: "Missing channel or user info",
      updatedAt: FieldValue.serverTimestamp(),
    });
    return;
  }

  try {
    const result = await mmApiCall("POST", `/channels/${channelId}/members`, {
      user_id: inviteeMmUserId,
    });

    if (result) {
      log(`[invite] ✅ added ${inviteeFirstName || inviteeEmail} to channel ${channelId}`);
      await db.doc(`invites/${inviteId}`).update({
        status: "completed",
        updatedAt: FieldValue.serverTimestamp(),
      });
    } else {
      const members = await mmApiCall("GET", `/channels/${channelId}/members`);
      const alreadyMember = Array.isArray(members) && members.some((m: any) => m.user_id === inviteeMmUserId);

      if (alreadyMember) {
        log(`[invite] ${inviteeFirstName || inviteeEmail} already in channel ${channelId}`);
        await db.doc(`invites/${inviteId}`).update({
          status: "completed",
          updatedAt: FieldValue.serverTimestamp(),
        });
      } else {
        throw new Error("MM API returned null — add member failed");
      }
    }
  } catch (err: any) {
    log(`[invite] ⚠ failed to add ${inviteeEmail} to channel: ${err.message}`);
    await db.doc(`invites/${inviteId}`).update({
      status: "failed",
      error: err.message || "Failed to add user to channel",
      updatedAt: FieldValue.serverTimestamp(),
    });
  }
}

// ── Community Channels ──────────────────────────────────────────────────────────

export const COMMUNITY_CHANNELS = [
  { name: "community-general",       displayName: "General",       purpose: "Chat with the Octogee community" },
  { name: "community-introductions", displayName: "Introductions", purpose: "Introduce yourself and your project" },
  { name: "community-help",          displayName: "Help",          purpose: "Ask questions, get help from the community" },
];

export let communityChannelIds: string[] = [];

export async function ensureCommunityChannels(): Promise<void> {
  const MM_TEAM_ID = process.env.MM_TEAM_ID;
  if (!process.env.MM_URL || !MM_TEAM_ID) {
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
    let channel = await mmApiCall("GET", `/teams/${MM_TEAM_ID}/channels/name/${def.name}`);
    if (channel) {
      communityChannelIds.push(channel.id);
      continue;
    }

    channel = await mmApiCall("POST", "/channels", {
      team_id: MM_TEAM_ID,
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

  log(`[community] ${communityChannelIds.length}/${COMMUNITY_CHANNELS.length} channels ready`);
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

  await db.doc("system/mattermostAdmin").set({
    userId: adminUserId,
    personalToken: token,
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
