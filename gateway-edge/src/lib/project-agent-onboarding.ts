import { logger } from "../middleware/logging.js";
import { claimProjectDelivery, beginDeliveryPost, finishProjectDelivery, matchingDeliveryPost, type DeliveryClaim, type DeliveryKind, type OnboardingProject } from "./project-agent-delivery.js";
import { FieldValue, db } from "./db.js";
import { mmApi } from "./mattermost.js";
import { giteaWriteFiles } from "./gitea.js";
import { workspaceGiteaOrg, projectRepoName } from "./gitea-naming.js";
import { projectAgentMmUsername } from "@octogee/shared/types/identity";
import { projectAgentConfigured, type ProjectAgentIdentity } from "@octogee/shared/types/project";
import { projectAgentSecretDocId } from "@octogee/core/mattermost/project-agent";

export interface ProjectHandoff {
  name: string;
  emoji: string;
  persona: string;
  message: string;
}

export function parseProjectHandoff(value: unknown): ProjectHandoff | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const limits = { name: 80, emoji: 32, persona: 2000, message: 12000 };
  const result: Record<string, string> = {};
  for (const [key, max] of Object.entries(limits)) {
    const text = input[key];
    if (typeof text !== "string" || !text.trim() || text.trim().length > max) return null;
    result[key] = text.trim();
  }
  return result as unknown as ProjectHandoff;
}

export function projectAgentSeeds(identity: ProjectAgentIdentity, message: string, ownerName: string) {
  return [
    { path: "IDENTITY.md", content: `# Identity\n\nName: ${identity.name}\nEmoji: ${identity.emoji}\n` },
    { path: "SOUL.md", content: `# Soul\n\n${identity.persona}\n` },
    { path: "USER.md", content: `# Builder\n\n${ownerName}\n\nRelevant Builder context is in BRIEF.md.\n` },
    { path: "BRIEF.md", content: `# Project handoff\n\n${message}\n` },
    { path: "AGENTS.md", content: "# Project agent\n\nRead IDENTITY.md, SOUL.md, USER.md, BRIEF.md, and runbook/ before starting. Keep your own project memory and decisions here. Create an avatar suited to this project and set your chat identity with octogee_chat_set_identity.\n" },
  ];
}

function initialPostStarted(state: { status?: string } | undefined, delivery: { postAttempted?: boolean } | undefined): boolean {
  return state?.status === "sent" || delivery?.postAttempted === true;
}

export async function queueProjectHandoff(uid: string, workspaceId: string, projectSlug: string, handoff: ProjectHandoff): Promise<void> {
  const ref = db.doc(`workspaces/${workspaceId}/projects/${projectSlug}`);
  const handoffRef = db.doc(`${ref.path}/agentState/handoff`);
  await db.runTransaction(async (tx) => {
    const project = (await tx.get(ref)).data();
    if (project?.ownerUid !== uid || project.provisioningState !== "active" || !projectAgentConfigured(project.agent)) {
      throw new Error("An active project with its own agent is required");
    }
    const existing = (await tx.get(handoffRef)).data();
    const delivery = (await tx.get(db.doc(`${ref.path}/agentState/handoffDelivery`))).data();
    const kickoffDelivery = (await tx.get(db.doc(`${ref.path}/agentState/kickoffDelivery`))).data();
    if (initialPostStarted(project.agent.kickoff, kickoffDelivery)) {
      throw new Error("This project already has its initial kickoff; continue in its chat");
    }
    const identity = { name: project.agent.requestedName || handoff.name, emoji: handoff.emoji, persona: handoff.persona };
    if (existing?.message === handoff.message && (["name", "emoji", "persona"] as const)
      .every(key => existing.identity?.[key] === identity[key])) return;
    if (initialPostStarted(project.agent.handoff, delivery)) {
      throw new Error("This project already has its initial handoff; continue in its chat");
    }
    if (project.agent.deliveryLeaseUntil > Date.now()) throw new Error("Project agent delivery is in progress");
    tx.set(handoffRef, { message: handoff.message, identity });
    tx.update(ref, {
      "agent.identity": identity,
      "agent.handoff": { status: "pending" },
      "agent.kickoff": FieldValue.delete(),
      "agent.updatedAt": FieldValue.serverTimestamp(),
    });
  });
}

function deliveryMessage(project: OnboardingProject, kind: DeliveryKind, workspaceId: string, projectSlug: string): string {
  const { agent } = project;
  if (kind === "handoff") {
    if (!agent.identity || !project.handoffMessage) throw new Error("Project handoff identity is missing");
    return `@${projectAgentMmUsername(workspaceId, projectSlug)} ${project.handoffMessage}\n\nYou are ${agent.identity.name} ${agent.identity.emoji}. ${agent.identity.persona} Create a fitting avatar and set your chat identity with octogee_chat_set_identity.`;
  }
  const identityHint = agent.requestedName ? `Your name is ${agent.requestedName}.` : "Choose your own fitting name.";
  const task = project.tagline?.trim()
    ? `The Builder's starting idea: ${project.tagline}\nIntroduce yourself and start with this idea.`
    : "Greet the Builder, ask what they would like to create, and wait for their direction.";
  return `@${projectAgentMmUsername(workspaceId, projectSlug)} You are the new agent for “${project.name}”. ${identityHint} Choose a fitting personality, emoji, and avatar, and set your chat identity with octogee_chat_set_identity. Keep your chosen identity files in the project repo.\n${task}`;
}

async function prepareHandoff({ uid, workspaceId, projectSlug, project }: { uid: string; workspaceId: string; projectSlug: string; project: OnboardingProject }): Promise<void> {
  if (!project.agent.identity || !project.handoffMessage) throw new Error("Project handoff identity is missing");
  const owner = (await db.doc(`users/${uid}`).get()).data();
  await giteaWriteFiles(workspaceGiteaOrg(workspaceId), projectRepoName(projectSlug),
    projectAgentSeeds(project.agent.identity, project.handoffMessage, owner?.displayName || workspaceId), "Initialize project agent");
  const secret = (await db.doc(`users/${uid}/secrets/${projectAgentSecretDocId(projectSlug)}`).get()).data();
  if (!secret?.mmUserId) throw new Error("Project agent has no chat identity");
  await mmApi(`/bots/${secret.mmUserId}`, "PUT", { display_name: project.agent.identity.name });
}

async function ensureCoachMembership(channelId: string, coachId: string): Promise<void> {
  try {
    await mmApi(`/channels/${channelId}/members/${coachId}`, "GET");
    return;
  } catch (error) {
    if ((error as { status?: number }).status !== 404) throw error;
    await mmApi(`/channels/${channelId}/members`, "POST", { user_id: coachId });
  }
}

async function readHandoffMessage(workspaceId: string, projectSlug: string): Promise<string | undefined> {
  const handoff = await db.doc(`workspaces/${workspaceId}/projects/${projectSlug}/agentState/handoff`).get();
  return handoff.data()?.message;
}

async function postOnboarding(uid: string, workspaceId: string, projectSlug: string, claim: DeliveryClaim): Promise<string> {
  const { kind } = claim;
  const project = { ...claim.project, handoffMessage: kind === "handoff"
    ? await readHandoffMessage(workspaceId, projectSlug) : undefined };
  const coach = (await db.doc(`users/${uid}/secrets/coachMattermost`).get()).data();
  const coachId = (await db.doc(`agents/${uid}`).get()).data()?.mattermost?.userId;
  const channelPath = `workspaces/${workspaceId}/projects/${projectSlug}/channels/general`;
  const channelId = (await db.doc(channelPath).get()).data()?.mattermost?.channelId;
  const token = coach?.personalToken;
  if (!channelId || !token || !coachId) throw new Error("Project handoff chat credentials are not ready");
  const receipt = `${workspaceId}/${projectSlug}/${kind}`;
  if (kind === "handoff") await prepareHandoff({ uid, workspaceId, projectSlug, project });
  await ensureCoachMembership(channelId, coachId);
  const ref = db.doc(`workspaces/${workspaceId}/projects/${projectSlug}`);
  let postId = await matchingDeliveryPost(ref, claim, channelId, receipt, token);
  if (!postId) {
    await beginDeliveryPost(ref, claim);
    const post = await mmApi("/posts", "POST", { channel_id: channelId,
      message: deliveryMessage(project, kind, workspaceId, projectSlug),
      props: { octogee_project_delivery: receipt } }, token) as { id?: string };
    if (!post.id) throw new Error("Project handoff post returned no ID");
    postId = post.id;
  }
  return postId;
}

export async function deliverProjectAgentOnboarding(uid: string, workspaceId: string, projectSlug: string): Promise<void> {
  const ref = db.doc(`workspaces/${workspaceId}/projects/${projectSlug}`);
  const claim = await claimProjectDelivery(ref, uid);
  if (!claim) return;
  try {
    const postId = await postOnboarding(uid, workspaceId, projectSlug, claim);
    await finishProjectDelivery(ref, claim, { [`agent.${claim.kind}.status`]: "sent", [`agent.${claim.kind}.postId`]: postId,
      "agent.lastError": null });
  } catch (error) {
    logger.error("Project onboarding delivery failed", { uid, workspaceId, projectSlug, kind: claim.kind, error });
    try {
      await finishProjectDelivery(ref, claim, { "agent.lastError": error instanceof Error ? error.message : String(error) });
    } catch (cleanupError) {
      logger.error("Project onboarding delivery cleanup failed", { uid, workspaceId, projectSlug, error: cleanupError });
    }
    throw error;
  }
}
