import { Router, Request, Response } from "express";
import { requireAuth } from "../middleware/auth.js";
import { db, FieldValue } from "../lib/db.js";
import { mmApi } from "../lib/mattermost.js";
import { resolveWorkspaceUid } from "../lib/workspace-resolution.js";
import { decomposeProjectId } from "../lib/projectId.js";
import { logger } from "../middleware/logging.js";
import { workspaceGeneralChannelName } from "@octogee/shared/types/identity";
import { getWorkspaceMmContext } from "../lib/mattermost-context.js";
import { readMattermostSecret } from "../lib/mattermost-secret.js";
import { platformStateStore } from "../lib/platform-state.js";
import { removeWorkspaceChannelMember } from "../lib/workspace-channel-membership.js";

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
  /** Epoch ms when the MM account was deactivated; 0 for active users. */
  delete_at?: number;
}

interface RemovalTarget {
  ownerUid: string;
  mmChannelId: string;
  channelDocPath: string;
  workspaceId: string;
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
  const secret = await readMattermostSecret(platformStateStore, uid, "mattermost");
  return secret?.personalToken || null;
}

async function projectGeneralChannelId(workspaceId: string, projectId: string): Promise<string | null> {
  const general = await platformStateStore.workspaces.channels.get(
    { workspaceSlug: workspaceId, projectSlug: projectId },
    "general",
  );
  return general?.mattermostChannelId ?? null;
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

  const project = await platformStateStore.workspaces.projects.get(parts.wid, parts.pid);
  if (!project) {
    return { mmChannelId: null, ownerUid: null, error: "Project not found" };
  }
  return {
    mmChannelId: await projectGeneralChannelId(parts.wid, parts.pid),
    ownerUid: project.ownerUid,
  };
}

async function hydrateFromFirestore(
  mmUserIds: string[],
): Promise<Map<string, { uid: string; avatarUrl: string | null; displayName: string | null }>> {
  const byMmId = new Map<string, { uid: string; avatarUrl: string | null; displayName: string | null }>();
  const builders = await Promise.all(
    mmUserIds.map((mmUserId) => platformStateStore.builders.records.findByMattermostUserId(mmUserId)),
  );

  await Promise.all(
    builders.map(async (builder) => {
      if (!builder?.mattermostUserId) return;
      const [userDoc, publicDoc] = await Promise.all([
        db.doc(`users/${builder.uid}`).get(),
        db.doc(`users/${builder.uid}/profile/public`).get(),
      ]);
      const user = userDoc.data();
      byMmId.set(builder.mattermostUserId, {
        uid: builder.uid,
        displayName: user?.firstName ?? user?.displayName ?? null,
        avatarUrl: publicDoc.data()?.avatarUrl ?? null,
      });
    }),
  );

  return byMmId;
}

async function ownerMmUserId(ownerUid: string | null): Promise<string | null> {
  if (!ownerUid) return null;
  return (await platformStateStore.builders.records.get(ownerUid))?.mattermostUserId ?? null;
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
  // MM's DELETE /users/{id} only DEACTIVATES, and deactivated users remain
  // channel members — a retired project-agent bot would linger in the list
  // looking active. Drop them here; reactivation (toggle back on) restores them.
  const active = mmMembers.filter(
    (member) => (mmUsersById.get(member.user_id)?.delete_at ?? 0) === 0,
  );
  const members = active.map((member) => memberResponse(member, mmUsersById, firestoreByMmId, ownerUserId));
  return sortMembers(members);
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
    return routeError(403, { error: "Only the workspace owner can manage members" });
  }
  const ownerCtx = await getWorkspaceMmContext(ownerUid, id);
  const mmChannelId = ownerCtx?.generalChannelId;
  if (!mmChannelId) return routeError(422, { error: "Workspace has no general channel yet" });
  return {
    ownerUid,
    mmChannelId,
    channelDocPath: `workspaces/${id}/channels/general`,
    workspaceId: id,
  };
}

async function resolveProjectRemovalTarget(id: string, callerUid: string): Promise<RemovalTarget | RouteError> {
  const parts = decomposeProjectId(id);
  if (!parts) return routeError(400, { error: "Invalid project id" });

  const project = await platformStateStore.workspaces.projects.get(parts.wid, parts.pid);
  if (!project) return routeError(404, { error: "Project not found" });
  if (project.ownerUid !== callerUid) {
    return routeError(403, { error: "Only the project owner can remove members" });
  }

  const mmChannelId = await projectGeneralChannelId(parts.wid, parts.pid);
  if (!mmChannelId) return routeError(422, { error: "Project has no channel yet" });
  const projectRef = db.doc(`workspaces/${parts.wid}/projects/${parts.pid}`);
  return {
    ownerUid: project.ownerUid,
    mmChannelId,
    channelDocPath: `${projectRef.path}/channels/general`,
    workspaceId: parts.wid,
    projectRef,
  };
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

async function uidForMattermostUser(mmUserId: string): Promise<string | null> {
  return (await platformStateStore.builders.records.findByMattermostUserId(mmUserId))?.uid ?? null;
}

async function removeMemberDocument(
  target: RemovalTarget,
  mmUserId: string,
): Promise<void> {
  const targetUid = await uidForMattermostUser(mmUserId);
  if (!targetUid) return;

  if (!target.projectRef) {
    if (!await platformStateStore.workspaces.members.get(target.workspaceId, targetUid)) return;
    await platformStateStore.workspaces.members.delete(target.workspaceId, targetUid);
    return;
  }
  const memberRef = target.projectRef.collection("members").doc(targetUid);
  const memberDoc = await memberRef.get();
  if (!memberDoc.exists) return;

  await memberRef.delete();
  await target.projectRef.update({
    memberCount: FieldValue.increment(-1),
    updatedAt: FieldValue.serverTimestamp(),
  });
}

async function markWorkspaceMemberRevoking(
  target: RemovalTarget,
  mmUserId: string,
): Promise<void> {
  if (target.projectRef) return;
  const targetUid = await uidForMattermostUser(mmUserId);
  if (!targetUid) return;
  await platformStateStore.transaction({ label: "entities.member-revoking" }, async (tx) => {
    const member = await tx.workspaces.members.get(target.workspaceId, targetUid);
    if (!member) return;
    await tx.workspaces.members.put({ ...member, canonicalState: "revoking" });
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

    await markWorkspaceMemberRevoking(target, mmUserId);
    const { removeChannelMember } = await import("../lib/channel-lifecycle.js");
    if (target.projectRef) await removeChannelMember(target.channelDocPath, mmUserId);
    else await removeWorkspaceChannelMember(target.workspaceId, mmUserId);
    await removeMemberDocument(target, mmUserId);

    logger.info(`[entities] ${callerUid} removed mmUser ${mmUserId} from ${kind}/${id}`);
    res.json({ success: true });
  } catch (err) {
    logger.error(`[entities] Member removal failed (${kind}/${id}/${mmUserId})`, { err: String(err) });
    res.status(500).json({ error: "Failed to remove member" });
  }
});

export default router;
