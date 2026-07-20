

import type { Firestore } from "firebase-admin/firestore";
import { SYSTEM_CONFIG_REPO, WORKSPACE_REPO } from "@octogee/core/gitea-naming";
import type { CustomerCleanupContext } from "../../handlers/deprovision-customer.js";
import {
  byosubSecretNameForUser,
  MODEL_CREDENTIAL_SUBSCRIPTION_PROVIDER_IDS,
  resolveUserByosubCredentialRefs,
} from "@octogee/shared/types/model-credentials";

export interface ContextDeps {
  db: Firestore;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function normalizedEmail(v: unknown): string | null {
  const email = asString(v)?.trim().toLowerCase() ?? "";
  return email.length > 0 ? email : null;
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
  const out: string[] = [WORKSPACE_REPO, SYSTEM_CONFIG_REPO];
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

async function resolveCredentialSecretNames(
  db: Firestore,
  uid: string,
): Promise<string[]> {
  const [configSnap, integrationSnap] = await Promise.all([
    db.doc(`users/${uid}/system/config`).get(),
    db.doc(`users/${uid}/integrations/byosub`).get(),
  ]);
  const config = configSnap.data() as Record<string, unknown> | undefined;
  const modelCredential = config?.modelCredential as Record<string, unknown> | undefined;
  const configured = asString(modelCredential?.secretName);
  const byosub = resolveUserByosubCredentialRefs(uid, integrationSnap.data());
  if (byosub.skipped.length > 0) {
    throw new Error(`credential cleanup context invalid: ${byosub.skipped.join("; ")}`);
  }
  return Array.from(new Set([
    ...(configured ? [configured] : []),
    ...byosub.refs.map((ref) => ref.secretName),
    ...MODEL_CREDENTIAL_SUBSCRIPTION_PROVIDER_IDS.map((provider) => {
      const secretName = byosubSecretNameForUser(uid, provider);
      if (!secretName) throw new Error(`credential cleanup context invalid uid: ${uid}`);
      return secretName;
    }),
  ])).sort();
}

async function resolveProjectAgentCleanup(
  db: Firestore,
  uid: string,
): Promise<{
  projectAgentMmUserIds: string[];
  projectAgentCredentialDocPaths: string[];
}> {
  const secrets = await db.collection(`users/${uid}/secrets`).get();
  const projectAgentDocs = secrets.docs.filter((doc) =>
    doc.id.startsWith("projectAgentMattermost-"));
  return {
    projectAgentMmUserIds: projectAgentDocs
      .map((doc) => asString((doc.data() as Record<string, unknown>).mmUserId))
      .filter((value): value is string => value !== null)
      .sort(),
    projectAgentCredentialDocPaths: projectAgentDocs
      .map((doc) => `users/${uid}/secrets/${doc.id}`)
      .sort(),
  };
}

async function resolveChatArtifactIds(
  db: Firestore,
  uid: string,
  slug: string,
): Promise<string[]> {
  const jobs = db.collection("chatArtifactJobs");
  const snapshots = await Promise.all([
    jobs.where("ownerUid", "==", uid).get(),
    ...(slug ? [jobs.where("workspaceSlug", "==", slug).get()] : []),
  ]);
  const ids = snapshots.flatMap((snapshot) => snapshot.docs).map((doc) => {
    const artifactId = asString((doc.data() as Record<string, unknown>).artifactId);
    if (!artifactId || !/^[a-f0-9]{64}$/.test(artifactId)) {
      throw new Error(`chat artifact cleanup context invalid: ${doc.ref.path}`);
    }
    return artifactId;
  });
  return Array.from(new Set(ids)).sort();
}

async function resolveAgentImportIds(db: Firestore, uid: string): Promise<string[]> {
  const snapshot = await db.collection("agentImports").where("uid", "==", uid).get();
  return snapshot.docs.map((doc) => {
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(doc.id)) {
      throw new Error(`agent import cleanup context invalid: ${doc.id}`);
    }
    return doc.id;
  }).sort();
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

  const [
    workspaceTeamId,
    mmCoachUserId,
    adminChannelId,
    repoNames,
    projectSlugs,
    credentialSecretNames,
    projectAgentCleanup,
    chatArtifactIds,
    agentImportIds,
  ] =
    await Promise.all([
      resolveWorkspaceTeamId(deps.db, slug),
      resolveCoachMmUserId(deps.db, uid),
      resolveAdminChannelId(deps.db, slug),
      resolveRepoNames(deps.db, slug),
      resolveProjectSlugs(deps.db, slug),
      resolveCredentialSecretNames(deps.db, uid),
      resolveProjectAgentCleanup(deps.db, uid),
      resolveChatArtifactIds(deps.db, uid, slug),
      resolveAgentImportIds(deps.db, uid),
    ]);

  return {
    uid,
    slug,
    email: normalizedEmail(userData.email),
    giteaOrg: slug,
    repoNames,
    projectSlugs,
    workspaceTeamId,
    mmUserId: readMmUserId(userData),
    mmCoachUserId,
    adminChannelId,
    currentGatewayId: gatewayId,
    credentialSecretNames,
    ...projectAgentCleanup,
    chatArtifactIds,
    agentImportIds,
  };
}
