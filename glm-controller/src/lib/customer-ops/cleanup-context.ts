import type { Firestore } from "firebase-admin/firestore";
import type { BuilderAccountReader } from "@octogee/core/builder-account";
import { SYSTEM_CONFIG_REPO, WORKSPACE_REPO } from "@octogee/core/gitea-naming";
import type { PlatformStateStore } from "@octogee/core/platform-state";
import type { CustomerCleanupContext } from "../../handlers/deprovision-customer.js";
import {
  MODEL_CREDENTIAL_STATIC_PROVIDER_IDS,
  byosubSecretNameForUser,
  MODEL_CREDENTIAL_SUBSCRIPTION_PROVIDER_IDS,
  resolveUserByosubCredentialRefs,
} from "@octogee/shared/types/model-credentials";

export interface ContextDeps {
  store: PlatformStateStore;
  accounts: BuilderAccountReader;
  db: Pick<Firestore, "collection" | "doc">;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function normalizedEmail(v: unknown): string | null {
  const email = asString(v)?.trim().toLowerCase() ?? "";
  return email.length > 0 ? email : null;
}

async function resolveWorkspaceTeamId(store: PlatformStateStore, slug: string): Promise<string | null> {
  if (!slug) return null;
  return asString((await store.workspaces.records.get(slug))?.mattermostTeamId);
}

async function resolveCoachMmUserId(store: PlatformStateStore, uid: string): Promise<string | null> {
  return asString((await store.workspaces.agentIdentities.get(uid))?.mattermostUserId);
}

async function resolveAdminChannelId(store: PlatformStateStore, slug: string): Promise<string | null> {
  if (!slug) return null;
  const channel = await store.workspaces.channels.get({ workspaceSlug: slug, projectSlug: null }, "admin");
  return asString(channel?.mattermostChannelId);
}

async function resolveProjects(
  store: PlatformStateStore,
  slug: string,
): Promise<{ repoNames: string[]; projectSlugs: string[] }> {
  if (!slug) return { repoNames: [], projectSlugs: [] };
  const projects = await store.workspaces.projects.list(slug);
  return {
    repoNames: [
      WORKSPACE_REPO,
      SYSTEM_CONFIG_REPO,
      ...projects.map((project) => asString(project.giteaRepoName) ?? project.projectSlug),
    ],
    projectSlugs: projects.map((project) => project.projectSlug).sort(),
  };
}

async function resolveCredentialSecretNames(
  db: ContextDeps["db"],
  uid: string,
  slug: string,
): Promise<string[]> {
  const integrationSnap = await db.doc(`users/${uid}/integrations/byosub`).get();
  const byosub = resolveUserByosubCredentialRefs(uid, integrationSnap.data());
  if (byosub.skipped.length > 0) {
    throw new Error(`credential cleanup context invalid: ${byosub.skipped.join("; ")}`);
  }
  return Array.from(new Set([
    ...(slug ? MODEL_CREDENTIAL_STATIC_PROVIDER_IDS.map(
      (provider) => `byok-${slug}-${provider}`,
    ) : []),
    ...byosub.refs.map((ref) => ref.secretName),
    ...MODEL_CREDENTIAL_SUBSCRIPTION_PROVIDER_IDS.map((provider) => {
      const secretName = byosubSecretNameForUser(uid, provider);
      if (!secretName) throw new Error(`credential cleanup context invalid uid: ${uid}`);
      return secretName;
    }),
  ])).sort();
}

async function resolveProjectAgentCleanup(
  store: PlatformStateStore,
  uid: string,
): Promise<{
  projectAgentMmUserIds: string[];
  projectAgentCredentialDocPaths: string[];
}> {
  const secrets = await store.secrets.list(uid, "project-agent-mattermost");
  return {
    projectAgentMmUserIds: secrets
      .map((secret) => secret.kind === "connector" ? null : asString(secret.mattermostUserId))
      .filter((value): value is string => value !== null)
      .sort(),
    projectAgentCredentialDocPaths: secrets
      .map((secret) => `users/${uid}/secrets/${secret.secretId}`)
      .sort(),
  };
}

async function resolveChatArtifactIds(
  db: ContextDeps["db"],
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

async function resolveAgentImportIds(store: ContextDeps["store"], uid: string): Promise<string[]> {
  const imports = await store.jobs.agentImports.listForUid(uid);
  return imports.map(({ importId }) => {
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(importId)) {
      throw new Error(`agent import cleanup context invalid: ${importId}`);
    }
    return importId;
  }).sort();
}

export async function loadCustomerCleanupContext(
  deps: ContextDeps,
  uid: string,
): Promise<CustomerCleanupContext | null> {
  const builder = await deps.store.builders.records.get(uid);
  if (builder === null) return null;
  const slug = builder.slug ?? "";

  const [
    account,
    workspaceTeamId,
    mmCoachUserId,
    adminChannelId,
    projects,
    credentialSecretNames,
    projectAgentCleanup,
    chatArtifactIds,
    agentImportIds,
  ] =
    await Promise.all([
      deps.accounts.get(uid),
      resolveWorkspaceTeamId(deps.store, slug),
      resolveCoachMmUserId(deps.store, uid),
      resolveAdminChannelId(deps.store, slug),
      resolveProjects(deps.store, slug),
      resolveCredentialSecretNames(deps.db, uid, slug),
      resolveProjectAgentCleanup(deps.store, uid),
      resolveChatArtifactIds(deps.db, uid, slug),
      resolveAgentImportIds(deps.store, uid),
    ]);

  return {
    uid,
    slug,
    email: normalizedEmail(account?.email),
    giteaOrg: slug,
    ...projects,
    workspaceTeamId,
    mmUserId: asString(builder.mattermostUserId),
    mmCoachUserId,
    adminChannelId,
    currentGatewayId: builder.gateway?.gatewayId ?? null,
    credentialSecretNames,
    ...projectAgentCleanup,
    chatArtifactIds,
    agentImportIds,
  };
}
