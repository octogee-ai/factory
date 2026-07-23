import { FieldValue, db } from "./db.js";
import { logger } from "../middleware/logging.js";
import { mmApi } from "./mattermost.js";
import {
  createProjectAgentBot,
  retireProjectAgentBot,
  projectAgentSecretDocId,
  type ProjectAgentDeps,
} from "@octogee/core/mattermost/project-agent";
import { isValidProjectId } from "@octogee/shared/types/identity";
import { isPaidTier } from "./billing-tier.js";

export interface ProjectAgentActor {
  uid: string;
  userData: FirebaseFirestore.DocumentData | undefined;
  workspaceId: string | null | undefined;
}

export interface ProjectAgentToggleResult {
  status: number;
  body: Record<string, unknown>;
}

function bad(status: number, error: string): ProjectAgentToggleResult {
  return { status, body: { error } };
}

// The gateway-edge mmApi is (path, method, body); core primitives expect
// (method, endpoint, body).
const coreDeps = (): ProjectAgentDeps => ({
  mmApiCall: (method: string, endpoint: string, body?: unknown) => mmApi(endpoint, method, body),
  db: db as unknown as ProjectAgentDeps["db"],
  now: () => FieldValue.serverTimestamp(),
  log: (msg: string) => logger.info(msg),
});

async function projectChannelIds(workspaceId: string, project: string): Promise<string[]> {
  const snap = await db
    .doc(`workspaces/${workspaceId}/projects/${project}`)
    .collection("channels")
    .get();
  const ids: string[] = [];
  for (const doc of snap.docs) {
    const channelId = (doc.data()?.mattermost as { channelId?: unknown } | undefined)?.channelId;
    if (typeof channelId === "string" && channelId) ids.push(channelId);
  }
  return ids;
}

async function coachDisplayName(uid: string): Promise<string> {
  const snap = await db.doc(`agents/${uid}`).get();
  const name = snap.data()?.name;
  return typeof name === "string" && name ? name : "Octo";
}

// The Project Agent toggle. Writing the server-managed flag + minting the MM
// bot both happen HERE, server-side with admin creds — this is the broker-tier
// mint locus (zero-cred gateways only ever receive pre-minted tokens via the
// snapshot); the prod-path reconcile converges the gateway config afterwards.
export async function setProjectAgentEnabled(
  actor: ProjectAgentActor,
  project: string,
  enabled: boolean,
): Promise<ProjectAgentToggleResult> {
  if (!isValidProjectId(project)) return bad(400, "Invalid project");
  if (!actor.workspaceId) return bad(422, "Workspace not provisioned");
  const workspaceId = actor.workspaceId;

  const projectRef = db.doc(`workspaces/${workspaceId}/projects/${project}`);
  const projectSnap = await projectRef.get();
  if (!projectSnap.exists) return bad(404, "Project not found");
  // The workspace-lane check in the route covers today's owner model; this
  // pins the toggle to the project owner even if ownership ever diverges.
  if (projectSnap.data()?.ownerUid !== actor.uid) {
    return bad(403, "Only the project owner can manage its agent");
  }

  if (
    enabled &&
    projectSnap.data()?.commercialLifecycle?.status === "archived"
  ) {
    return bad(409, "Project is archived");
  }

  if (enabled && !isPaidTier(actor.userData)) {
    return bad(402, "Project agents are available on paid plans");
  }

  await projectRef.set(
    { agent: { enabled, updatedAt: FieldValue.serverTimestamp() } },
    { merge: true },
  );

  return enabled
    ? enableProjectAgent(actor, workspaceId, project)
    : disableProjectAgent(actor, workspaceId, project);
}

async function enableProjectAgent(
  actor: ProjectAgentActor,
  workspaceId: string,
  project: string,
): Promise<ProjectAgentToggleResult> {
  const teamSnap = await db.doc(`workspaces/${workspaceId}`).get();
  const teamId = (teamSnap.data()?.mattermost as { teamId?: unknown } | undefined)?.teamId;
  if (typeof teamId !== "string" || !teamId) {
    logger.error(`[project-agent] no MM teamId for ${workspaceId} — cannot mint ${project}`);
    return bad(502, "Agent enabled, but provisioning failed - toggle again to retry");
  }
  try {
    await createProjectAgentBot(coreDeps(), {
      uid: actor.uid,
      username: workspaceId,
      project,
      teamId,
      displayName: await coachDisplayName(actor.uid),
      projectChannelIds: await projectChannelIds(workspaceId, project),
    });
  } catch (err) {
    logger.error(`[project-agent] mint failed for ${workspaceId}/${project}:`, { err });
    return bad(502, "Agent enabled, but provisioning failed - toggle again to retry");
  }
  logger.info(`[project-agent] enabled + minted ${workspaceId}/${project}`, { uid: actor.uid });
  return { status: 200, body: { success: true, enabled: true, provisioned: true } };
}

async function disableProjectAgent(
  actor: ProjectAgentActor,
  workspaceId: string,
  project: string,
): Promise<ProjectAgentToggleResult> {
  const secretSnap = await db
    .doc(`users/${actor.uid}/secrets/${projectAgentSecretDocId(project)}`)
    .get();
  const mmUserId = secretSnap.data()?.mmUserId;
  if (typeof mmUserId === "string" && mmUserId) {
    try {
      await retireProjectAgentBot(coreDeps(), { uid: actor.uid, project, mmUserId });
    } catch (err) {
      logger.error(`[project-agent] retire failed for ${workspaceId}/${project}:`, { err });
      return bad(502, "Agent disabled, but retiring the bot failed - toggle again to retry");
    }
  }
  logger.info(`[project-agent] disabled ${workspaceId}/${project}`, { uid: actor.uid });
  return { status: 200, body: { success: true, enabled: false, provisioned: false } };
}
