import type { FleetBrokerProjectAgent } from "@octogee/shared/types/fleet-broker";
import { createServiceLogger } from "@octogee/shared/server/service-logger";
const logger = createServiceLogger("provisioner");
import type { UserSnapshot } from "./customer-lifecycle.js";
import type { MattermostTokenSecret, SecretsRepository } from "./platform-state/secrets.js";
import { parseAgentModelSelections } from "@octogee/shared/types/agent-models";
import { pickPlanInputs } from "@octogee/shared/types/billing";
import { projectAgentConfigured, projectRepoSourceFromDoc, type ProjectAgentStatus, type ProjectAgentIdentity } from "@octogee/shared/types/project";

type ChannelBinding = UserSnapshot["channels"][number];

export function mapWorkspaceChannelDoc(
  data: Record<string, unknown>,
): ChannelBinding | null {
  const channelId = (data.mattermost as { channelId?: string } | undefined)?.channelId;
  if (!channelId) return null;
  return {
    scope: "workspace",
    kind: (data.kind as string | undefined) ?? "general",
    channelId,
  };
}

export function mapProjectChannelDoc(
  projectId: string,
  data: Record<string, unknown>,
): ChannelBinding | null {
  const channelId = (data.mattermost as { channelId?: string } | undefined)?.channelId;
  if (!channelId) return null;
  return {
    scope: "project",
    projectId,
    kind: (data.kind as string | undefined) ?? "default",
    channelId,
  };
}

class ProjectAgentIdentityError extends Error {}

function projectIdentity(value: unknown): ProjectAgentIdentity | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") throw new ProjectAgentIdentityError("Invalid project agent identity");
  const { name, emoji, persona } = value as Record<string, unknown>;
  if (typeof name !== "string" || !name.trim() || typeof emoji !== "string" || typeof persona !== "string") {
    throw new ProjectAgentIdentityError("Invalid project agent identity");
  }
  return { name, emoji, persona };
}

function projectAgentRuntimeState(value: unknown) {
  const agent = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    ...(agent.identity === undefined ? {} : { identity: projectIdentity(agent.identity) }),
    ...((agent.kickoff as { status?: string } | undefined)?.status === "pending" ||
      (agent.handoff as { status?: string } | undefined)?.status === "pending" ? { deliveryPending: true } : {}),
    activationId: typeof agent.activationId === "string" ? agent.activationId : null,
    status: typeof agent.status === "string" ? agent.status as ProjectAgentStatus : null,
  };
}

function projectAgentArchived(projectData: Record<string, unknown>): boolean {
  const commercialLifecycle = projectData.commercialLifecycle;
  return projectData.status === "archived" || (!!commercialLifecycle &&
    typeof commercialLifecycle === "object" &&
    (commercialLifecycle as { status?: unknown }).status === "archived");
}

export type ProjectAgentCredential = Pick<MattermostTokenSecret, "mattermostUserId" | "personalToken">;

export function mapProjectAgentState(
  projectId: string,
  projectData: Record<string, unknown>,
  credential: ProjectAgentCredential | null,
): FleetBrokerProjectAgent | null {
  const agent = projectData.agent;
  const requestedEnabled = projectAgentConfigured(agent);
  const enabled = requestedEnabled && !projectAgentArchived(projectData);
  const mmUserId = credential?.mattermostUserId || null;
  const token = credential?.personalToken || null;
  if (!enabled && mmUserId === null && token === null) return null;
  try {
    return {
      projectId, enabled, mmUserId, token, ...projectAgentRuntimeState(agent),
      ...(projectRepoSourceFromDoc(projectData.repoSource)?.provider === "github" ? { githubBacked: true } : {}),
    };
  } catch (error) {
    if (!(error instanceof ProjectAgentIdentityError)) throw error;
    logger.error("Project agent identity rejected", { projectId, error: error.message });
    return { projectId, enabled, mmUserId, token, status: "error", activationId: null };
  }
}

interface SnapshotDocSnap {
  id: string;
  data(): Record<string, unknown> | undefined;
}
interface SnapshotDocRef {
  get(): Promise<{ data(): Record<string, unknown> | undefined }>;
  collection(name: string): SnapshotCollectionRef;
}
interface SnapshotCollectionRef {
  doc(id: string): SnapshotDocRef;
  get(): Promise<{ docs: SnapshotDocSnap[] }>;
}
export interface ProjectAgentSnapshotDb {
  collection(name: string): SnapshotCollectionRef;
}

export async function collectProjectAgentStates(
  db: ProjectAgentSnapshotDb,
  secrets: Pick<SecretsRepository, "list">,
  uid: string,
  slug: string,
): Promise<Array<NonNullable<ReturnType<typeof mapProjectAgentState>>>> {
  const [snap, projectSecrets] = await Promise.all([
    db.collection("workspaces").doc(slug).collection("projects").get(),
    secrets.list(uid, "project-agent-mattermost"),
  ]);
  const credentials = new Map(projectSecrets.flatMap((secret) =>
    secret.kind === "connector" || !secret.projectId ? [] : [[secret.projectId, secret] as const]));
  const out: Array<NonNullable<ReturnType<typeof mapProjectAgentState>>> = [];
  const seenProjects = new Set<string>();
  for (const doc of snap.docs) {
    const data = doc.data() ?? {};
    if (data.agent === undefined) continue;
    seenProjects.add(doc.id);
    const state = mapProjectAgentState(doc.id, data, credentials.get(doc.id) ?? null);
    if (state) out.push(state);
  }

  for (const [projectId, credential] of credentials) {
    if (seenProjects.has(projectId)) continue;
    const state = mapProjectAgentState(projectId, {}, credential);
    if (state) out.push(state);
  }
  return out;
}

export function deriveSlug(uid: string, data: Record<string, unknown>): string {
  const oc = (data.provisioning as { openclaw?: Record<string, unknown> } | undefined)?.openclaw;
  const slug = (oc?.slug as string | undefined) ?? (data.username as string | undefined);
  if (!slug) {
    throw new Error(
      `[load:${uid}] cannot derive slug — neither provisioning.openclaw.slug nor users/{uid}.username is set`,
    );
  }
  return slug;
}


function snapshotProvisioning(data: Record<string, unknown>): Pick<
  UserSnapshot,
  "gatewayId" | "status" | "agentIds" | "repoUrl"
> {
  const oc = (data.provisioning as { openclaw?: Record<string, unknown> } | undefined)?.openclaw;
  const git = (data.provisioning as { git?: Record<string, unknown> } | undefined)?.git;
  return {
    gatewayId: (oc?.gatewayId as string | undefined) ?? "",
    status: ((oc?.status as string | undefined) ?? "") as UserSnapshot["status"],
    agentIds: (oc?.agentIds as string[] | undefined) ?? [],
    repoUrl: (git?.repoUrl as string | undefined) ?? "",
  };
}

function snapshotIdentity(
  data: Record<string, unknown>,
  slug: string,
): Pick<UserSnapshot, "tier" | "mattermostUserId" | "ownerName"> {
  return {
    tier:
      (data.tier as string | undefined) ??
      (data.subscription as { tier?: string } | undefined)?.tier ??
      "trial",
    mattermostUserId:
      (data.mattermost as { userId?: string } | undefined)?.userId ?? null,
    ownerName:
      (data.displayName as string | undefined) ??
      (data.username as string | undefined) ??
      slug,
  };
}

type SnapshotSystemConfig = NonNullable<UserSnapshot["systemConfig"]>;

export interface ByotSnapshotProjection {
  byotActive: boolean | null;
  systemConfig?: SnapshotSystemConfig;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function byotSystemConfigFromRecord(
  credential: Record<string, unknown>,
): SnapshotSystemConfig | undefined {
  const out: { provider?: string; baseUrl?: string; model?: string } = {};
  if (typeof credential.provider === "string") out.provider = credential.provider;
  if (typeof credential.baseUrl === "string") out.baseUrl = credential.baseUrl;
  if (typeof credential.model === "string") out.model = credential.model;
  return Object.keys(out).length > 0 ? { byot: out } : undefined;
}

// Per-agent model picks travel with the snapshot no matter the credential
// state — a plain platform customer's picker choices must survive pod rolls too.
function withAgentModels(
  sysData: Record<string, unknown> | undefined,
  systemConfig: SnapshotSystemConfig | undefined,
): SnapshotSystemConfig | undefined {
  const agentModels = parseAgentModelSelections(sysData?.agentModels);
  if (Object.keys(agentModels).length === 0) return systemConfig;
  return { ...(systemConfig ?? {}), agentModels };
}

export function byotSnapshotProjectionFromSystemConfig(
  sysData: Record<string, unknown> | undefined,
): ByotSnapshotProjection {
  const modelCredential = objectRecord(sysData?.modelCredential);
  if (modelCredential) {
    const byotConfig = modelCredential.active === true
      ? byotSystemConfigFromRecord(modelCredential)
      : undefined;
    const systemConfig = withAgentModels(sysData, byotConfig);
    return {
      byotActive: byotConfig !== undefined,
      ...(systemConfig ? { systemConfig } : {}),
    };
  }

  const byot = objectRecord(sysData?.byot);
  const systemConfig = withAgentModels(
    sysData,
    byot ? byotSystemConfigFromRecord(byot) : undefined,
  );
  return {
    byotActive: null,
    ...(systemConfig ? { systemConfig } : {}),
  };
}

// Project a users/{uid}/system/config doc down to the byot fields the mount-time
// re-assert needs. Returns undefined when there is nothing usable so the snapshot stays
// lean; deriveDesiredByotState then defaults the provider to anthropic for an active BYOT.
export function byotSystemConfigFromDoc(
  sysData: Record<string, unknown> | undefined,
): UserSnapshot["systemConfig"] {
  return byotSnapshotProjectionFromSystemConfig(sysData).systemConfig;
}

export function mapUserDocToSnapshot(
  uid: string,
  data: Record<string, unknown>,
  channels: UserSnapshot["channels"],
): UserSnapshot {
  const slug = deriveSlug(uid, data);
  return {
    uid,
    slug,
    channels,
    byotActive: Boolean(data.byotActive),
    ...snapshotIdentity(data, slug),
    ...snapshotProvisioning(data),
    ...pickPlanInputs(data),
  };
}
