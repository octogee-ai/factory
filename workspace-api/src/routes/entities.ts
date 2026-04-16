/**
 * Entity membership — unified members endpoints for workspaces and projects.
 *
 * GET    /api/entities/:kind/:id/members
 * DELETE /api/entities/:kind/:id/members/:mmUserId
 *
 *   kind: 'workspace' | 'project'
 *   id:
 *     - workspace: workspace slug (e.g. "grand-raven")
 *     - project:   Firestore project doc id (e.g. "grand-raven_sprint-1")
 *
 * Membership source of truth is Mattermost — if you're in the MM channel,
 * you're a member of the entity, full stop. GET uses the caller's own MM
 * token (not the admin token) so MM enforces the usual "you can only see
 * channels you belong to" rule natively; non-members get a 403 from MM
 * which we surface as-is. No separate permission layer.
 *
 * DELETE is owner-only and keyed by MM user ID (not Firestore UID) so
 * owners can evict users who haven't finished provisioning their
 * Firestore profile yet — the mid-provisioning edge case that was
 * blocked in MembershipSection before this endpoint existed.
 *
 * The GET response hydrates each MM user with Firestore profile data
 * (avatar, displayName) via a reverse lookup on `mattermost.userId`.
 * If a MM user has no Firestore profile yet, the MM first_name /
 * username is used as fallback.
 *
 * TODO (tracked in PR #462 review): hydration is currently N+1 — one
 * Firestore read per member for the avatarUrl. Move avatarUrl onto the
 * main users/{uid} doc or batch via chunked `in` queries once channels
 * routinely exceed ~20 members.
 *
 * TODO (tracked in PR #462 review): /channels/{id}/members is paged by
 * MM (default 60, max 200) and /users/ids is capped at 100 per call.
 * Loop per_page=200 until empty once channels exceed that cap.
 */
import { Router, Request, Response } from "express";
import { requireAuth } from "../middleware/auth";
import { db, FieldValue } from "../lib/db";
import { mmApi } from "../lib/mattermost";
import { resolveWorkspaceUid } from "../lib/workspace-resolution";
import { decomposeProjectId } from "../lib/projectId";
import { logger } from "../middleware/logging";
import { workspaceGeneralChannelName } from "../../../shared/types/identity";
import { getWorkspaceMmContext } from "../lib/mattermost-context";

const router = Router();
router.use(requireAuth);

type EntityKind = "workspace" | "project";

interface MemberResponse {
  /** Firebase UID — null when we can't reverse-lookup from MM to Firestore. */
  uid: string | null;
  mmUserId: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  role: "owner" | "member";
}

interface MmChannelMember {
  user_id: string;
  channel_id: string;
  roles: string;
}

interface MmUser {
  id: string;
  username: string;
  first_name: string;
  last_name: string;
}

/** Read the caller's MM personal access token from Firestore. */
async function getCallerMmToken(uid: string): Promise<string | null> {
  const secretDoc = await db.doc(`users/${uid}/secrets/mattermost`).get();
  const token = secretDoc.data()?.personalToken;
  return typeof token === "string" && token.length > 0 ? token : null;
}

/**
 * Resolve the canonical MM channel ID for an entity.
 *
 * Workspace: `{slug}-general` (looked up via owner's stored generalChannelId,
 *            with a name-based fallback if not stored).
 * Project:   `workspaces/{wid}/projects/{pid}/channels/general.mattermost.channelId`
 *            per v3 §6.3; caller-supplied `id` is `{wid}_{pid}`.
 */
async function resolveEntityChannel(
  kind: EntityKind,
  id: string,
  callerToken: string,
): Promise<{ mmChannelId: string | null; ownerUid: string | null; error?: string }> {
  if (kind === "workspace") {
    const ownerUid = await resolveWorkspaceUid(id);
    if (!ownerUid) return { mmChannelId: null, ownerUid: null, error: "Workspace not found" };

    const ownerCtx = await getWorkspaceMmContext(ownerUid, id);
    const storedChannelId = ownerCtx?.generalChannelId;
    if (storedChannelId) return { mmChannelId: storedChannelId, ownerUid };

    // Fallback: search the owner's team channels for the canonical
    // {wsSlug}-general name. The legacy octogee- prefix was removed by the
    // channel-naming-lockdown — only the canonical shape is recognized now.
    const teamId = ownerCtx?.teamId;
    if (!teamId) return { mmChannelId: null, ownerUid, error: "Workspace not yet provisioned" };
    try {
      const expected = workspaceGeneralChannelName(id);
      const channels = (await mmApi(
        `/teams/${teamId}/channels`,
        "GET",
        undefined,
        callerToken,
      )) as Array<{ id: string; name: string }>;
      const general = channels.find((ch) => ch.name === expected);
      return { mmChannelId: general?.id ?? null, ownerUid };
    } catch (err) {
      logger.warn(`[entities] workspace channel lookup failed for ${id}`, { err: String(err) });
      return { mmChannelId: null, ownerUid };
    }
  }

  // project kind — id is `{workspaceId}_{projectSlug}`
  const parts = decomposeProjectId(id);
  if (!parts) return { mmChannelId: null, ownerUid: null, error: "Invalid project id" };

  const projectRef = db.doc(`workspaces/${parts.wid}/projects/${parts.pid}`);
  const projectDoc = await projectRef.get();
  if (!projectDoc.exists) {
    return { mmChannelId: null, ownerUid: null, error: "Project not found" };
  }
  const project = projectDoc.data()!;
  const channelDoc = await projectRef.collection("channels").doc("general").get();
  const mmChannelId = channelDoc.data()?.mattermost?.channelId ?? null;
  return {
    mmChannelId,
    ownerUid: project.ownerUid ?? null,
  };
}

/**
 * Reverse-lookup Firestore users by their MM user IDs. Returns a map keyed
 * by MM user ID. Uses `in` queries in chunks of 30 (admin SDK limit).
 */
async function hydrateFromFirestore(
  mmUserIds: string[],
): Promise<Map<string, { uid: string; avatarUrl: string | null; displayName: string | null }>> {
  const byMmId = new Map<string, { uid: string; avatarUrl: string | null; displayName: string | null }>();
  if (mmUserIds.length === 0) return byMmId;

  const chunkSize = 30;
  const userChunks: Array<Array<{ uid: string; data: FirebaseFirestore.DocumentData }>> = [];
  for (let i = 0; i < mmUserIds.length; i += chunkSize) {
    const chunk = mmUserIds.slice(i, i + chunkSize);
    const snap = await db
      .collection("users")
      .where("mattermost.userId", "in", chunk)
      .get();
    userChunks.push(snap.docs.map((doc) => ({ uid: doc.id, data: doc.data() })));
  }

  // Collect { uid, mmId, displayName } entries, then batch-fetch avatars.
  const baseEntries = userChunks.flat().flatMap((u) => {
    const mmId = u.data?.mattermost?.userId;
    if (!mmId) return [];
    return [{
      mmId,
      uid: u.uid,
      displayName: u.data?.firstName ?? u.data?.displayName ?? null,
    }];
  });

  // Fetch each avatar from users/{uid}/profile/public in parallel.
  await Promise.all(
    baseEntries.map(async (entry) => {
      const publicDoc = await db.doc(`users/${entry.uid}/profile/public`).get();
      byMmId.set(entry.mmId, {
        uid: entry.uid,
        displayName: entry.displayName,
        avatarUrl: publicDoc.data()?.avatarUrl ?? null,
      });
    }),
  );

  return byMmId;
}

// ── GET /:kind/:id/members ──────────────────────────────────────────────────

router.get("/:kind/:id/members", async (req: Request, res: Response) => {
  const uid = req.uid!;
  const { kind, id } = req.params;

  if (kind !== "workspace" && kind !== "project") {
    res.status(400).json({ error: "kind must be 'workspace' or 'project'" });
    return;
  }

  try {
    const callerToken = await getCallerMmToken(uid);
    if (!callerToken) {
      res.status(422).json({ error: "Your account is not yet provisioned for chat" });
      return;
    }

    const { mmChannelId, ownerUid, error } = await resolveEntityChannel(
      kind as EntityKind,
      id,
      callerToken,
    );
    if (error) {
      const status = error.includes("not found") ? 404 : 422;
      res.status(status).json({ error });
      return;
    }
    if (!mmChannelId) {
      res.status(422).json({ error: "Entity has no provisioned chat channel yet" });
      return;
    }

    // Resolve owner's MM user ID so we can flag the owner in the response.
    let ownerMmUserId: string | null = null;
    if (ownerUid) {
      const od = await db.doc(`users/${ownerUid}`).get();
      ownerMmUserId = od.data()?.mattermost?.userId ?? null;
    }

    // Fetch channel members via MM with the CALLER's token. MM enforces
    // channel membership natively — a non-member caller gets 403 from MM
    // which propagates up as an error, which we surface as 403.
    let mmMembers: MmChannelMember[] = [];
    try {
      mmMembers = (await mmApi(
        `/channels/${mmChannelId}/members`,
        "GET",
        undefined,
        callerToken,
      )) as MmChannelMember[];
    } catch (err: any) {
      const msg = err?.message || "";
      if (msg.includes("403") || msg.includes("401")) {
        res.status(403).json({ error: "You are not a member of this channel" });
        return;
      }
      throw err;
    }

    if (mmMembers.length === 0) {
      res.json({ members: [] });
      return;
    }

    // Hydrate with MM user profiles (bulk).
    const mmUserIds = mmMembers.map((m) => m.user_id);
    const mmUsers = (await mmApi(
      `/users/ids`,
      "POST",
      mmUserIds,
      callerToken,
    )) as MmUser[];
    const mmUsersById = new Map(mmUsers.map((u) => [u.id, u]));

    // Hydrate with Firestore profile data (best-effort).
    const firestoreByMmId = await hydrateFromFirestore(mmUserIds);

    const members: MemberResponse[] = mmMembers.map((m) => {
      const mmUser = mmUsersById.get(m.user_id);
      const fs = firestoreByMmId.get(m.user_id);
      const displayName =
        fs?.displayName ||
        mmUser?.first_name ||
        mmUser?.username ||
        "Unknown";
      return {
        uid: fs?.uid ?? null,
        mmUserId: m.user_id,
        username: mmUser?.username ?? m.user_id,
        displayName,
        avatarUrl: fs?.avatarUrl ?? null,
        role: m.user_id === ownerMmUserId ? "owner" : "member",
      };
    });

    // Owner first, then alphabetical by displayName.
    members.sort((a, b) => {
      if (a.role === "owner" && b.role !== "owner") return -1;
      if (a.role !== "owner" && b.role === "owner") return 1;
      return a.displayName.localeCompare(b.displayName);
    });

    res.json({ members });
  } catch (err: any) {
    logger.error(`[entities] Members fetch failed (${kind}/${id})`, { err: String(err) });
    res.status(500).json({ error: "Failed to load members" });
  }
});

// ── DELETE /:kind/:id/members/:mmUserId ─────────────────────────────────────
//
// Owner-only. Keyed by MM user ID, not Firestore UID, so owners can evict
// users who are mid-provisioning and don't have a Firestore profile yet
// (the reason this endpoint exists at all — see PR #462 review #8).
//
// Workspace mode: removes the target from the {slug}-general channel only.
//                 MM team membership and project channels are preserved.
// Project mode:   removes from the project channel and, if we can map the
//                 MM user back to a Firestore UID, also removes from the
//                 project's guestUids array.
router.delete("/:kind/:id/members/:mmUserId", async (req: Request, res: Response) => {
  const callerUid = req.uid!;
  const { kind, id, mmUserId } = req.params;

  if (kind !== "workspace" && kind !== "project") {
    res.status(400).json({ error: "kind must be 'workspace' or 'project'" });
    return;
  }
  if (!mmUserId || !/^[a-z0-9]+$/.test(mmUserId)) {
    res.status(400).json({ error: "Invalid mmUserId" });
    return;
  }

  try {
    // Owner check — workspace owner is `resolveWorkspaceUid(slug)`,
    // project owner is on the project doc.
    let ownerUid: string | null = null;
    let mmChannelId: string | null = null;

    if (kind === "workspace") {
      ownerUid = await resolveWorkspaceUid(id);
      if (!ownerUid) {
        res.status(404).json({ error: "Workspace not found" });
        return;
      }
      if (ownerUid !== callerUid) {
        res.status(403).json({ error: "Only the workspace owner can remove members" });
        return;
      }
      const ownerCtx = await getWorkspaceMmContext(ownerUid, id);
      mmChannelId = ownerCtx?.generalChannelId ?? null;
      if (!mmChannelId) {
        res.status(422).json({ error: "Workspace has no general channel yet" });
        return;
      }
    } else {
      const parts = decomposeProjectId(id);
      if (!parts) {
        res.status(400).json({ error: "Invalid project id" });
        return;
      }
      const projectRef = db.doc(`workspaces/${parts.wid}/projects/${parts.pid}`);
      const projectDoc = await projectRef.get();
      if (!projectDoc.exists) {
        res.status(404).json({ error: "Project not found" });
        return;
      }
      const project = projectDoc.data()!;
      ownerUid = project.ownerUid ?? null;
      if (ownerUid !== callerUid) {
        res.status(403).json({ error: "Only the project owner can remove members" });
        return;
      }
      const channelDoc = await projectRef.collection("channels").doc("general").get();
      mmChannelId = channelDoc.data()?.mattermost?.channelId ?? null;
      if (!mmChannelId) {
        res.status(422).json({ error: "Project has no channel yet" });
        return;
      }
    }

    // Refuse to let an owner evict themselves — that would orphan the
    // entity. Use leave (project) / delete-workspace flows instead.
    const ownerMmUserId = ownerUid
      ? (await db.doc(`users/${ownerUid}`).get()).data()?.mattermost?.userId ?? null
      : null;
    if (ownerMmUserId && ownerMmUserId === mmUserId) {
      res.status(400).json({ error: "Owners cannot remove themselves — delete the entity instead" });
      return;
    }

    // Remove from the MM channel (admin token — owner authorization is
    // already enforced above, MM-side permission is irrelevant here).
    try {
      await mmApi(`/channels/${mmChannelId}/members/${mmUserId}`, "DELETE");
    } catch (err: any) {
      const msg = err?.message || "";
      if (msg.includes("404")) {
        // Already not a member — treat as success, idempotent delete.
        logger.info(`[entities] ${mmUserId} already absent from ${mmChannelId}`);
      } else {
        throw err;
      }
    }

    // Project mode extras: delete the members/{uid} subcollection doc if
    // the target has a Firestore profile + decrement memberCount. Missing
    // profile is the common case — we skip the cleanup silently.
    if (kind === "project") {
      const parts = decomposeProjectId(id);
      if (parts) {
        const targetSnap = await db
          .collection("users")
          .where("mattermost.userId", "==", mmUserId)
          .limit(1)
          .get();
        if (!targetSnap.empty) {
          const targetUid = targetSnap.docs[0].id;
          const projectRef = db.doc(`workspaces/${parts.wid}/projects/${parts.pid}`);
          const memberRef = projectRef.collection("members").doc(targetUid);
          const memberDoc = await memberRef.get();
          if (memberDoc.exists) {
            await memberRef.delete();
            await projectRef.update({
              memberCount: FieldValue.increment(-1),
              updatedAt: FieldValue.serverTimestamp(),
            });
          }
        }
      }
    }

    logger.info(`[entities] ${callerUid} removed mmUser ${mmUserId} from ${kind}/${id}`);
    res.json({ success: true });
  } catch (err: any) {
    logger.error(`[entities] Member removal failed (${kind}/${id}/${mmUserId})`, { err: String(err) });
    res.status(500).json({ error: "Failed to remove member" });
  }
});

export default router;
