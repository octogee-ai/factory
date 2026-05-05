// Resolves the cleanup context for a uid by reading user / workspace /
// agent / project docs from Firestore. Extracted from the index.ts
// wiring layer so it's directly testable (review-agent feedback) and
// each resolution path is a small focused function.

import type { Firestore } from "firebase-admin/firestore";
import type { CustomerCleanupContext } from "../../handlers/deprovision-customer.js";

export interface ContextDeps {
  db: Firestore;
  giteaOrg: string;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function readMmUserId(data: Record<string, unknown> | undefined): string | null {
  if (!data) return null;
  const mm = data.mattermost as Record<string, unknown> | undefined;
  return asString(mm?.userId);
}

function readMmTeamId(data: Record<string, unknown> | undefined): string | null {
  if (!data) return null;
  const mm = data.mattermost as Record<string, unknown> | undefined;
  return asString(mm?.teamId);
}

function readMmChannelId(data: Record<string, unknown> | undefined): string | null {
  if (!data) return null;
  const mm = data.mattermost as Record<string, unknown> | undefined;
  return asString(mm?.channelId);
}

function resolveSlug(userData: Record<string, unknown>): string {
  const provisioning = (userData.provisioning as Record<string, unknown> | undefined) ?? {};
  const openclaw = (provisioning.openclaw as Record<string, unknown> | undefined) ?? {};
  const openclawSlug = asString(openclaw.slug);
  if (openclawSlug) return openclawSlug;
  const username = asString(userData.username);
  return username ?? "";
}

function resolveGatewayId(userData: Record<string, unknown>): string | null {
  const provisioning = (userData.provisioning as Record<string, unknown> | undefined) ?? {};
  const openclaw = (provisioning.openclaw as Record<string, unknown> | undefined) ?? {};
  return asString(openclaw.gatewayId);
}

async function resolveWorkspaceTeamId(db: Firestore, slug: string): Promise<string | null> {
  if (!slug) return null;
  const wsDoc = await db.collection("workspaces").doc(slug).get();
  if (!wsDoc.exists) return null;
  return readMmTeamId(wsDoc.data() as Record<string, unknown>);
}

async function resolveCoachMmUserId(db: Firestore, uid: string): Promise<string | null> {
  const agentDoc = await db.collection("agents").doc(uid).get();
  if (!agentDoc.exists) return null;
  return readMmUserId(agentDoc.data() as Record<string, unknown>);
}

async function resolveAdminChannelId(db: Firestore, slug: string): Promise<string | null> {
  if (!slug) return null;
  const adminDoc = await db.doc(`workspaces/${slug}/channels/admin`).get();
  if (!adminDoc.exists) return null;
  return readMmChannelId(adminDoc.data() as Record<string, unknown>);
}

function resolveProjectRepoName(
  workspaceSlug: string,
  projDoc: { id: string; data: () => unknown },
): string {
  const projData = (projDoc.data() ?? {}) as Record<string, unknown>;
  // Project docs persist `giteaRepoName` when created via the
  // workspace-api project flow — that's the canonical name to delete.
  // Fallback constructs `<workspaceSlug>-proj-<projectSlug>` matching
  // the same flow's naming convention. The earlier `<slug>-<projSlug>`
  // shape would orphan project repos. (Copilot review)
  const persisted = asString(projData.giteaRepoName);
  if (persisted) return persisted;
  const projSlug =
    asString(projData.slug) ?? asString(projData.projectSlug) ?? projDoc.id;
  return `${workspaceSlug}-proj-${projSlug}`;
}

async function resolveRepoNames(db: Firestore, slug: string): Promise<string[]> {
  if (!slug) return [];
  const out: string[] = [`${slug}-workspace`];
  const projectsSnap = await db.collection(`workspaces/${slug}/projects`).get();
  for (const projDoc of projectsSnap.docs) {
    out.push(resolveProjectRepoName(slug, projDoc));
  }
  return out;
}

export async function loadCustomerCleanupContext(
  deps: ContextDeps,
  uid: string,
): Promise<CustomerCleanupContext | null> {
  const userDoc = await deps.db.collection("users").doc(uid).get();
  if (!userDoc.exists) return null;
  const userData = userDoc.data() as Record<string, unknown>;
  const slug = resolveSlug(userData);
  const gatewayId = resolveGatewayId(userData);

  const [workspaceTeamId, mmCoachUserId, adminChannelId, repoNames] = await Promise.all([
    resolveWorkspaceTeamId(deps.db, slug),
    resolveCoachMmUserId(deps.db, uid),
    resolveAdminChannelId(deps.db, slug),
    resolveRepoNames(deps.db, slug),
  ]);

  return {
    uid,
    slug,
    email: asString(userData.email),
    giteaOrg: deps.giteaOrg,
    repoNames,
    workspaceTeamId,
    mmUserId: readMmUserId(userData),
    mmCoachUserId,
    adminChannelId,
    currentGatewayId: gatewayId,
  };
}
