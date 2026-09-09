import type { UserSnapshot } from "./customer-lifecycle.js";
import { projectAgentSecretDocId } from "./mattermost/project-agent.js";
import { parseAgentModelSelections } from "@octogee/shared/types/agent-models";
import { pickPlanInputs } from "@octogee/shared/types/billing";
import { projectAgentEnabled, type ProjectAgentStatus, type ProjectAgentIdentity } from "@octogee/shared/types/project";

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

// Vegas: project-agent state for the snapshot. Null when the project has no
// agent state at all (never enabled, nothing minted) so snapshots stay lean;
// a disabled-with-secret entry survives so the reconcile can retire it.
export function mapProjectAgentState(
  projectId: string,
  projectData: Record<string, unknown>,
  secretData: Record<string, unknown> | undefined,
): ({ projectId: string; enabled: boolean; mmUserId: string | null; token: string | null } & ReturnType<typeof projectAgentRuntimeState>) | null {
  const agent = projectData.agent;
  const requestedEnabled = projectAgentEnabled(agent);
  const commercialLifecycle = projectData.commercialLifecycle;
  const archived =
    !!commercialLifecycle &&
    typeof commercialLifecycle === "object" &&
    (commercialLifecycle as { status?: unknown }).status === "archived";
  const enabled = requestedEnabled && !archived;
  const mmUserId =
    typeof secretData?.mmUserId === "string" && secretData.mmUserId ? secretData.mmUserId : null;
  const token =
    typeof secretData?.personalToken === "string" && secretData.personalToken
      ? secretData.personalToken
      : null;
  if (!enabled && mmUserId === null && token === null) return null;
  try {
    return { projectId, enabled, mmUserId, token, ...projectAgentRuntimeState(agent) };
  } catch (error) {
    if (!(error instanceof ProjectAgentIdentityError)) throw error;
    console.error("Project agent identity rejected", { projectId, error: error.message });
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

// Vegas: collect per-project agent states for a snapshot. The secret is read
// only for projects whose doc carries an agent field — untouched projects
// cost no extra reads and can have no lingering secret to retire.
const PROJECT_AGENT_SECRET_PREFIX = projectAgentSecretDocId("");

export async function collectProjectAgentStates(
  db: ProjectAgentSnapshotDb,
  uid: string,
  slug: string,
): Promise<Array<NonNullable<ReturnType<typeof mapProjectAgentState>>>> {
  const snap = await db.collection("workspaces").doc(slug).collection("projects").get();
  const out: Array<NonNullable<ReturnType<typeof mapProjectAgentState>>> = [];
  const seenProjects = new Set<string>();
  for (const doc of snap.docs) {
    const data = doc.data() ?? {};
    if (data.agent === undefined) continue;
    seenProjects.add(doc.id);
    const secretSnap = await db
      .collection("users").doc(uid)
      .collection("secrets").doc(projectAgentSecretDocId(doc.id))
      .get();
    const state = mapProjectAgentState(doc.id, data, secretSnap.data());
    if (state) out.push(state);
  }

  // Deleting a project removes the doc that carries the agent flag — the
  // lingering secret is then the only retire trigger left. Surface each
  // orphaned projectAgentMattermost-* secret as a retire-pending state.
  const secretsSnap = await db.collection("users").doc(uid).collection("secrets").get();
  for (const doc of secretsSnap.docs) {
    if (!doc.id.startsWith(PROJECT_AGENT_SECRET_PREFIX)) continue;
    const projectId = doc.id.slice(PROJECT_AGENT_SECRET_PREFIX.length);
    if (!projectId || seenProjects.has(projectId)) continue;
    const state = mapProjectAgentState(projectId, {}, doc.data());
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
  "gatewayId" | "status" | "agentIds" | "repoUrl" | "greetingPosted"
> {
  const oc = (data.provisioning as { openclaw?: Record<string, unknown> } | undefined)?.openclaw;
  const git = (data.provisioning as { git?: Record<string, unknown> } | undefined)?.git;
  return {
    gatewayId: (oc?.gatewayId as string | undefined) ?? "",
    status: ((oc?.status as string | undefined) ?? "") as UserSnapshot["status"],
    agentIds: (oc?.agentIds as string[] | undefined) ?? [],
    repoUrl: (git?.repoUrl as string | undefined) ?? "",
    greetingPosted: Boolean((oc?.greeting as { ok?: boolean } | undefined)?.ok),
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
