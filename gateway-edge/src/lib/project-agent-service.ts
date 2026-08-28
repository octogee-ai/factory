import { FieldValue, db } from "./db.js";
import { logger } from "../middleware/logging.js";
import { mmApi } from "./mattermost.js";
import {
  createProjectAgentBot,
  retireProjectAgentBot,
  projectAgentSecretDocId,
  type ProjectAgentDeps,
} from "@octogee/core/mattermost/project-agent";
import type { ProjectAgentMode, ProjectAgentStatus } from "@octogee/shared/types/project";
import { isValidProjectId, projectAgentId } from "@octogee/shared/types/identity";
import { isPaidTier } from "./billing-tier.js";
import { addChannelMember, mapMattermostMembershipError } from "./channel-lifecycle.js";

export interface ProjectAgentActor {
  uid: string;
  userData: FirebaseFirestore.DocumentData | undefined;
  workspaceId: string | null | undefined;
}

export interface ProjectAgentToggleResult {
  status: number;
  body: Record<string, unknown>;
}

interface ProjectAgentToggleContext {
  workspaceId: string;
  projectRef: FirebaseFirestore.DocumentReference;
}

function bad(status: number, error: string): ProjectAgentToggleResult {
  return { status, body: { error } };
}

function isProjectAgentToggleResult(
  value: ProjectAgentToggleContext | ProjectAgentToggleResult,
): value is ProjectAgentToggleResult {
  return "body" in value;
}

function modeFor(enabled: boolean): ProjectAgentMode {
  return enabled ? "scoped" : "agentless";
}

function errorFrom(result: ProjectAgentToggleResult): string {
  const error = result.body.error;
  return typeof error === "string" ? error : "Project Agent operation failed";
}

async function writeProjectAgentState(
  projectRef: FirebaseFirestore.DocumentReference,
  enabled: boolean,
  status: ProjectAgentStatus,
  lastError: string | null = null,
): Promise<void> {
  await projectRef.set(
    {
      agent: {
        enabled,
        mode: modeFor(enabled),
        status,
        lastError,
        updatedAt: FieldValue.serverTimestamp(),
      },
    },
    { merge: true },
  );
}

async function settleProjectAgentError(
  projectRef: FirebaseFirestore.DocumentReference,
  enabled: boolean,
  result: ProjectAgentToggleResult,
): Promise<ProjectAgentToggleResult> {
  try {
    await writeProjectAgentState(projectRef, enabled, "error", errorFrom(result));
  } catch (err) {
    logger.error("[project-agent] failed to record terminal error state:", { err });
  }
  return result;
}

// The gateway-edge mmApi is (path, method, body); core primitives expect
// (method, endpoint, body).
const coreDeps = (): ProjectAgentDeps => ({
  mmApiCall: (method: string, endpoint: string, body?: unknown) => mmApi(endpoint, method, body),
  db: db as unknown as ProjectAgentDeps["db"],
  now: () => FieldValue.serverTimestamp(),
  log: (msg: string) => logger.info(msg),
});

interface ProjectChannelBinding {
  channelId: string;
  docPath: string;
}

async function projectChannelBindings(
  workspaceId: string,
  project: string,
): Promise<ProjectChannelBinding[]> {
  const projectPath = `workspaces/${workspaceId}/projects/${project}`;
  const snap = await db
    .doc(projectPath)
    .collection("channels")
    .get();
  const bindings: ProjectChannelBinding[] = [];
  for (const doc of snap.docs) {
    const channelId = (doc.data()?.mattermost as { channelId?: unknown } | undefined)?.channelId;
    if (typeof channelId === "string" && channelId) {
      bindings.push({
        channelId,
        docPath: `${projectPath}/channels/${doc.id}`,
      });
    }
  }
  return bindings;
}

async function coachDisplayName(uid: string): Promise<string> {
  const snap = await db.doc(`agents/${uid}`).get();
  const name = snap.data()?.name;
  return typeof name === "string" && name ? name : "Octo";
}

async function resolveProjectAgentToggleContext(
  actor: ProjectAgentActor,
  project: string,
  enabled: boolean,
): Promise<ProjectAgentToggleContext | ProjectAgentToggleResult> {
  if (!isValidProjectId(project)) return bad(400, "Invalid project");
  if (!actor.workspaceId) return bad(422, "Workspace not provisioned");
  const workspaceId = actor.workspaceId;
  const projectRef = db.doc(`workspaces/${workspaceId}/projects/${project}`);
  const projectSnap = await projectRef.get();
  if (!projectSnap.exists) return bad(404, "Project not found");
  const projectData = projectSnap.data();
  if (projectData?.ownerUid !== actor.uid) {
    return bad(403, "Only the project owner can manage its agent");
  }
  if (enabled && projectData?.commercialLifecycle?.status === "archived") {
    return bad(409, "Project is archived");
  }
  if (enabled && !isPaidTier(actor.userData)) {
    return bad(402, "Project agents are available on paid plans");
  }
  return { workspaceId, projectRef };
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
  const context = await resolveProjectAgentToggleContext(actor, project, enabled);
  if (isProjectAgentToggleResult(context)) return context;
  const { workspaceId, projectRef } = context;

  await writeProjectAgentState(projectRef, enabled, enabled ? "provisioning" : "retiring");

  // Roster follows the flag, not the mint/retire outcome: the byok broker
  // refuses tokens for unrostered agent ids, and an unresolvable boot-time
  // SecretRef probe-kills the whole gateway pod. Keying on the flag keeps the
  // roster a superset of every agent the gateway config can demand, whatever
  // partial-failure state the toggle lands in.
  const agentId = projectAgentId(workspaceId, project);
  try {
    await db.doc(`users/${actor.uid}`).update({
      "provisioning.openclaw.agentIds": enabled
        ? FieldValue.arrayUnion(agentId)
        : FieldValue.arrayRemove(agentId),
    });
  } catch (err) {
    const result = bad(
      502,
      enabled
        ? "Agent enabled, but provisioning failed - toggle again to retry"
        : "Agent disabled, but retiring the bot failed - toggle again to retry",
    );
    logger.error(`[project-agent] roster update failed for ${workspaceId}/${project}:`, { err });
    return settleProjectAgentError(projectRef, enabled, result);
  }

  return enabled
    ? enableProjectAgent(actor, projectRef, workspaceId, project)
    : disableProjectAgent(actor, projectRef, workspaceId, project);
}

async function enableProjectAgent(
  actor: ProjectAgentActor,
  projectRef: FirebaseFirestore.DocumentReference,
  workspaceId: string,
  project: string,
): Promise<ProjectAgentToggleResult> {
  const teamSnap = await db.doc(`workspaces/${workspaceId}`).get();
  const teamId = (teamSnap.data()?.mattermost as { teamId?: unknown } | undefined)?.teamId;
  if (typeof teamId !== "string" || !teamId) {
    logger.error(`[project-agent] no MM teamId for ${workspaceId} — cannot mint ${project}`);
    return settleProjectAgentError(
      projectRef,
      true,
      bad(502, "Agent enabled, but provisioning failed - toggle again to retry"),
    );
  }
  try {
    const channelBindings = await projectChannelBindings(workspaceId, project);
    const minted = await createProjectAgentBot(coreDeps(), {
      uid: actor.uid,
      username: workspaceId,
      project,
      teamId,
      displayName: await coachDisplayName(actor.uid),
      projectChannelIds: channelBindings.map((binding) => binding.channelId),
    });
    for (const binding of channelBindings) {
      await addChannelMember(binding.docPath, minted.mmUserId);
    }
    await writeProjectAgentState(projectRef, true, "ready");
  } catch (err) {
    logger.error(`[project-agent] mint failed for ${workspaceId}/${project}:`, { err });
    return settleProjectAgentError(
      projectRef,
      true,
      mapMattermostMembershipError(err) ?? bad(502, "Agent enabled, but provisioning failed - toggle again to retry"),
    );
  }
  logger.info(`[project-agent] enabled + minted ${workspaceId}/${project}`, { uid: actor.uid });
  return {
    status: 200,
    body: { success: true, enabled: true, mode: "scoped", status: "ready", provisioned: true },
  };
}

// Deletion-time convergence: the toggle's disable path plus roster cleanup.
// The secret doc is config demand for the owner's gateway, so it must be gone
// before the roster id is removed — an unrostered agent that is still in the
// config wedges the whole pod. A throw here therefore leaves the roster entry
// in place (a lingering superset is safe; the caller retries).
export async function retireProjectAgentForDeletion(
  uid: string,
  workspaceId: string,
  project: string,
): Promise<void> {
  const secretRef = db.doc(`users/${uid}/secrets/${projectAgentSecretDocId(project)}`);
  const secretSnap = await secretRef.get();
  const mmUserId = secretSnap.data()?.mmUserId;
  if (typeof mmUserId === "string" && mmUserId) {
    await retireProjectAgentBot(coreDeps(), { uid, project, mmUserId });
  } else if (secretSnap.exists) {
    logger.warn(
      `[project-agent] dropping ${workspaceId}/${project} secret without an mmUserId — PAT not revoked`,
    );
    await secretRef.delete();
  }
  await db.doc(`users/${uid}`).update({
    "provisioning.openclaw.agentIds": FieldValue.arrayRemove(projectAgentId(workspaceId, project)),
  });
}

async function disableProjectAgent(
  actor: ProjectAgentActor,
  projectRef: FirebaseFirestore.DocumentReference,
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
      return settleProjectAgentError(
        projectRef,
        false,
        bad(502, "Agent disabled, but retiring the bot failed - toggle again to retry"),
      );
    }
  } else if (secretSnap.exists) {
    const result = bad(502, "Agent disabled, but retiring the bot failed - toggle again to retry");
    logger.error(`[project-agent] project agent secret has no Mattermost user for ${workspaceId}/${project}`);
    return settleProjectAgentError(projectRef, false, result);
  }
  try {
    await writeProjectAgentState(projectRef, false, "agentless");
  } catch (err) {
    logger.error(`[project-agent] failed to record disabled state for ${workspaceId}/${project}:`, { err });
    return settleProjectAgentError(
      projectRef,
      false,
      bad(502, "Agent disabled, but retiring the bot failed - toggle again to retry"),
    );
  }
  logger.info(`[project-agent] disabled ${workspaceId}/${project}`, { uid: actor.uid });
  return {
    status: 200,
    body: { success: true, enabled: false, mode: "agentless", status: "agentless", provisioned: false },
  };
}
