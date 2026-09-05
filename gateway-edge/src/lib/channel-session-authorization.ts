import {
  projectAgentId,
  USERNAME_RE,
  workspaceCoachAgentId,
} from "@octogee/shared/types/identity";
import { projectAgentEnabled } from "@octogee/shared/types/project";

import {
  ChannelSessionMattermostError,
  createChannelSessionMattermostClient,
} from "./channel-session-model-control.js";
import { db } from "./db.js";
import { resolveWorkspaceUid } from "./workspace-resolution.js";

const MATTERMOST_ID = /^[a-z0-9]{26}$/;
const MAX_WORKSPACE_CHANNEL_CANDIDATES = 512;
const PROJECT_CHANNEL_DISCOVERY_CONCURRENCY = 8;

export interface ChannelTarget {
  ownerUid: string;
  workspaceSlug: string;
  projectId?: string;
  agentId: string;
  agentMmUserId: string;
}

interface ChannelScope {
  workspaceSlug: string;
  projectId?: string;
}

export type ChannelSessionMattermostClient = ReturnType<
  typeof createChannelSessionMattermostClient
>;

export interface AuthorizedChannel {
  forbidden: false;
  target: ChannelTarget;
  client: ChannelSessionMattermostClient;
  callerMmUserId: string;
}

export interface ForbiddenChannel {
  forbidden: true;
}

export interface WorkspaceChannelCandidate {
  channelId: string;
}

export interface ChannelAuthorizationOptions {
  requireActiveLedger?: boolean;
  signal?: AbortSignal;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

async function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return await new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      },
    );
  });
}

function discoverableChannelId(
  id: string,
  value: FirebaseFirestore.DocumentData | undefined,
  lane: "workspace" | "project",
): string | null {
  const data = record(value);
  if (!data || data.archivedAt !== undefined && data.archivedAt !== null) return null;
  if (lane === "workspace" && (id === "admin" || id === "coach-dm")) return null;
  const expectedKind = id === "general" ? "general" : "session";
  if (data.kind !== expectedKind) {
    throw new ChannelSessionMattermostError("Workspace channel ledger was invalid");
  }
  const channelId = record(data.mattermost)?.channelId;
  if (typeof channelId !== "string" || !MATTERMOST_ID.test(channelId)) {
    throw new ChannelSessionMattermostError("Workspace channel ledger was invalid");
  }
  return channelId;
}

export async function listWorkspaceChannelCandidates(
  workspaceSlug: string,
  signal?: AbortSignal,
): Promise<WorkspaceChannelCandidate[]> {
  if (!USERNAME_RE.test(workspaceSlug)) {
    throw new ChannelSessionMattermostError("Workspace channel scope was invalid");
  }
  const workspace = db.doc(`workspaces/${workspaceSlug}`);
  const [workspaceChannels, projects] = await abortable(Promise.all([
    workspace.collection("channels").limit(MAX_WORKSPACE_CHANNEL_CANDIDATES + 1).get(),
    workspace.collection("projects").limit(MAX_WORKSPACE_CHANNEL_CANDIDATES + 1).get(),
  ]), signal);
  if (
    workspaceChannels.docs.length > MAX_WORKSPACE_CHANNEL_CANDIDATES ||
    projects.docs.length > MAX_WORKSPACE_CHANNEL_CANDIDATES
  ) {
    throw new ChannelSessionMattermostError("Workspace channel directory exceeded its limit");
  }
  const activeProjects = projects.docs.filter((project) => {
    const lifecycle = record(record(project.data())?.commercialLifecycle)?.status;
    return lifecycle !== "archived";
  });
  const channelIds: string[] = [];
  for (const channel of workspaceChannels.docs) {
    const channelId = discoverableChannelId(channel.id, channel.data(), "workspace");
    if (channelId) channelIds.push(channelId);
  }
  for (
    let offset = 0;
    offset < activeProjects.length;
    offset += PROJECT_CHANNEL_DISCOVERY_CONCURRENCY
  ) {
    signal?.throwIfAborted();
    const reads = activeProjects
      .slice(offset, offset + PROJECT_CHANNEL_DISCOVERY_CONCURRENCY)
      .map((project) => project.ref.collection("channels")
        .limit(MAX_WORKSPACE_CHANNEL_CANDIDATES + 1)
        .get());
    for (const snapshot of await abortable(Promise.all(reads), signal)) {
      if (channelIds.length + snapshot.docs.length > MAX_WORKSPACE_CHANNEL_CANDIDATES) {
        throw new ChannelSessionMattermostError("Workspace channel directory exceeded its limit");
      }
      for (const channel of snapshot.docs) {
        const channelId = discoverableChannelId(channel.id, channel.data(), "project");
        if (channelId) channelIds.push(channelId);
      }
    }
  }
  if (new Set(channelIds).size !== channelIds.length) {
    throw new ChannelSessionMattermostError("Workspace channel directory was ambiguous");
  }
  return channelIds.sort().map((channelId) => ({ channelId }));
}

function pathScope(path: string): ChannelScope | null {
  const parts = path.split("/");
  if (
    parts.length === 4 &&
    parts[0] === "workspaces" &&
    parts[2] === "channels"
  ) {
    return { workspaceSlug: parts[1] };
  }
  if (
    parts.length === 6 &&
    parts[0] === "workspaces" &&
    parts[2] === "projects" &&
    parts[4] === "channels"
  ) {
    return { workspaceSlug: parts[1], projectId: parts[3] };
  }
  return null;
}

function activeProjectAgentMmUserId(
  projectData: FirebaseFirestore.DocumentData | undefined,
  credential: FirebaseFirestore.DocumentData | undefined,
): string | null {
  if (!projectAgentEnabled(projectData?.agent)) return null;
  if (
    typeof credential?.mmUserId !== "string" ||
    !MATTERMOST_ID.test(credential.mmUserId)
  ) {
    return null;
  }
  if (
    typeof credential.personalToken !== "string" ||
    !credential.personalToken
  ) {
    return null;
  }
  return credential.mmUserId;
}

async function resolveProjectTarget(
  scope: ChannelScope,
  ownerUid: string,
  requireActiveLedger: boolean,
  signal?: AbortSignal,
): Promise<{ archived: boolean; target: ChannelTarget | null }> {
  if (!scope.projectId) return { archived: false, target: null };
  const [project, secret] = await abortable(Promise.all([
    db.doc(`workspaces/${scope.workspaceSlug}/projects/${scope.projectId}`).get(),
    db
      .doc(
        `users/${ownerUid}/secrets/projectAgentMattermost-${scope.projectId}`,
      )
      .get(),
  ]), signal);
  if (
    requireActiveLedger &&
    record(record(project.data())?.commercialLifecycle)?.status === "archived"
  ) {
    return { archived: true, target: null };
  }
  const agentMmUserId = activeProjectAgentMmUserId(
    project.data(),
    secret.data(),
  );
  if (!agentMmUserId) return { archived: false, target: null };
  return {
    archived: false,
    target: {
      ...scope,
      ownerUid,
      agentId: projectAgentId(scope.workspaceSlug, scope.projectId),
      agentMmUserId,
    },
  };
}

async function resolveCoachTarget(
  scope: ChannelScope,
  ownerUid: string,
  signal?: AbortSignal,
): Promise<ChannelTarget | null> {
  const coachSecret = await abortable(db
    .doc(`users/${ownerUid}/secrets/coachMattermost`)
    .get(), signal);
  const agentMmUserId = coachSecret.data()?.coachMmUserId;
  if (
    typeof agentMmUserId !== "string" ||
    !MATTERMOST_ID.test(agentMmUserId)
  ) {
    return null;
  }
  return {
    ...scope,
    ownerUid,
    agentId: workspaceCoachAgentId(scope.workspaceSlug),
    agentMmUserId,
  };
}

async function resolveTarget(
  channelId: string,
  expectedWorkspaceSlug: string | undefined,
  options: ChannelAuthorizationOptions,
): Promise<ChannelTarget | null> {
  const channels = await abortable(db
    .collectionGroup("channels")
    .where("mattermost.channelId", "==", channelId)
    .limit(2)
    .get(), options.signal);
  if (channels.docs.length !== 1) return null;
  const channel = channels.docs[0];
  const scope = pathScope(channel.ref.path);
  if (!scope) return null;
  if (
    expectedWorkspaceSlug !== undefined &&
    scope.workspaceSlug !== expectedWorkspaceSlug
  ) {
    return null;
  }
  if (
    options.requireActiveLedger &&
    discoverableChannelId(
      channel.id,
      channel.data(),
      scope.projectId ? "project" : "workspace",
    ) !== channelId
  ) {
    return null;
  }
  const ownerUid = await abortable(resolveWorkspaceUid(scope.workspaceSlug), options.signal);
  if (!ownerUid) return null;
  if (scope.projectId) {
    const project = await resolveProjectTarget(
      scope,
      ownerUid,
      options.requireActiveLedger === true,
      options.signal,
    );
    if (project.archived) return null;
    return project.target ?? resolveCoachTarget(scope, ownerUid, options.signal);
  }
  return resolveCoachTarget(scope, ownerUid, options.signal);
}

async function callerCredentials(
  uid: string,
  signal?: AbortSignal,
): Promise<{ storedUserId: string; token: string } | null> {
  const [user, secret] = await abortable(Promise.all([
    db.doc(`users/${uid}`).get(),
    db.doc(`users/${uid}/secrets/mattermost`).get(),
  ]), signal);
  const storedUserId = user.data()?.mattermost?.userId;
  const token = secret.data()?.personalToken;
  return typeof storedUserId === "string" &&
    MATTERMOST_ID.test(storedUserId) &&
    typeof token === "string"
    ? { storedUserId, token }
    : null;
}

export async function authorizeChannelCredentials(
  uid: string,
  channelId: string,
  expectedWorkspaceSlug?: string,
  options: ChannelAuthorizationOptions = {},
): Promise<AuthorizedChannelCredentials | ForbiddenChannel | null> {
  const [target, credentials] = await abortable(Promise.all([
    resolveTarget(channelId, expectedWorkspaceSlug, options),
    callerCredentials(uid, options.signal),
  ]), options.signal);
  if (
    !target ||
    !credentials ||
    (expectedWorkspaceSlug !== undefined &&
      target.workspaceSlug !== expectedWorkspaceSlug)
  ) {
    return null;
  }
  const client = createChannelSessionMattermostClient({
    baseUrl: process.env.MM_INTERNAL_URL ?? "",
    token: credentials.token,
    signal: options.signal,
  });
  const liveUserId = await client.getCurrentUserId();
  if (liveUserId !== credentials.storedUserId) {
    return { forbidden: true as const };
  }
  try {
    await client.getJson(["channels", channelId, "members", liveUserId]);
  } catch (error) {
    if (
      error instanceof ChannelSessionMattermostError &&
      (error.status === 403 || error.status === 404)
    ) {
      return { forbidden: true as const };
    }
    throw error;
  }
  return {
    forbidden: false as const,
    target,
    token: credentials.token,
    callerMmUserId: liveUserId,
  };
}

export interface AuthorizedChannelCredentials extends Omit<AuthorizedChannel, "client"> {
  token: string;
}

export async function authorizeChannel(
  uid: string,
  channelId: string,
  expectedWorkspaceSlug?: string,
  options: ChannelAuthorizationOptions = {},
): Promise<AuthorizedChannel | ForbiddenChannel | null> {
  const access = await authorizeChannelCredentials(uid, channelId, expectedWorkspaceSlug, options);
  if (!access || access.forbidden) return access;
  return {
    forbidden: false,
    target: access.target,
    callerMmUserId: access.callerMmUserId,
    client: createChannelSessionMattermostClient({
      baseUrl: process.env.MM_INTERNAL_URL ?? "",
      token: access.token,
      signal: options.signal,
    }),
  };
}
