/**
 * Entity membership — unified members endpoint for workspaces and projects.
 *
 * GET /api/entities/:kind/:id/members
 *   kind: 'workspace' | 'project'
 *   id:
 *     - workspace: workspace slug (e.g. "grand-raven")
 *     - project:   Firestore project doc id (e.g. "grand-raven_sprint-1")
 *
 * Membership source of truth is Mattermost — if you're in the MM channel,
 * you're a member of the entity, full stop. We use the caller's own MM
 * token (not the admin token) so MM enforces the usual "you can only see
 * channels you belong to" rule natively; non-members get a 403 from MM
 * which we surface as-is. No separate permission layer.
 *
 * The response hydrates each MM user with Firestore profile data
 * (avatar, displayName) via a reverse lookup on `mattermost.userId`.
 * If a MM user has no Firestore profile yet (edge case during
 * provisioning), the MM first_name / username is used as fallback.
 */
import { Router, Request, Response } from "express";
import { requireAuth } from "../middleware/auth";
import { db } from "../lib/db";
import { mmApi } from "../lib/mattermost";
import { resolveWorkspaceUid } from "../lib/workspace-resolution";
import { logger } from "../middleware/logging";

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
 * Project:   `projects/{id}.mmChannelId` (set at provisioning time).
 */
async function resolveEntityChannel(
  kind: EntityKind,
  id: string,
  callerToken: string,
): Promise<{ mmChannelId: string | null; ownerUid: string | null; error?: string }> {
  if (kind === "workspace") {
    const ownerUid = await resolveWorkspaceUid(id);
    if (!ownerUid) return { mmChannelId: null, ownerUid: null, error: "Workspace not found" };

    const ownerDoc = await db.doc(`users/${ownerUid}`).get();
    const ownerData = ownerDoc.data();
    const storedChannelId = ownerData?.mattermost?.generalChannelId;
    if (storedChannelId) return { mmChannelId: storedChannelId, ownerUid };

    // Fallback: search the owner's team channels for `{slug}-general`.
    const teamId = ownerData?.mattermost?.teamId;
    if (!teamId) return { mmChannelId: null, ownerUid, error: "Workspace not yet provisioned" };
    try {
      const channels = (await mmApi(
        `/teams/${teamId}/channels`,
        "GET",
        undefined,
        callerToken,
      )) as Array<{ id: string; name: string }>;
      const general = channels.find(
        (ch) => ch.name === `octogee-${id}-general` || ch.name === `${id}-general`,
      );
      return { mmChannelId: general?.id ?? null, ownerUid };
    } catch (err) {
      logger.warn(`[entities] workspace channel lookup failed for ${id}`, { err: String(err) });
      return { mmChannelId: null, ownerUid };
    }
  }

  // project kind
  const projectDoc = await db.doc(`projects/${id}`).get();
  if (!projectDoc.exists) {
    return { mmChannelId: null, ownerUid: null, error: "Project not found" };
  }
  const project = projectDoc.data()!;
  return {
    mmChannelId: project.mmChannelId ?? null,
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

export default router;
