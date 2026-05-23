

import type { Firestore } from "firebase-admin/firestore";
import type { CustomerCleanupContext } from "../../handlers/deprovision-customer.js";

export interface ContextDeps {
  db: Firestore;
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
  projDoc: { id: string; data: () => unknown },
): string {
  const projData = (projDoc.data() ?? {}) as Record<string, unknown>;

const persisted = asString(projData.giteaRepoName);
  if (persisted) return persisted;
  return (
    asString(projData.slug) ?? asString(projData.projectSlug) ?? projDoc.id
  );
}

async function resolveRepoNames(db: Firestore, slug: string): Promise<string[]> {
  if (!slug) return [];
  const out: string[] = ["workspace"];
  const projectsSnap = await db.collection(`workspaces/${slug}/projects`).get();
  for (const projDoc of projectsSnap.docs) {
    out.push(resolveProjectRepoName(projDoc));
  }
  return out;
}

async function resolveProjectSlugs(db: Firestore, slug: string): Promise<string[]> {
  if (!slug) return [];
  const projectsSnap = await db.collection(`workspaces/${slug}/projects`).get();
  const slugs: string[] = [];
  for (const projDoc of projectsSnap.docs) {
    const projData = (projDoc.data() ?? {}) as Record<string, unknown>;
    const projSlug =
      asString(projData.slug) ?? asString(projData.projectSlug) ?? projDoc.id;
    slugs.push(projSlug);
  }
  return slugs.sort();
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

  const [workspaceTeamId, mmCoachUserId, adminChannelId, repoNames, projectSlugs] =
    await Promise.all([
      resolveWorkspaceTeamId(deps.db, slug),
      resolveCoachMmUserId(deps.db, uid),
      resolveAdminChannelId(deps.db, slug),
      resolveRepoNames(deps.db, slug),
      resolveProjectSlugs(deps.db, slug),
    ]);

  return {
    uid,
    slug,
    email: asString(userData.email),
    giteaOrg: slug,
    repoNames,
    projectSlugs,
    workspaceTeamId,
    mmUserId: readMmUserId(userData),
    mmCoachUserId,
    adminChannelId,
    currentGatewayId: gatewayId,
  };
}
