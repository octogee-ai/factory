import { randomUUID } from "node:crypto";
import type { DocumentReference } from "firebase-admin/firestore";
import { projectAgentConfigured, type ProjectAgentConfig } from "@octogee/shared/types/project";
import { db, FieldValue } from "./db.js";
import { mmApi } from "./mattermost.js";

export type DeliveryKind = "handoff" | "kickoff";
export type OnboardingProject = { name: string; tagline?: string; agent: ProjectAgentConfig; handoffMessage?: string };
export interface DeliveryClaim {
  project: OnboardingProject;
  kind: DeliveryKind;
  leaseId: string;
  startedAt: number;
  postAttempted: boolean;
  recoveryBefore?: string;
}

function pendingDelivery(agent: ProjectAgentConfig): DeliveryKind | null {
  if (agent.handoff) return agent.handoff.status === "pending" ? "handoff" : null;
  return agent.kickoff?.status === "pending" ? "kickoff" : null;
}

export async function claimProjectDelivery(ref: DocumentReference, uid: string): Promise<DeliveryClaim | null> {
  return db.runTransaction(async (tx) => {
    const project = (await tx.get(ref)).data();
    if (project?.ownerUid !== uid || project.agent?.status !== "ready" || !projectAgentConfigured(project.agent)) return null;
    const kind = pendingDelivery(project.agent);
    if (!kind) return null;
    if (project.agent.deliveryLeaseUntil > Date.now()) throw new Error("Project agent delivery is in progress");
    const intentRef = db.doc(`${ref.path}/agentState/${kind}Delivery`);
    const intent = (await tx.get(intentRef)).data();
    const startedAt = intent?.startedAt ?? Date.now() - 5_000;
    const leaseId = randomUUID();
    if (!intent) tx.set(intentRef, { startedAt });
    tx.update(ref, { "agent.deliveryLeaseId": leaseId, "agent.deliveryLeaseUntil": Date.now() + 120_000 });
    return { project: project as OnboardingProject, kind, leaseId, startedAt, postAttempted: intent?.postAttempted === true, recoveryBefore: intent?.recoveryBefore };
  });
}

export async function beginDeliveryPost(ref: DocumentReference, claim: DeliveryClaim): Promise<void> {
  await db.runTransaction(async (tx) => {
    const project = (await tx.get(ref)).data();
    if (project?.agent?.deliveryLeaseId !== claim.leaseId || project.agent.deliveryLeaseUntil <= Date.now()) {
      throw new Error("Project delivery lease expired before posting");
    }
    tx.update(ref, { "agent.deliveryLeaseUntil": Date.now() + 120_000 });
    tx.update(db.doc(`${ref.path}/agentState/${claim.kind}Delivery`), { postAttempted: true, startedAt: Date.now() - 5_000, recoveryBefore: FieldValue.delete() });
  });
}

export async function finishProjectDelivery(ref: DocumentReference, claim: DeliveryClaim, patch: Record<string, unknown>): Promise<void> {
  await db.runTransaction(async (tx) => {
    const project = (await tx.get(ref)).data();
    if (project?.agent?.deliveryLeaseId !== claim.leaseId) throw new Error("Project delivery lease was replaced");
    tx.update(ref, { ...patch, "agent.deliveryLeaseId": FieldValue.delete(), "agent.deliveryLeaseUntil": FieldValue.delete() });
  });
}

export async function matchingDeliveryPost(ref: DocumentReference, claim: DeliveryClaim, channelId: string, receipt: string, token: string): Promise<string | null> {
  if (!claim.postAttempted) return null;
  let before = claim.recoveryBefore;
  for (let page = 0; page < 3; page += 1) {
    const cursor = before ? `&before=${encodeURIComponent(before)}` : "";
    const history = await mmApi(`/channels/${channelId}/posts?per_page=100${cursor}`, "GET", undefined, token) as {
      order: string[]; posts: Record<string, { id: string; create_at: number; props?: Record<string, unknown> }>;
    };
    const posts = Object.values(history.posts);
    const match = posts.find((post) => post.props?.octogee_project_delivery === receipt);
    if (match) return match.id;
    if (history.order.length < 100 || posts.some((post) => post.create_at < claim.startedAt)) return null;
    const nextBefore = history.order.at(-1);
    if (!nextBefore || nextBefore === before) throw new Error("Project delivery receipt history did not advance");
    before = nextBefore;
  }
  await db.runTransaction(async (tx) => {
    const project = (await tx.get(ref)).data();
    if (project?.agent?.deliveryLeaseId !== claim.leaseId) throw new Error("Project delivery lease was replaced");
    tx.update(db.doc(`${ref.path}/agentState/${claim.kind}Delivery`), { recoveryBefore: before });
  });
  throw new Error("Project delivery receipt history limit reached; recovery will continue on retry");
}
