import { randomUUID } from "node:crypto";
import { FieldValue, db } from "./db.js";
import { logger } from "../middleware/logging.js";
import { mmApi } from "./mattermost.js";
import {
  createProjectAgentBot,
  retireProjectAgentBot,
  projectAgentSecretDocId,
  type ProjectAgentDeps,
} from "@octogee/core/mattermost/project-agent";
import type { ProjectAgentStatus } from "@octogee/shared/types/project";
import { isValidProjectId, projectAgentId } from "@octogee/shared/types/identity";
import { addChannelMember, mapMattermostMembershipError } from "./channel-lifecycle.js";

export interface ProjectAgentActor {
  uid: string;
  workspaceId: string | null | undefined;
}

export interface ProjectAgentProvisionResult {
  status: number;
  body: Record<string, unknown>;
}

interface ProjectAgentProvisionContext {
  workspaceId: string;
  projectRef: FirebaseFirestore.DocumentReference;
}

const PROVISION_FAILED = "Project Agent provisioning failed - retry from project settings";

function bad(status: number, error: string): ProjectAgentProvisionResult {
  return { status, body: { error } };
}

function isProvisionResult(
  value: ProjectAgentProvisionContext | ProjectAgentProvisionResult,
): value is ProjectAgentProvisionResult {
  return "body" in value;
}

function errorFrom(result: ProjectAgentProvisionResult): string {
  const error = result.body.error;
  return typeof error === "string" ? error : "Project Agent operation failed";
}

async function writeProjectAgentState(
  projectRef: FirebaseFirestore.DocumentReference,
  status: ProjectAgentStatus,
  lastError: string | null = null,
  activationId: string | null = null,
): Promise<void> {
  await projectRef.set(
    {
      agent: {
        status,
        activationId,
        lastError,
        updatedAt: FieldValue.serverTimestamp(),
      },
    },
    { merge: true },
  );
}

async function settleProjectAgentError(
  projectRef: FirebaseFirestore.DocumentReference,
  result: ProjectAgentProvisionResult,
): Promise<ProjectAgentProvisionResult> {
  try {
    await writeProjectAgentState(projectRef, "error", errorFrom(result));
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

async function resolveProjectAgentProvisionContext(
  actor: ProjectAgentActor,
  project: string,
): Promise<ProjectAgentProvisionContext | ProjectAgentProvisionResult> {
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
  if (projectData?.commercialLifecycle?.status === "archived") {
    return bad(409, "Project is archived");
  }
  return { workspaceId, projectRef };
}

// Every active project has its agent. Provisioning writes the server-managed
// state and mints the MM bot here, server-side with admin creds — the
// broker-tier mint locus (zero-cred gateways only ever receive pre-minted
// tokens via the snapshot); the prod-path reconcile converges the gateway
// config afterwards. Re-running is the retry path after a failed mint.
export async function provisionProjectAgent(
  actor: ProjectAgentActor,
  project: string,
): Promise<ProjectAgentProvisionResult> {
  const context = await resolveProjectAgentProvisionContext(actor, project);
  if (isProvisionResult(context)) return context;
  const { workspaceId, projectRef } = context;

  await writeProjectAgentState(projectRef, "provisioning");

  // Roster precedes the mint outcome: the byok broker refuses tokens for
  // unrostered agent ids, and an unresolvable boot-time SecretRef probe-kills
  // the whole gateway pod. Keying on the project keeps the roster a superset of
  // every agent the gateway config can demand, whatever partial-failure state
  // provisioning lands in.
  const agentId = projectAgentId(workspaceId, project);
  try {
    await db.doc(`users/${actor.uid}`).update({
      "provisioning.openclaw.agentIds": FieldValue.arrayUnion(agentId),
    });
  } catch (err) {
    logger.error(`[project-agent] roster update failed for ${workspaceId}/${project}:`, { err });
    return settleProjectAgentError(projectRef, bad(502, PROVISION_FAILED));
  }

  const teamSnap = await db.doc(`workspaces/${workspaceId}`).get();
  const teamId = (teamSnap.data()?.mattermost as { teamId?: unknown } | undefined)?.teamId;
  if (typeof teamId !== "string" || !teamId) {
    logger.error(`[project-agent] no MM teamId for ${workspaceId} — cannot mint ${project}`);
    return settleProjectAgentError(projectRef, bad(502, PROVISION_FAILED));
  }
  try {
    const channelBindings = await projectChannelBindings(workspaceId, project);
    const minted = await createProjectAgentBot(coreDeps(), {
      uid: actor.uid,
      username: workspaceId,
      project,
      teamId,
      displayName: (await projectRef.get()).data()?.agent?.identity?.name ?? project,
      projectChannelIds: channelBindings.map((binding) => binding.channelId),
    });
    for (const binding of channelBindings) {
      await addChannelMember(binding.docPath, minted.mmUserId);
    }
    await writeProjectAgentState(projectRef, "provisioning", null, randomUUID());
  } catch (err) {
    logger.error(`[project-agent] mint failed for ${workspaceId}/${project}:`, { err });
    return settleProjectAgentError(
      projectRef,
      mapMattermostMembershipError(err) ?? bad(502, PROVISION_FAILED),
    );
  }
  logger.info(`[project-agent] minted ${workspaceId}/${project}`, { uid: actor.uid });
  return {
    status: 200,
    body: { success: true, status: "provisioning", provisioned: true },
  };
}

// Deletion-time convergence: bot retirement plus roster cleanup. The secret
// doc is config demand for the owner's gateway, so it must be gone before the
// roster id is removed — an unrostered agent that is still in the config
// wedges the whole pod. A throw here therefore leaves the roster entry in
// place (a lingering superset is safe; the caller retries).
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
