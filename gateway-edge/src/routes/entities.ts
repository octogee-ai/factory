

import { Router, Request, Response } from "express";
import { requireAuth } from "../middleware/auth.js";
import { db, FieldValue } from "../lib/db.js";
import { mmApi } from "../lib/mattermost.js";
import { resolveWorkspaceUid } from "../lib/workspace-resolution.js";
import { decomposeProjectId } from "../lib/projectId.js";
import { logger } from "../middleware/logging.js";
import { workspaceGeneralChannelName } from "@shared/types/identity.js";
import { getWorkspaceMmContext } from "../lib/mattermost-context.js";
import { readChannel, readProject } from "../lib/firestoreReads.js";

const router = Router();
router.use(requireAuth);

type EntityKind = "workspace" | "project";

interface RouteError {
  status: number;
  body: Record<string, unknown>;
}

interface MemberResponse {
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

interface RemovalTarget {
  ownerUid: string;
  mmChannelId: string;
  projectRef?: FirebaseFirestore.DocumentReference;
}

function routeError(status: number, body: Record<string, unknown>): RouteError {
  return { status, body };
}

function isRouteError<T>(value: T | RouteError): value is RouteError {
  return typeof (value as RouteError).status === "number" && "body" in (value as RouteError);
}

function sendRouteError(res: Response, error: RouteError): void {
  res.status(error.status).json(error.body);
}

function isEntityKind(kind: string): kind is EntityKind {
  return kind === "workspace" || kind === "project";
}

async function getCallerMmToken(uid: string): Promise<string | null> {
  const secretDoc = await db.doc(`users/${uid}/secrets/mattermost`).get();
  const token = secretDoc.data()?.personalToken;
  return typeof token === "string" && token.length > 0 ? token : null;
}

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

  const parts = decomposeProjectId(id);
  if (!parts) return { mmChannelId: null, ownerUid: null, error: "Invalid project id" };

  const projectRef = db.doc(`workspaces/${parts.wid}/projects/${parts.pid}`);
  const project = await readProject(projectRef);
  if (!project) {
    return { mmChannelId: null, ownerUid: null, error: "Project not found" };
  }
  const generalChan = await readChannel(projectRef.collection("channels").doc("general"));
  return {
    mmChannelId: generalChan?.mattermost?.channelId ?? null,
    ownerUid: project.ownerUid,
  };
}

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

  const baseEntries = userChunks.flat().flatMap((u) => {
    const mmId = u.data?.mattermost?.userId;
    if (!mmId) return [];
    return [{
      mmId,
      uid: u.uid,
      displayName: u.data?.firstName ?? u.data?.displayName ?? null,
    }];
  });

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

async function ownerMmUserId(ownerUid: string | null): Promise<string | null> {
  if (!ownerUid) return null;
  const ownerDoc = await db.doc(`users/${ownerUid}`).get();
  return ownerDoc.data()?.mattermost?.userId ?? null;
}

async function fetchChannelMembers(
  mmChannelId: string,
  callerToken: string,
): Promise<MmChannelMember[] | RouteError> {
  try {
    return (await mmApi(
      `/channels/${mmChannelId}/members`,
      "GET",
      undefined,
      callerToken,
    )) as MmChannelMember[];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("403") || msg.includes("401")) {
      return routeError(403, { error: "You are not a member of this channel" });
    }
    throw err;
  }
}

async function fetchMmUsersById(mmUserIds: string[], callerToken: string): Promise<Map<string, MmUser>> {
  const mmUsers = (await mmApi(
    `/users/ids`,
    "POST",
    mmUserIds,
    callerToken,
  )) as MmUser[];
  return new Map(mmUsers.map((user) => [user.id, user]));
}

function memberResponse(
  member: MmChannelMember,
  mmUsersById: Map<string, MmUser>,
  firestoreByMmId: Map<string, { uid: string; avatarUrl: string | null; displayName: string | null }>,
  ownerMmUserId: string | null,
): MemberResponse {
  const mmUser = mmUsersById.get(member.user_id);
  const fs = firestoreByMmId.get(member.user_id);
  const displayName =
    fs?.displayName ||
    mmUser?.first_name ||
    mmUser?.username ||
    "Unknown";
  return {
    uid: fs?.uid ?? null,
    mmUserId: member.user_id,
    username: mmUser?.username ?? member.user_id,
    displayName,
    avatarUrl: fs?.avatarUrl ?? null,
    role: member.user_id === ownerMmUserId ? "owner" : "member",
  };
}

function sortMembers(members: MemberResponse[]): MemberResponse[] {
  return members.sort((a, b) => {
    if (a.role === "owner" && b.role !== "owner") return -1;
    if (a.role !== "owner" && b.role === "owner") return 1;
    return a.displayName.localeCompare(b.displayName);
  });
}

async function buildMemberResponses(
  mmMembers: MmChannelMember[],
  ownerUid: string | null,
  callerToken: string,
): Promise<MemberResponse[]> {
  const mmUserIds = mmMembers.map((member) => member.user_id);
  const [ownerUserId, mmUsersById, firestoreByMmId] = await Promise.all([
    ownerMmUserId(ownerUid),
    fetchMmUsersById(mmUserIds, callerToken),
    hydrateFromFirestore(mmUserIds),
  ]);
  return sortMembers(
    mmMembers.map((member) => memberResponse(member, mmUsersById, firestoreByMmId, ownerUserId)),
  );
}

router.get("/:kind/:id/members", async (req: Request, res: Response) => {
  const uid = req.uid!;
  const { kind, id } = req.params as { kind: string; id: string };

  if (!isEntityKind(kind)) {
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
      kind,
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

    const mmMembers = await fetchChannelMembers(mmChannelId, callerToken);
    if (isRouteError(mmMembers)) {
      sendRouteError(res, mmMembers);
      return;
    }

    if (mmMembers.length === 0) {
      res.json({ members: [] });
      return;
    }

    res.json({ members: await buildMemberResponses(mmMembers, ownerUid, callerToken) });
  } catch (err) {
    logger.error(`[entities] Members fetch failed (${kind}/${id})`, { err: String(err) });
    res.status(500).json({ error: "Failed to load members" });
  }
});

async function resolveWorkspaceRemovalTarget(id: string, callerUid: string): Promise<RemovalTarget | RouteError> {
  const ownerUid = await resolveWorkspaceUid(id);
  if (!ownerUid) return routeError(404, { error: "Workspace not found" });
  if (ownerUid !== callerUid) {
    return routeError(403, { error: "Only the workspace owner can remove members" });
  }
  const ownerCtx = await getWorkspaceMmContext(ownerUid, id);
  const mmChannelId = ownerCtx?.generalChannelId;
  if (!mmChannelId) return routeError(422, { error: "Workspace has no general channel yet" });
  return { ownerUid, mmChannelId };
}

async function resolveProjectRemovalTarget(id: string, callerUid: string): Promise<RemovalTarget | RouteError> {
  const parts = decomposeProjectId(id);
  if (!parts) return routeError(400, { error: "Invalid project id" });

  const projectRef = db.doc(`workspaces/${parts.wid}/projects/${parts.pid}`);
  const project = await readProject(projectRef);
  if (!project) return routeError(404, { error: "Project not found" });
  if (project.ownerUid !== callerUid) {
    return routeError(403, { error: "Only the project owner can remove members" });
  }

  const generalChan = await readChannel(projectRef.collection("channels").doc("general"));
  const mmChannelId = generalChan?.mattermost?.channelId;
  if (!mmChannelId) return routeError(422, { error: "Project has no channel yet" });
  return { ownerUid: project.ownerUid, mmChannelId, projectRef };
}

async function resolveRemovalTarget(
  kind: EntityKind,
  id: string,
  callerUid: string,
): Promise<RemovalTarget | RouteError> {
  return kind === "workspace"
    ? resolveWorkspaceRemovalTarget(id, callerUid)
    : resolveProjectRemovalTarget(id, callerUid);
}

async function ownerRemovalError(ownerUid: string, mmUserId: string): Promise<RouteError | null> {
  const ownerUserId = await ownerMmUserId(ownerUid);
  return ownerUserId === mmUserId
    ? routeError(400, { error: "Owners cannot remove themselves — delete the entity instead" })
    : null;
}

async function deleteMattermostMember(mmChannelId: string, mmUserId: string): Promise<void> {
  try {
    await mmApi(`/channels/${mmChannelId}/members/${mmUserId}`, "DELETE");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("404")) {
      logger.info(`[entities] ${mmUserId} already absent from ${mmChannelId}`);
      return;
    }
    throw err;
  }
}

async function uidForMattermostUser(mmUserId: string): Promise<string | null> {
  const targetSnap = await db
    .collection("users")
    .where("mattermost.userId", "==", mmUserId)
    .limit(1)
    .get();
  return targetSnap.empty ? null : targetSnap.docs[0].id;
}

async function removeProjectMemberDocument(
  projectRef: FirebaseFirestore.DocumentReference | undefined,
  mmUserId: string,
): Promise<void> {
  if (!projectRef) return;
  const targetUid = await uidForMattermostUser(mmUserId);
  if (!targetUid) return;

  const memberRef = projectRef.collection("members").doc(targetUid);
  const memberDoc = await memberRef.get();
  if (!memberDoc.exists) return;

  await memberRef.delete();
  await projectRef.update({
    memberCount: FieldValue.increment(-1),
    updatedAt: FieldValue.serverTimestamp(),
  });
}

router.delete("/:kind/:id/members/:mmUserId", async (req: Request, res: Response) => {
  const callerUid = req.uid!;
  const { kind, id, mmUserId } = req.params as { kind: string; id: string; mmUserId: string };

  if (!isEntityKind(kind)) {
    res.status(400).json({ error: "kind must be 'workspace' or 'project'" });
    return;
  }
  if (!mmUserId || !/^[a-z0-9]+$/.test(mmUserId)) {
    res.status(400).json({ error: "Invalid mmUserId" });
    return;
  }

  try {
    const target = await resolveRemovalTarget(kind, id, callerUid);
    if (isRouteError(target)) {
      sendRouteError(res, target);
      return;
    }

    const ownerError = await ownerRemovalError(target.ownerUid, mmUserId);
    if (ownerError) {
      sendRouteError(res, ownerError);
      return;
    }

    await deleteMattermostMember(target.mmChannelId, mmUserId);
    await removeProjectMemberDocument(target.projectRef, mmUserId);

    logger.info(`[entities] ${callerUid} removed mmUser ${mmUserId} from ${kind}/${id}`);
    res.json({ success: true });
  } catch (err) {
    logger.error(`[entities] Member removal failed (${kind}/${id}/${mmUserId})`, { err: String(err) });
    res.status(500).json({ error: "Failed to remove member" });
  }
});

export default router;
