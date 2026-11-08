import { logger } from "../middleware/logging.js";
import {
  claimProjectDelivery,
  beginDeliveryPost,
  finishProjectDelivery,
  matchingDeliveryPost,
  openDeliveryIntent,
  type DeliveryClaim,
  type DeliveryKind,
  type OnboardingProject,
  type ProjectDeliveryTarget,
} from "./project-agent-delivery.js";
import { FieldValue, db } from "./db.js";
import { platformStateStore } from "./platform-state.js";
import { readMattermostSecret } from "./mattermost-secret.js";
import { mmApi } from "./mattermost.js";
import { projectAgentMmUsername } from "@octogee/shared/types/identity";
import { projectAgentConfigured } from "@octogee/shared/types/project";
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
  const privateWorkspace = project.repoSource?.provider === "github";
  if (kind === "handoff") {
    if (!agent.identity || !project.handoffMessage) throw new Error("Project handoff identity is missing");
    const workspace = privateWorkspace
      ? "in your private coach workspace. Keep those coach files there. Use the GitHub checkout, when available, for source and repository-owned instructions."
      : "in your project checkout. Preserve existing project instructions and decisions, read runbook/ and DECISIONS.md when present, and commit these files together with your work using octogee_project_commit.";
    return `@${projectAgentMmUsername(workspaceId, projectSlug)} ${project.handoffMessage}\n\nYou are ${agent.identity.name} ${agent.identity.emoji}. ${agent.identity.persona}\nBefore starting, save this handoff in BRIEF.md, update IDENTITY.md and SOUL.md with your assigned identity, and record relevant Builder context in USER.md ${workspace} Create a fitting avatar and set your chat identity with octogee_chat_set_identity.`;
  }
  const identityHint = agent.requestedName ? `Your name is ${agent.requestedName}.` : "Choose your own fitting name.";
  const task = project.tagline?.trim()
    ? `The Builder's starting idea: ${project.tagline}\nIntroduce yourself and start with this idea.`
    : "Greet the Builder, ask what they would like to create, and wait for their direction.";
  return `@${projectAgentMmUsername(workspaceId, projectSlug)} You are the new agent for “${project.name}”. ${identityHint} Choose a fitting personality, emoji, and avatar, and set your chat identity with octogee_chat_set_identity. Keep your chosen identity files in your ${privateWorkspace ? "private coach workspace" : "project repo"}.\n${task}`;
}

async function prepareHandoff({ uid, projectSlug, project }: { uid: string; projectSlug: string; project: OnboardingProject }): Promise<void> {
  if (!project.agent.identity || !project.handoffMessage) throw new Error("Project handoff identity is missing");
  const secret = await readMattermostSecret(platformStateStore, uid, projectAgentSecretDocId(projectSlug));
  if (!secret?.mattermostUserId) throw new Error("Project agent has no chat identity");
  await mmApi(`/bots/${secret.mattermostUserId}`, "PUT", { display_name: project.agent.identity.name });
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

async function postOnboarding(uid: string, target: ProjectDeliveryTarget, claim: DeliveryClaim): Promise<string> {
  const { kind } = claim;
  const { workspaceId, projectSlug } = target;
  const project = { ...claim.project, handoffMessage: kind === "handoff"
    ? await readHandoffMessage(workspaceId, projectSlug) : undefined };
  const [coach, coachIdentity, channel] = await Promise.all([
    readMattermostSecret(platformStateStore, uid, "coachMattermost"),
    platformStateStore.workspaces.agentIdentities.get(uid),
    platformStateStore.workspaces.channels.get({ workspaceSlug: workspaceId, projectSlug }, "general"),
  ]);
  const coachId = coachIdentity?.mattermostUserId;
  const channelId = channel?.mattermostChannelId;
  const token = coach?.personalToken;
  if (!channelId || !token || !coachId) throw new Error("Project handoff chat credentials are not ready");
  const receipt = `${workspaceId}/${projectSlug}/${kind}`;
  if (kind === "handoff") await prepareHandoff({ uid, projectSlug, project });
  await ensureCoachMembership(channelId, coachId);
  let postId = await matchingDeliveryPost(target, claim, channelId, receipt, token);
  if (!postId) {
    await beginDeliveryPost(target, claim);
    const post = await mmApi("/posts", "POST", { channel_id: channelId,
      message: deliveryMessage(project, kind, workspaceId, projectSlug),
      props: { octogee_project_delivery: receipt } }, token) as { id?: string };
    if (!post.id) throw new Error("Project handoff post returned no ID");
    postId = post.id;
  }
  return postId;
}

export async function deliverProjectAgentOnboarding(uid: string, workspaceId: string, projectSlug: string): Promise<void> {
  const target = { workspaceId, projectSlug };
  const lease = await claimProjectDelivery(target, uid);
  if (!lease) return;
  try {
    const claim = await openDeliveryIntent(target, lease);
    const postId = await postOnboarding(uid, target, claim);
    await finishProjectDelivery(target, lease, { postId });
  } catch (error) {
    logger.error("Project onboarding delivery failed", { uid, workspaceId, projectSlug, kind: lease.kind, error });
    try {
      await finishProjectDelivery(target, lease, { error: error instanceof Error ? error.message : String(error) });
    } catch (cleanupError) {
      logger.error("Project onboarding delivery cleanup failed", { uid, workspaceId, projectSlug, error: cleanupError });
    }
    throw error;
  }
}
