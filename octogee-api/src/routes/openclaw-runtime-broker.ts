import { Router, type Request, type Response } from "express";
import type { Firestore, Transaction } from "firebase-admin/firestore";
import { accountAllowsInteractiveAccess } from "@octogee/shared/types/account-lifecycle";
import { resolveCommercialEntitlements } from "@octogee/shared/types/commercial-entitlements";

import {
  isValidCustomChannelName,
  isValidProjectId,
  isValidUsername,
  parseAgentId,
  projectChannelName,
  projectGeneralChannelName,
  workspaceCoachChannelName,
  workspaceCustomChannelName,
  workspaceGeneralChannelName,
  type ParsedAgentId,
} from "@octogee/shared/types/identity";
import { projectGatewayDesiredRootForGateway } from "@octogee/shared/types/gateway-releases";
import { projectAgentSecretDocId } from "@octogee/core/mattermost/project-agent";
import { readAssignedSlugsForGateway } from "@octogee/core/assigned-roster";
import { deriveExpectedAgentId } from "../../../gateway-edge/src/chat-proxy/openclaw/frame-filter.js";
import {
  ActivityReceiptConflictError,
  ActivityReceiptLeaseError,
  ActivityReceiptUnavailableError,
  FirestoreActivityWriteReceiptStore,
  isValidActivityAttachmentReceipt,
  type ActivityReceiptClaimInput,
  type ActivityReceiptFirestoreLike,
} from "../../../gateway-edge/src/chat-proxy/openclaw/activity-write-receipts.js";
type GatewayBinding = Extract<Express.Request["boundTenant"], { kind: "gateway" }>;

interface AgentIdentity {
  agentId: string;
  uid: string;
  coachMmUserId: string;
  coachToken: string;
  workspaceSlug: string;
  projectSlug: string;
}

interface ChannelProjectionTarget {
  primaryChannelId: string;
  channelDocPath: string;
}

interface AuthorizedConversationTarget extends ChannelProjectionTarget {
  expectedChannelTeamId: string | null;
  expectedChannelName: string | null;
  expectedChannelType: "P" | "D";
  expectedMemberIds?: string[];
}

const TICKETS = "gatewayTickets";
const REDEEMABLE_WS_TICKET_PURPOSES: ReadonlySet<string> = new Set(["openclaw-ws", "voice-ws"]);
const FORBIDDEN = { error: "forbidden" } as const;
const RECEIPT_MAX_LEASE_MS = 60_000;
const PREVIEW_PROJECT_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PREVIEW_PROJECT_SLUG_MAX_LENGTH = 63;
const MATTERMOST_ID_RE = /^[a-z0-9]{26}$/u;

function boundGateway(req: Request, res: Response): GatewayBinding | null {
  const bound = req.boundTenant;
  if (!bound || bound.kind !== "gateway") {
    res.status(403).json(FORBIDDEN);
    return null;
  }
  const claimed = (req.body as { gatewayId?: unknown } | undefined)?.gatewayId;
  if (typeof claimed === "string" && claimed.length > 0 && claimed !== bound.gatewayId) {
    res.status(403).json(FORBIDDEN);
    return null;
  }
  return bound;
}

function stringBody(req: Request, key: string): string {
  const value = (req.body as Record<string, unknown> | undefined)?.[key];
  return typeof value === "string" ? value : "";
}

function safeDocId(value: string): boolean {
  return value.length > 0 && !value.includes("/");
}

function validPreviewProjectSlug(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= PREVIEW_PROJECT_SLUG_MAX_LENGTH &&
    PREVIEW_PROJECT_SLUG_RE.test(value);
}

async function previewAccessAuthorized(
  db: Firestore,
  uid: string,
  workspaceSlug: string,
  projectSlug: string | null,
): Promise<boolean> {
  const path = projectSlug
    ? `workspaces/${workspaceSlug}/projects/${projectSlug}`
    : `workspaces/${workspaceSlug}`;
  const target = await db.doc(path).get();
  if (!target.exists) return false;
  const targetData = target.data() ?? {};
  const ownerUid = targetData.ownerUid;
  if (typeof ownerUid !== "string") return false;
  const [caller, owner, member] = await Promise.all([
    db.doc(`users/${uid}`).get(),
    db.doc(`users/${ownerUid}`).get(),
    db.doc(`${path}/members/${uid}`).get(),
  ]);
  const ownerData = owner.data() ?? {};
  const archivedProject = projectSlug !== null && (
    (targetData.commercialLifecycle as { status?: unknown } | undefined)?.status === "archived" ||
    resolveCommercialEntitlements(ownerData).projectMode !== "active"
  );
  return !archivedProject &&
    caller.exists &&
    owner.exists &&
    accountAllowsInteractiveAccess(caller.data()) &&
    accountAllowsInteractiveAccess(ownerData) &&
    (ownerUid === uid || member.exists);
}

function readPath(obj: Record<string, unknown> | undefined, dotted: string): unknown {
  let cur: unknown = obj;
  for (const part of dotted.split(".")) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function extractRefPath(ref: unknown): string | null {
  if (!ref || typeof ref !== "object") return null;
  const direct = (ref as { path?: unknown }).path;
  if (typeof direct === "string" && direct.length > 0) return direct;

  const segments: string[] = [];
  let cur: unknown = ref;
  while (cur && typeof cur === "object") {
    const node = cur as { id?: unknown; parent?: unknown };
    if (typeof node.id === "string" && node.id.length > 0) segments.unshift(node.id);
    cur = node.parent;
  }
  return segments.length > 0 ? segments.join("/") : null;
}

interface BoundChannelPath {
  workspaceSlug: string;
  ownerPath: string;
  channelName: string;
  lane: "workspace" | "project";
  projectSlug?: string;
}

type ChannelLookupDocument = {
  data(): Record<string, unknown> | undefined;
  ref?: unknown;
};
type ChannelOwnerLookupResult = string | null | "forbidden";
type ChannelDocumentMatches = Map<string, ChannelLookupDocument> | "forbidden";

function boundChannelPath(path: string | null): BoundChannelPath | null {
  if (!path) return null;
  const parts = path.split("/");
  if (!isWorkspacePath(parts)) return null;
  return workspaceChannelBinding(parts) ?? projectChannelBinding(parts);
}

function isWorkspacePath(parts: string[]): boolean {
  return !parts.some((part) => !part) &&
    parts[0] === "workspaces" &&
    isValidUsername(parts[1]);
}

function workspaceChannelBinding(parts: string[]): BoundChannelPath | null {
  if (parts.length !== 4 || parts[2] !== "channels") return null;
  const channelName = parts[3];
  const allowed = channelName === "general" ||
    channelName === "coach-dm" ||
    channelName === "admin" ||
    isValidCustomChannelName(channelName);
  return allowed
    ? {
        workspaceSlug: parts[1],
        ownerPath: `workspaces/${parts[1]}`,
        channelName,
        lane: "workspace",
      }
    : null;
}

function projectChannelBinding(parts: string[]): BoundChannelPath | null {
  if (
    parts.length !== 6 ||
    parts[2] !== "projects" ||
    !isValidProjectId(parts[3]) ||
    parts[4] !== "channels"
  ) return null;
  const channelName = parts[5];
  if (channelName !== "general" && !isValidCustomChannelName(channelName)) return null;
  return {
    workspaceSlug: parts[1],
    ownerPath: `workspaces/${parts[1]}/projects/${parts[3]}`,
    channelName,
    lane: "project",
    projectSlug: parts[3],
  };
}

function ordinaryChannelKind(binding: BoundChannelPath): string | null {
  if (binding.lane === "project") return binding.channelName === "general" ? "general" : null;
  if (binding.channelName === "general") return "general";
  if (binding.channelName === "coach-dm") return "coach-dm";
  if (binding.channelName === "admin") return "admin";
  return null;
}

async function assignedHere(db: Firestore, gatewayId: string, slug: string): Promise<boolean> {
  const assigned = await readAssignedSlugsForGateway(db, gatewayId);
  return assigned.includes(slug);
}

async function userGatewayId(
  db: Firestore,
  uid: string,
): Promise<{ gatewayId: string; userData: Record<string, unknown> } | null> {
  const snap = await db.doc(`users/${uid}`).get();
  if (!snap.exists) return null;
  const userData = snap.data() ?? {};
  const gatewayId = readPath(userData, "provisioning.openclaw.gatewayId");
  return typeof gatewayId === "string" && gatewayId.length > 0
    ? { gatewayId, userData }
    : null;
}

function forbidden(res: Response): void {
  res.status(403).json(FORBIDDEN);
}

async function resolveUidBySlug(db: Firestore, slug: string): Promise<string | null> {
  const snap = await db.collection("users").where("username", "==", slug).limit(2).get();
  return snap.docs.length === 1 ? snap.docs[0].id : null;
}

interface CoachSecret {
  coachToken: string;
  coachMmUserId: string;
}

type AgentScope = Omit<AgentIdentity, "coachMmUserId" | "coachToken">;

function readCoachSecret(data: Record<string, unknown>): CoachSecret | null {
  const coachToken = typeof data.personalToken === "string" ? data.personalToken : "";
  const coachMmUserId = typeof data.coachMmUserId === "string" ? data.coachMmUserId : "";
  return coachToken && coachMmUserId ? { coachToken, coachMmUserId } : null;
}

// Project-agent secrets carry {personalToken, mmUserId}; adapt to the coach
// shape the bridge consumes.
function readProjectAgentSecret(data: Record<string, unknown>): CoachSecret | null {
  const coachToken = typeof data.personalToken === "string" ? data.personalToken : "";
  const coachMmUserId = typeof data.mmUserId === "string" ? data.mmUserId : "";
  return coachToken && coachMmUserId ? { coachToken, coachMmUserId } : null;
}

async function resolveAgentScope(
  db: Firestore,
  gatewayId: string,
  agentId: string,
): Promise<AgentScope | null | "forbidden"> {
  const parsed = parseAgentId(agentId);
  if (parsed.kind === "unknown") return null;
  const slug = parsed.username;
  if (!(await assignedHere(db, gatewayId, slug))) return "forbidden";

  const uid = await resolveUidBySlug(db, slug);
  if (!uid) return null;

  return {
    agentId,
    uid,
    workspaceSlug: slug,
    projectSlug: parsed.kind === "project" ? parsed.project : "workspace",
  };
}

async function resolveAgentIdentity(
  db: Firestore,
  gatewayId: string,
  agentId: string,
): Promise<AgentIdentity | null | "forbidden"> {
  const scope = await resolveAgentScope(db, gatewayId, agentId);
  if (!scope || scope === "forbidden") return scope;
  const parsed = parseAgentId(agentId);
  if (parsed.kind === "unknown") return null;
  const secretPath = parsed.kind === "project"
    ? `users/${scope.uid}/secrets/${projectAgentSecretDocId(parsed.project)}`
    : `users/${scope.uid}/secrets/coachMattermost`;
  const tokenSnap = await db.doc(secretPath).get();
  if (!tokenSnap.exists) return null;
  const secret = parsed.kind === "project"
    ? readProjectAgentSecret(tokenSnap.data() ?? {})
    : readCoachSecret(tokenSnap.data() ?? {});
  return secret
    ? {
        ...scope,
        coachMmUserId: secret.coachMmUserId,
        coachToken: secret.coachToken,
      }
    : null;
}

async function resolveChannelProjectionTarget(
  db: Firestore,
  gatewayId: string,
  primaryChannelId: string,
): Promise<ChannelProjectionTarget | null | "forbidden"> {
  if (!primaryChannelId) return null;
  const snap = await db
    .collectionGroup("channels")
    .where("mattermost.channelId", "==", primaryChannelId)
    .limit(2)
    .get();
  if (snap.docs.length > 1) return "forbidden";
  const doc = snap.docs[0];
  if (!doc) return null;
  const channelDocPath = extractRefPath((doc as { ref?: unknown }).ref);
  const binding = boundChannelPath(channelDocPath);
  if (!binding) return null;
  if (!(await assignedHere(db, gatewayId, binding.workspaceSlug))) return "forbidden";
  return { primaryChannelId, channelDocPath: channelDocPath! };
}

type SessionContextLookup = {
  authorized: true;
  purpose?: string;
} | null | "forbidden";

type SessionChannelLookup =
  | {
      binding: BoundChannelPath;
      data: Record<string, unknown>;
    }
  | null
  | "forbidden";

async function resolveSessionChannel(
  db: Firestore,
  channelId: string,
): Promise<SessionChannelLookup> {
  const snap = await db
    .collectionGroup("channels")
    .where("mattermost.channelId", "==", channelId)
    .limit(2)
    .get();
  if (snap.docs.length > 1) return "forbidden";
  const doc = snap.docs[0];
  if (!doc) return null;
  const binding = boundChannelPath(extractRefPath((doc as { ref?: unknown }).ref));
  if (!binding) return "forbidden";
  return { binding, data: doc.data() ?? {} };
}

function agentCanReadSession(
  agentId: string,
  workspaceSlug: string,
  binding: BoundChannelPath,
): boolean {
  if (binding.workspaceSlug !== workspaceSlug) return false;
  const parsed = parseAgentId(agentId);
  return (
    parsed.kind !== "project" ||
    (binding.lane === "project" && binding.projectSlug === parsed.project)
  );
}

function agentCanRunInConversation(
  agentId: string,
  workspaceSlug: string,
  binding: BoundChannelPath,
): boolean {
  const parsed = parseAgentId(agentId);
  if (!agentCanReadSession(agentId, workspaceSlug, binding)) return false;
  return parsed.kind === "project" || (
    binding.lane === "workspace" &&
    binding.channelName !== "admin"
  );
}

function mattermostChannelName(binding: BoundChannelPath): string | null {
  if (binding.lane === "project") {
    return binding.channelName === "general"
      ? projectGeneralChannelName(binding.workspaceSlug, binding.projectSlug!)
      : projectChannelName(binding.workspaceSlug, binding.projectSlug!, binding.channelName);
  }
  if (binding.channelName === "general") return workspaceGeneralChannelName(binding.workspaceSlug);
  if (binding.channelName === "coach-dm") return workspaceCoachChannelName(binding.workspaceSlug);
  if (binding.channelName === "admin") return null;
  return workspaceCustomChannelName(binding.workspaceSlug, binding.channelName);
}

async function sessionOwnerIsActive(
  db: Firestore,
  binding: BoundChannelPath,
): Promise<boolean> {
  if (binding.lane !== "project") return true;
  const project = await db.doc(binding.ownerPath).get();
  return (
    project.exists &&
    readPath(project.data() ?? {}, "commercialLifecycle.status") !== "archived"
  );
}

function authorizedChannelContext(
  data: Record<string, unknown>,
  binding: BoundChannelPath,
): Exclude<SessionContextLookup, null | "forbidden"> | null {
  if (data.archivedAt) return null;
  const ordinaryKind = ordinaryChannelKind(binding);
  if (ordinaryKind !== null) {
    return data.kind === ordinaryKind ? { authorized: true } : null;
  }
  if (data.kind !== "session") return null;
  const purpose = typeof data.purpose === "string" ? data.purpose : "";
  return purpose.length > 0 ? { authorized: true, purpose } : { authorized: true };
}

async function resolveAuthorizedConversationTarget(
  db: Firestore,
  gatewayId: string,
  agentId: string,
  conversationId: string,
): Promise<AuthorizedConversationTarget | null | "forbidden"> {
  const identity = await resolveAgentScope(db, gatewayId, agentId);
  if (identity === "forbidden") return identity;
  if (!identity) return null;
  const channel = await resolveSessionChannel(db, conversationId);
  if (channel === "forbidden") return channel;
  if (!channel) return null;
  if (!agentCanRunInConversation(agentId, identity.workspaceSlug, channel.binding)) {
    return "forbidden";
  }
  if (!(await sessionOwnerIsActive(db, channel.binding))) return null;
  if (!authorizedChannelContext(channel.data, channel.binding)) return null;
  const expectedChannelName = mattermostChannelName(channel.binding);
  if (!expectedChannelName) return "forbidden";
  const workspace = await db.doc(`workspaces/${identity.workspaceSlug}`).get();
  const expectedChannelTeamId = readPath(workspace.data() ?? {}, "mattermost.teamId");
  if (!workspace.exists || typeof expectedChannelTeamId !== "string" || !expectedChannelTeamId) {
    return null;
  }
  return {
    primaryChannelId: conversationId,
    channelDocPath: channel.binding.lane === "project"
      ? `workspaces/${channel.binding.workspaceSlug}/projects/${channel.binding.projectSlug}/channels/${channel.binding.channelName}`
      : `workspaces/${channel.binding.workspaceSlug}/channels/${channel.binding.channelName}`,
    expectedChannelTeamId,
    expectedChannelName,
    expectedChannelType: "P",
  };
}

async function resolveAuthorizedDirectConversationTarget(
  db: Firestore,
  gatewayId: string,
  agentId: string,
  conversationId: string,
  ownerUserId: string,
): Promise<AuthorizedConversationTarget | null | "forbidden"> {
  if (!MATTERMOST_ID_RE.test(conversationId) || !MATTERMOST_ID_RE.test(ownerUserId)) {
    return "forbidden";
  }
  const parsed = parseAgentId(agentId);
  if (parsed.kind !== "coach") return "forbidden";
  const identity = await resolveAgentIdentity(db, gatewayId, agentId);
  if (identity === "forbidden") return identity;
  if (!identity || !MATTERMOST_ID_RE.test(identity.coachMmUserId)) return null;
  if (identity.coachMmUserId === ownerUserId) return "forbidden";

  const [owner, ledger] = await Promise.all([
    db.doc(`users/${identity.uid}`).get(),
    db.doc(`workspaces/${identity.workspaceSlug}/channels/coach-dm`).get(),
  ]);
  if (
    !owner.exists
    || readPath(owner.data() ?? {}, "mattermost.userId") !== ownerUserId
  ) return "forbidden";
  const ledgerData = ledger.data() ?? {};
  if (
    !ledger.exists
    || !authorizedChannelContext(ledgerData, {
      workspaceSlug: identity.workspaceSlug,
      ownerPath: `workspaces/${identity.workspaceSlug}`,
      channelName: "coach-dm",
      lane: "workspace",
    })
  ) return null;

  const expectedMemberIds = [identity.coachMmUserId, ownerUserId].sort();
  return {
    primaryChannelId: conversationId,
    channelDocPath: `workspaces/${identity.workspaceSlug}/channels/coach-dm`,
    expectedChannelTeamId: null,
    expectedChannelName: null,
    expectedChannelType: "D",
    expectedMemberIds,
  };
}

interface ResolveSessionContextInput {
  gatewayId: string;
  agentId: string;
  accountId: string;
  channelId: string;
  senderId: string;
  sessionKey: string;
  opsMattermostUserId: string | null;
}

async function resolveRawDirectSessionContext(
  db: Firestore,
  input: ResolveSessionContextInput,
): Promise<SessionContextLookup | undefined> {
  if (!input.senderId && !input.sessionKey) return undefined;
  if (!input.senderId || !input.sessionKey) return "forbidden";
  const route = dispatchSessionRoute(input.sessionKey, input.agentId);
  if (!route || route.kind !== "direct" || route.peerId !== input.senderId) {
    return "forbidden";
  }
  return resolveDispatchContext({
    db,
    gatewayId: input.gatewayId,
    agentId: input.agentId,
    accountId: input.accountId,
    conversationId: input.senderId,
    senderId: input.senderId,
    sessionKey: input.sessionKey,
    opsMattermostUserId: input.opsMattermostUserId,
  });
}

async function resolveSessionContext(
  db: Firestore,
  input: ResolveSessionContextInput,
): Promise<SessionContextLookup> {
  const { gatewayId, agentId, accountId, channelId } = input;
  if (!agentId || !channelId) return null;
  const directContext = await resolveRawDirectSessionContext(db, input);
  if (directContext !== undefined) return directContext;
  const parsed = parseAgentId(agentId);
  const expectedAccountId = mattermostAccountId(parsed);
  if (!expectedAccountId || accountId !== expectedAccountId) return "forbidden";
  const identity = await resolveAgentScope(db, gatewayId, agentId);
  if (identity === "forbidden") return identity;
  if (!identity) return null;

  const channel = await resolveSessionChannel(db, channelId);
  if (channel === "forbidden") return channel;
  if (!channel) return null;
  if (!agentCanRunInConversation(agentId, identity.workspaceSlug, channel.binding)) return "forbidden";
  if (!(await sessionOwnerIsActive(db, channel.binding))) return null;
  return authorizedChannelContext(channel.data, channel.binding);
}

type DispatchSessionRoute = {
  kind: "direct" | "group" | "channel";
  peerId: string;
};

type KnownAgentId = Exclude<ParsedAgentId, { kind: "unknown" }>;
type DispatchContextLookup = { authorized: true } | null | "forbidden";

interface DispatchContextInput {
  db: Firestore;
  gatewayId: string;
  agentId: string;
  accountId: string;
  conversationId: string;
  senderId: string;
  sessionKey: string;
  opsMattermostUserId: string | null;
}

function validMattermostUserId(value: unknown): value is string {
  return typeof value === "string" && MATTERMOST_ID_RE.test(value);
}

function mattermostAccountId(parsed: ParsedAgentId): string | null {
  if (parsed.kind === "project") return `${parsed.username}-proj-${parsed.project}`;
  if (parsed.kind === "coach") return `${parsed.username}-coach`;
  return null;
}

function dispatchSessionRoute(
  sessionKey: string,
  agentId: string,
): DispatchSessionRoute | null {
  const match = /^agent:([^:]+):mattermost:(direct|group|channel):([a-z0-9]{26})(?::thread:[a-z0-9]{26})?$/u.exec(
    sessionKey,
  );
  if (match?.[1] !== agentId) return null;
  return {
    kind: match[2] as DispatchSessionRoute["kind"],
    peerId: match[3],
  };
}

function dispatchEnvelope(
  input: DispatchContextInput,
  parsed: KnownAgentId,
): DispatchSessionRoute | null {
  if (
    !MATTERMOST_ID_RE.test(input.conversationId)
    || !MATTERMOST_ID_RE.test(input.senderId)
    || input.accountId !== mattermostAccountId(parsed)
  ) return null;
  const route = dispatchSessionRoute(input.sessionKey, input.agentId);
  if (!route || route.peerId !== input.conversationId) return null;
  if (route.kind === "direct" && input.senderId !== route.peerId) return null;
  return route;
}

async function resolveCoachOwnerDispatchContext(
  input: DispatchContextInput,
  identity: AgentScope,
  parsed: KnownAgentId,
): Promise<DispatchContextLookup> {
  if (parsed.kind !== "coach") return "forbidden";
  const [workspace, owner] = await Promise.all([
    input.db.doc(`workspaces/${parsed.username}`).get(),
    input.db.doc(`users/${identity.uid}`).get(),
  ]);
  if (
    workspace.exists
    && workspace.data()?.ownerUid === identity.uid
    && owner.exists
    && readPath(owner.data() ?? {}, "mattermost.userId") === input.senderId
  ) return { authorized: true };
  return "forbidden";
}

async function resolveDirectDispatchContext(
  input: DispatchContextInput,
  identity: AgentScope,
  parsed: KnownAgentId,
): Promise<DispatchContextLookup> {
  if (parsed.kind !== "coach") return "forbidden";

  const gateway = await input.db.doc(`gateways/${input.gatewayId}`).get();
  const isBuilderGateway = gateway.exists && gateway.data()?.gatewayClass === "builder";
  if (
    input.opsMattermostUserId !== null &&
    input.senderId === input.opsMattermostUserId
  ) return { authorized: true };
  if (!isBuilderGateway) return "forbidden";
  return resolveCoachOwnerDispatchContext(input, identity, parsed);
}

function isExactDispatchLane(
  binding: BoundChannelPath,
  parsed: KnownAgentId,
): boolean {
  if (parsed.kind === "project") {
    return binding.lane === "project"
      && binding.workspaceSlug === parsed.username
      && binding.projectSlug === parsed.project;
  }
  return binding.lane === "workspace"
    && binding.workspaceSlug === parsed.username
    && binding.channelName !== "admin"
    && binding.channelName !== "coach-dm";
}

async function resolveGroupDispatchContext(
  input: DispatchContextInput,
  identity: AgentScope,
  parsed: KnownAgentId,
): Promise<DispatchContextLookup> {
  const channel = await resolveSessionChannel(input.db, input.conversationId);
  if (channel === "forbidden") return channel;
  if (!channel) return null;
  if (channel.binding.channelName === "coach-dm") {
    if (
      channel.binding.lane !== "workspace"
      || channel.binding.workspaceSlug !== parsed.username
    ) return "forbidden";
    return resolveCoachOwnerDispatchContext(input, identity, parsed);
  }
  if (!isExactDispatchLane(channel.binding, parsed)) return "forbidden";
  if (!(await sessionOwnerIsActive(input.db, channel.binding))) return null;
  return authorizedChannelContext(channel.data, channel.binding)
    ? { authorized: true }
    : null;
}

async function resolveDispatchContext(
  input: DispatchContextInput,
): Promise<DispatchContextLookup> {
  if (
    !MATTERMOST_ID_RE.test(input.conversationId)
    || !MATTERMOST_ID_RE.test(input.senderId)
  ) return "forbidden";
  const parsed = parseAgentId(input.agentId);
  if (parsed.kind === "unknown") return "forbidden";
  const route = dispatchEnvelope(input, parsed);
  if (!route) return "forbidden";

  const identity = await resolveAgentScope(input.db, input.gatewayId, input.agentId);
  if (identity === "forbidden") return identity;
  if (!identity) return null;

  if (route.kind === "direct") {
    return resolveDirectDispatchContext(input, identity, parsed);
  }
  return resolveGroupDispatchContext(input, identity, parsed);
}

function receiptBody(req: Request): Record<string, unknown> {
  const body = req.body;
  return body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
}

function receiptString(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function receiptTimestamp(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
}

function receiptEventKey(value: unknown): string | null {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : null;
}

function receiptClaimInput(body: Record<string, unknown>): ActivityReceiptClaimInput | null {
  const raw = body.input;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  const eventKey = receiptEventKey(input.eventKey);
  const payloadDigest = receiptEventKey(input.payloadDigest);
  const historyAnchorPostId = receiptString(input, "historyAnchorPostId");
  const leaseOwner = receiptString(input, "leaseOwner");
  const now = receiptTimestamp(input.now);
  const leaseMs = receiptTimestamp(input.leaseMs);
  if (
    !eventKey ||
    !payloadDigest ||
    !historyAnchorPostId ||
    !leaseOwner ||
    now === null ||
    leaseMs === null ||
    leaseMs === 0 ||
    leaseMs > RECEIPT_MAX_LEASE_MS ||
    !Number.isSafeInteger(now + leaseMs)
  ) {
    return null;
  }
  return { eventKey, payloadDigest, historyAnchorPostId, leaseOwner, now, leaseMs };
}

function receiptMutation(
  body: Record<string, unknown>,
): { eventKey: string; leaseToken: string; now: number } | null {
  const eventKey = receiptEventKey(body.eventKey);
  const leaseToken = receiptString(body, "leaseToken");
  const now = receiptTimestamp(body.now);
  return eventKey && leaseToken && now !== null ? { eventKey, leaseToken, now } : null;
}

async function receiptStoreFor(
  req: Request,
  res: Response,
  db: Firestore,
  bound: GatewayBinding,
): Promise<FirestoreActivityWriteReceiptStore | null> {
  const channelDocPath = receiptString(receiptBody(req), "channelDocPath");
  const binding = boundChannelPath(channelDocPath);
  if (!binding) {
    res.status(400).json({ error: "invalid_receipt_channel_path" });
    return null;
  }
  if (!(await assignedHere(db, bound.gatewayId, binding.workspaceSlug))) {
    forbidden(res);
    return null;
  }
  if (!(await db.doc(channelDocPath!).get()).exists) {
    res.status(404).json({ error: "receipt_channel_not_found" });
    return null;
  }
  return new FirestoreActivityWriteReceiptStore(
    db as unknown as ActivityReceiptFirestoreLike,
    channelDocPath!,
  );
}

function respondReceiptStoreError(res: Response, error: unknown): void {
  if (error instanceof ActivityReceiptConflictError) {
    res.status(409).json({ error: "receipt_conflict" });
    return;
  }
  if (error instanceof ActivityReceiptLeaseError) {
    res.status(409).json({ error: "receipt_leased" });
    return;
  }
  if (error instanceof ActivityReceiptUnavailableError) {
    res.status(422).json({ error: "receipt_unavailable" });
    return;
  }
  throw error;
}

async function resolveChannelOwnerUid(
  db: Firestore,
  gatewayId: string,
  channelId: string,
): Promise<ChannelOwnerLookupResult> {
  const docs = await matchingChannelDocuments(db, channelId);
  if (docs === "forbidden") return docs;
  if (docs.size === 0) return null;
  if (docs.size !== 1) return "forbidden";
  const [channelPath, doc] = [...docs.entries()][0];
  const binding = boundChannelPath(channelPath);
  if (!binding || !(await assignedHere(db, gatewayId, binding.workspaceSlug))) return "forbidden";
  const data = doc.data() ?? {};
  if (data.kind === "session") return sessionChannelOwner(data, binding);
  if (data.kind !== ordinaryChannelKind(binding)) return "forbidden";
  const ownerSnap = await db.doc(binding.ownerPath).get();
  const ownerUid = ownerSnap.data()?.ownerUid;
  return typeof ownerUid === "string" && ownerUid ? ownerUid : null;
}

async function matchingChannelDocuments(
  db: Firestore,
  channelId: string,
): Promise<ChannelDocumentMatches> {
  const docs = new Map<string, ChannelLookupDocument>();
  for (const field of ["mattermost.channelId"]) {
    const snap = await db.collectionGroup("channels").where(field, "==", channelId).limit(2).get();
    for (const doc of snap.docs) {
      const path = extractRefPath((doc as { ref?: unknown }).ref);
      if (!path) return "forbidden";
      docs.set(path, doc as unknown as ChannelLookupDocument);
    }
  }
  return docs;
}

function sessionChannelOwner(
  data: Record<string, unknown>,
  binding: BoundChannelPath,
): ChannelOwnerLookupResult {
  if (data.kind === "session") {
    if (ordinaryChannelKind(binding) !== null) return "forbidden";
    const createdBy = data.createdBy;
    return typeof createdBy === "string" && createdBy ? createdBy : null;
  }
  return "forbidden";
}

async function resolveUidByMmUser(
  db: Firestore,
  gatewayId: string,
  mmUserId: string,
): Promise<string | null | "forbidden"> {
  if (!mmUserId) return null;
  const snap = await db.collection("users").where("mattermost.userId", "==", mmUserId).limit(2).get();
  if (snap.docs.length > 1) return "forbidden";
  const doc = snap.docs[0];
  if (!doc) return null;
  const uid = doc.id;
  const data = doc.data() ?? {};
  const slug = typeof data.username === "string" ? data.username : "";
  if (!slug || !(await assignedHere(db, gatewayId, slug))) return "forbidden";
  return uid;
}

export async function resolveRedeemGatewayUrl(input: {
  tx: Transaction;
  db: Firestore;
  gatewayId: string;
  gatewayData: Record<string, unknown> | undefined;
}): Promise<{ url: string } | { error: string }> {
  const gateway = projectGatewayDesiredRootForGateway(input.gatewayData, input.gatewayId);
  if (!gateway) return { error: "gateway-root-invalid" };
  if (gateway.liveRelease === null) return { error: "gateway-url-unresolved" };

  const runtimeSnap = await input.tx.get(input.db.doc(`glmGateways/${input.gatewayId}`));
  const runtime = runtimeSnap.data();
  if (!runtime) return { error: `runtime ${input.gatewayId} not found` };
  if (runtime.gatewayId !== input.gatewayId) {
    return { error: `runtime ${input.gatewayId} belongs to gateway ${String(runtime.gatewayId)}` };
  }
  if (runtime.lifecycle === "retired" || runtime.lifecycle === "failed" || runtime.retiredAt != null) {
    return { error: `runtime ${input.gatewayId} is not serving` };
  }
  const url = readPath(runtime, "heartbeat.internalUrl");
  if (typeof url !== "string" || url.length === 0) {
    return { error: `runtime ${input.gatewayId} has no serving internalUrl` };
  }
  return { url };
}

function mountUserAndWsRoutes(router: Router, db: Firestore): void {
  router.post("/previews/authorize", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const uid = stringBody(req, "uid");
    const workspaceSlug = stringBody(req, "workspaceSlug");
    const rawProjectSlug = (req.body as Record<string, unknown> | undefined)?.projectSlug;
    const projectSlug = rawProjectSlug === null ? null : rawProjectSlug;
    if (
      !safeDocId(uid) ||
      !isValidUsername(workspaceSlug) ||
      (projectSlug !== null && !validPreviewProjectSlug(projectSlug))
    ) {
      res.status(400).json({ error: "invalid_preview_access_request" });
      return;
    }
    if (!(await assignedHere(db, bound.gatewayId, workspaceSlug))) {
      forbidden(res);
      return;
    }
    res.json({
      authorized: await previewAccessAuthorized(db, uid, workspaceSlug, projectSlug),
    });
  });

  router.post("/users/gateway-id", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const uid = stringBody(req, "uid");
    const resolved = uid ? await userGatewayId(db, uid) : null;
    if (!resolved) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (resolved.gatewayId !== bound.gatewayId) {
      forbidden(res);
      return;
    }
    res.json({ gatewayId: resolved.gatewayId });
  });

  router.post("/ws/redeem", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const ticketId = stringBody(req, "ticketId");
    if (!ticketId) {
      res.status(400).json({ error: "ticketId required" });
      return;
    }
    const requestedPurpose = stringBody(req, "purpose") || "openclaw-ws";
    if (!REDEEMABLE_WS_TICKET_PURPOSES.has(requestedPurpose)) {
      res.status(400).json({ error: "unsupported ticket purpose" });
      return;
    }

    const result = await db.runTransaction<{
      status: number;
      body: Record<string, unknown>;
    }>(async (tx) => {
      const ticketRef = db.collection(TICKETS).doc(ticketId);
      const ticketSnap = await tx.get(ticketRef);
      if (!ticketSnap.exists) return { status: 401, body: { error: "unauthorized" } };
      const ticket = ticketSnap.data() ?? {};
      const uid = typeof ticket.uid === "string" ? ticket.uid : "";
      const purpose = ticket.purpose;
      const expiresAt = ticket.expiresAt;
      if (!uid || purpose !== requestedPurpose || typeof expiresAt !== "number" || expiresAt < Date.now()) {
        return { status: 401, body: { error: "unauthorized" } };
      }

      const userRef = db.doc(`users/${uid}`);
      const userSnap = await tx.get(userRef);
      const userData = userSnap.data() ?? {};
      const gatewayId = readPath(userData, "provisioning.openclaw.gatewayId");
      if (gatewayId !== bound.gatewayId) {
        return { status: 403, body: FORBIDDEN };
      }
      const gwRef = db.doc(`gateways/${bound.gatewayId}`);
      const gwSnap = await tx.get(gwRef);
      const urlResult = await resolveRedeemGatewayUrl({
        tx,
        db,
        gatewayId: bound.gatewayId,
        gatewayData: gwSnap.data(),
      });
      if ("error" in urlResult) {
        return {
          status: 502,
          body: {
            error:
              urlResult.error === "gateway-root-invalid"
                ? "gateway-root-invalid"
                : "gateway-url-unresolved",
          },
        };
      }
      const gatewayUrl = urlResult.url;
      let expectedAgentId: string;
      try {
        expectedAgentId = deriveExpectedAgentId(uid, userData);
      } catch {
        return { status: 502, body: { error: "expected-agent-unresolved" } };
      }
      tx.delete(ticketRef);
      return {
        status: 200,
        body: { uid, gatewayId: bound.gatewayId, gatewayUrl, expectedAgentId },
      };
    });
    res.status(result.status).json(result.body);
  });
}

function mountSessionContextRoute(
  router: Router,
  db: Firestore,
  opsMattermostUserId: string | null,
): void {
  router.post("/activity/dispatch-context", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const context = await resolveDispatchContext({
      db,
      gatewayId: bound.gatewayId,
      agentId: stringBody(req, "agentId"),
      accountId: stringBody(req, "accountId"),
      conversationId: stringBody(req, "conversationId"),
      senderId: stringBody(req, "senderId"),
      sessionKey: stringBody(req, "sessionKey"),
      opsMattermostUserId,
    });
    if (context === "forbidden") {
      forbidden(res);
      return;
    }
    if (!context) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json(context);
  });

  router.post("/activity/session-context", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const context = await resolveSessionContext(db, {
      gatewayId: bound.gatewayId,
      agentId: stringBody(req, "agentId"),
      accountId: stringBody(req, "accountId"),
      channelId: stringBody(req, "channelId"),
      senderId: stringBody(req, "senderId"),
      sessionKey: stringBody(req, "sessionKey"),
      opsMattermostUserId,
    });
    if (context === "forbidden") {
      forbidden(res);
      return;
    }
    if (!context) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json(context);
  });
}

function mountActivityRoutes(
  router: Router,
  db: Firestore,
  opsMattermostUserId: string | null,
): void {
  router.post("/activity/agent-identity", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const identity = await resolveAgentIdentity(db, bound.gatewayId, stringBody(req, "agentId"));
    if (identity === "forbidden") {
      forbidden(res);
      return;
    }
    if (!identity) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({ identity });
  });

  const resolveChannelTarget = async (req: Request, res: Response): Promise<void> => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const target = await resolveChannelProjectionTarget(
      db,
      bound.gatewayId,
      stringBody(req, "primaryChannelId"),
    );
    if (target === "forbidden") {
      forbidden(res);
      return;
    }
    if (!target) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({ target });
  };

  router.post("/activity/channel-target", resolveChannelTarget);

  router.post("/activity/conversation-target", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const target = await resolveAuthorizedConversationTarget(
      db,
      bound.gatewayId,
      stringBody(req, "agentId"),
      stringBody(req, "conversationId"),
    );
    if (target === "forbidden") {
      forbidden(res);
      return;
    }
    if (!target) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({ target });
  });

  router.post("/activity/direct-conversation-target", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const target = await resolveAuthorizedDirectConversationTarget(
      db,
      bound.gatewayId,
      stringBody(req, "agentId"),
      stringBody(req, "conversationId"),
      stringBody(req, "ownerUserId"),
    );
    if (target === "forbidden") {
      forbidden(res);
      return;
    }
    if (!target) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({ target });
  });

  mountSessionContextRoute(router, db, opsMattermostUserId);

  mountActivityReceiptRoutes(router, db);

  router.post("/activity/channel-owner", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const ownerUid = await resolveChannelOwnerUid(db, bound.gatewayId, stringBody(req, "channelId"));
    if (ownerUid === "forbidden") {
      forbidden(res);
      return;
    }
    if (!ownerUid) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({ ownerUid });
  });

  router.post("/activity/user-by-mm", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const uid = await resolveUidByMmUser(db, bound.gatewayId, stringBody(req, "mmUserId"));
    if (uid === "forbidden") {
      forbidden(res);
      return;
    }
    if (!uid) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({ uid });
  });
}

function mountActivityReceiptRoutes(router: Router, db: Firestore): void {
  router.post("/activity/write-receipts/claim", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const input = receiptClaimInput(receiptBody(req));
    if (!input) {
      res.status(400).json({ error: "invalid_receipt_claim" });
      return;
    }
    const store = await receiptStoreFor(req, res, db, bound);
    if (!store) return;
    try {
      const claim = await store.claim(input);
      res.json(claim);
    } catch (error) {
      respondReceiptStoreError(res, error);
    }
  });

  router.post("/activity/write-receipts/read", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const eventKey = receiptEventKey(receiptBody(req).eventKey);
    if (!eventKey) {
      res.status(400).json({ error: "invalid_receipt_event_key" });
      return;
    }
    const store = await receiptStoreFor(req, res, db, bound);
    if (!store) return;
    try {
      const receipt = await store.read(eventKey);
      if (!receipt) {
        res.status(404).json({ error: "receipt_not_found" });
        return;
      }
      res.json({ receipt });
    } catch (error) {
      respondReceiptStoreError(res, error);
    }
  });

  router.post("/activity/write-receipts/mark-posted", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const body = receiptBody(req);
    const mutation = receiptMutation(body);
    const postId = receiptString(body, "postId");
    if (!mutation || !postId) {
      res.status(400).json({ error: "invalid_receipt_mark_posted" });
      return;
    }
    const store = await receiptStoreFor(req, res, db, bound);
    if (!store) return;
    try {
      await store.markPosted(mutation.eventKey, mutation.leaseToken, postId, mutation.now);
      res.status(204).end();
    } catch (error) {
      respondReceiptStoreError(res, error);
    }
  });

  router.post("/activity/write-receipts/attachment", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const body = receiptBody(req);
    const mutation = receiptMutation(body);
    if (!mutation || !isValidActivityAttachmentReceipt(body.attachment)) {
      res.status(400).json({ error: "invalid_receipt_attachment" });
      return;
    }
    const store = await receiptStoreFor(req, res, db, bound);
    if (!store) return;
    try {
      await store.updateAttachment(
        mutation.eventKey,
        mutation.leaseToken,
        body.attachment,
        mutation.now,
      );
      res.status(204).end();
    } catch (error) {
      respondReceiptStoreError(res, error);
    }
  });

  router.post("/activity/write-receipts/commit", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const mutation = receiptMutation(receiptBody(req));
    if (!mutation) {
      res.status(400).json({ error: "invalid_receipt_commit" });
      return;
    }
    const store = await receiptStoreFor(req, res, db, bound);
    if (!store) return;
    try {
      await store.commit(mutation.eventKey, mutation.leaseToken, mutation.now);
      res.status(204).end();
    } catch (error) {
      respondReceiptStoreError(res, error);
    }
  });
}

export function createOpenClawRuntimeBrokerRoutes(opts: {
  db: Firestore;
  opsMattermostUserId?: string;
}): Router {
  const router = Router();
  const { db } = opts;
  const opsMattermostUserId = validMattermostUserId(opts.opsMattermostUserId)
    ? opts.opsMattermostUserId
    : null;
  mountUserAndWsRoutes(router, db);
  mountActivityRoutes(router, db, opsMattermostUserId);
  return router;
}
