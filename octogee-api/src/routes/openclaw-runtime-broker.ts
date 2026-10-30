import { isCanonicalWorkspaceMembership } from "@octogee/core/gateway-principal-access";
import { notifyNativeFinalReply, parseFinalReply, ReplyBindingDeniedError, type FinalReplyIdentity, type FinalReplyTarget } from "@octogee/core/native-final-reply";
import { readFinalReplyPost, verifyFinalReplyChannel } from "../lib/native-final-reply-mattermost.js";
import { buildCoachDmEvent } from "../../../gateway-edge/src/notifications/chat-notifier.js";
import { fanOutNotification } from "../../../gateway-edge/src/notifications/pipeline.js";
import { logger } from "../../../gateway-edge/src/middleware/logging.js";
import { createVoicePostingGrant } from "../lib/voice-posting-grant.js";
import { resolveVoiceConversationContext, resolveWorkspaceConversationScope } from "../lib/workspace-conversation.js";
import { isMattermostPostId, parseChannelScopedMattermostSessionRoute } from '@octogee/shared/types/mattermost-session-route';
import { resolveActivityConversation, type ActivityConversation } from '../../../gateway-edge/src/lib/activity-conversation.js';
import { Router, type Request, type Response } from "express";
import type { Firestore, Transaction } from "firebase-admin/firestore";
import { accountAllowsInteractiveAccess } from "@octogee/shared/types/account-lifecycle";
import { resolveCommercialEntitlements } from "@octogee/shared/types/commercial-entitlements";
import { resolveBuilderTier } from "@octogee/shared/types/billing";
import { BUILDER_TIERS } from "@octogee/shared/types/billing-tiers";

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
import { requestBuilderActivationLease } from "@octogee/core/builder-activation-lease";
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

interface ResolveSessionContextInput {
  gatewayId: string;
  agentId: string;
  accountId: string;
  channelId: string;
  senderId: string;
  sessionKey: string;
}

async function resolveRawDirectSessionContext(
  db: Firestore,
  input: ResolveSessionContextInput,
): Promise<SessionContextLookup | undefined> {
  if (!input.senderId && !input.sessionKey) return undefined;
  if (!input.senderId || !input.sessionKey) return "forbidden";
  return "forbidden";
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

  if (route.kind === "direct") return "forbidden";
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

interface ChatActivity {
  channelId: string;
  mmUserId: string;
  eventKey: string;
}

const MATTERMOST_EMOJI_NAME_RE = /^[a-z0-9_+-]{1,64}$/u;

function chatActivityBody(req: Request): ChatActivity | null {
  const kind = stringBody(req, "kind");
  const channelId = stringBody(req, "channelId");
  const postId = stringBody(req, "postId");
  const mmUserId = stringBody(req, "mmUserId");
  if (![channelId, postId, mmUserId].every((id) => MATTERMOST_ID_RE.test(id))) return null;
  if (kind === "post") {
    return { channelId, mmUserId, eventKey: `mm-post:${postId}:${mmUserId}` };
  }
  if (kind !== "reaction") return null;
  const emojiName = stringBody(req, "emojiName");
  const createdAt = (req.body as Record<string, unknown> | undefined)?.createdAt;
  if (!MATTERMOST_EMOJI_NAME_RE.test(emojiName) || !Number.isSafeInteger(createdAt) || (createdAt as number) <= 0) {
    return null;
  }
  return {
    channelId,
    mmUserId,
    eventKey: `mm-reaction:${postId}:${mmUserId}:${emojiName}:${createdAt}`,
  };
}

async function isOctogeeUser(db: Firestore, mmUserId: string): Promise<boolean> {
  const snap = await db.collection("users").where("mattermost.userId", "==", mmUserId).limit(2).get();
  return snap.docs.length === 1;
}

function hasDisposableBuilderRuntime(userData: Record<string, unknown>): boolean {
  if (!accountAllowsInteractiveAccess(userData)) return false;
  const tier = resolveBuilderTier(userData);
  return tier !== null && BUILDER_TIERS[tier].instance !== null;
}

async function requestChatActivityDemand(
  db: Firestore,
  gatewayId: string,
  activity: ChatActivity,
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const ownerUid = await resolveChannelOwnerUid(db, gatewayId, activity.channelId);
  if (ownerUid === "forbidden") return { statusCode: 403, body: FORBIDDEN };
  if (!ownerUid) return { statusCode: 404, body: { error: "not_found" } };
  if (!(await isOctogeeUser(db, activity.mmUserId))) {
    return { statusCode: 200, body: { recorded: false, reason: "actor-not-human" } };
  }
  const ownerSnap = await db.doc(`users/${ownerUid}`).get();
  if (!ownerSnap.exists || !hasDisposableBuilderRuntime(ownerSnap.data() ?? {})) {
    return { statusCode: 200, body: { recorded: false, reason: "owner-not-disposable-builder" } };
  }
  const assignment = await db.doc(`gateways/${gatewayId}/assignments/${ownerUid}`).get();
  const epoch = assignment.data()?.epoch;
  const observedAt = Date.now();
  const result = await requestBuilderActivationLease({
    db,
    uid: ownerUid,
    reportingGatewayId: gatewayId,
    assignmentEpoch: typeof epoch === "number" ? epoch : undefined,
    eventKey: activity.eventKey,
    cause: "chat",
    observedAt,
    createdBy: `mm-chat:${gatewayId}:${activity.mmUserId}`,
    now: observedAt,
  });
  const recorded = result.statusCode === 200 || result.statusCode === 202;
  return { statusCode: result.statusCode, body: { recorded, ...result.body } };
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

function matchesActivityTicket(scope: ActivityConversation, gatewayId: string, payload: Record<string, unknown>): boolean {
  return scope.gatewayId === gatewayId && scope.channelId === payload.channelId && scope.threadRootPostId === payload.threadRootPostId && scope.ownerUid === payload.ownerUid && scope.expectedAgentId === payload.expectedAgentId && scope.sessionKey === payload.sessionKey;
}

async function redeemActivityIdentity(db: Firestore, tx: Transaction, payload: Record<string, unknown>, uid: string, gatewayId: string) {
  if (Object.keys(payload).some(key => !['channelId', 'threadRootPostId', 'ownerUid', 'expectedAgentId', 'sessionKey'].includes(key)) || !isMattermostPostId(payload.channelId)
    || (payload.threadRootPostId !== undefined && !isMattermostPostId(payload.threadRootPostId))) return null;
  const scope = await resolveActivityConversation({ db, uid, channelId: payload.channelId, ...(payload.threadRootPostId === undefined ? {} : { threadRootPostId: payload.threadRootPostId }) });
  if (!scope || !matchesActivityTicket(scope, gatewayId, payload)) return null;
  const owner = await tx.get(db.doc(`users/${scope.ownerUid}`));
  if (readPath(owner.data() ?? {}, 'provisioning.openclaw.gatewayId') !== gatewayId) return null;
  return { expectedAgentId: scope.expectedAgentId, activityConversation: scope };
}

function validVoiceTicketPayload(payload: Record<string, unknown> | undefined): payload is Record<string, unknown> & { channelId: string; threadRootPostId: string; workspaceSlug: string; ownerUid: string } {
  return Boolean(payload && Object.keys(payload).every(key => ['workspaceSlug', 'ownerUid', 'channelId', 'threadRootPostId', 'sessionKey'].includes(key)) &&
    isMattermostPostId(payload.channelId) && isMattermostPostId(payload.threadRootPostId) && typeof payload.workspaceSlug === 'string' && typeof payload.ownerUid === 'string');
}
async function redeemVoiceIdentity(db: Firestore, tx: Transaction, payload: Record<string, unknown> | undefined, uid: string, gatewayId: string) {
  if (!validVoiceTicketPayload(payload)) return null;
  const { workspaceSlug, ownerUid, channelId, threadRootPostId } = payload;
  const sessionKey = payload.sessionKey as string;
  const route = parseChannelScopedMattermostSessionRoute(sessionKey);
  const agent = parseAgentId(route?.agentId ?? '');
  if (!route || route.primaryChannelId !== channelId || agent.kind === 'unknown' || agent.username !== workspaceSlug) return null;
  const scope = await resolveWorkspaceConversationScope(path => tx.get(db.doc(path)), { uid, gatewayId, workspaceSlug, ownerUid, ...(agent.kind === 'project' ? { projectId: agent.project } : {}) });
  if (!scope) return null;
  const live = await resolveVoiceConversationContext({ db }, { uid, gatewayId, channelId, threadRootPostId });
  if (!live || live.scope.ownerUid !== ownerUid || live.context.workspaceSlug !== workspaceSlug || live.context.sessionKey !== sessionKey) return null;
  return { expectedAgentId: live.context.agentId, voiceConversation: { workspaceSlug, ownerUid, channelId, threadRootPostId, sessionKey } };
}

async function redeemWsIdentity(db: Firestore, tx: Transaction, ticket: Record<string, unknown>, uid: string, gatewayId: string) {
  if (ticket.gatewayId !== gatewayId) return null;
  if (ticket.purpose === 'openclaw-ws' && (ticket.payload as Record<string, unknown> | undefined)?.channelId !== undefined) {
    return redeemActivityIdentity(db, tx, ticket.payload as Record<string, unknown>, uid, gatewayId);
  }
  if (ticket.purpose === "voice-ws") {
    return redeemVoiceIdentity(db, tx, ticket.payload as Record<string, unknown> | undefined, uid, gatewayId);
  }
  const user = await tx.get(db.doc(`users/${uid}`));
  const userData = user.data() ?? {};
  if (readPath(userData, "provisioning.openclaw.gatewayId") !== gatewayId) return null;
  return { expectedAgentId: deriveExpectedAgentId(uid, userData) };
}

function mountUserAndWsRoutes(router: Router, db: Firestore): void {
  router.post('/activity/conversation-access', async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const uid = stringBody(req, 'uid');
    const channelId = stringBody(req, 'channelId');
    const rawThreadRootPostId = (req.body as Record<string, unknown> | undefined)?.threadRootPostId;
    const threadRootPostId = rawThreadRootPostId === undefined ? undefined : stringBody(req, 'threadRootPostId');
    if (!safeDocId(uid) || !MATTERMOST_ID_RE.test(channelId) || (threadRootPostId !== undefined && !isMattermostPostId(threadRootPostId))) { res.status(400).json({ error: 'invalid_activity_channel' }); return; }
    const scope = await resolveActivityConversation({ db, uid, channelId, ...(threadRootPostId === undefined ? {} : { threadRootPostId }) });
    if (!scope || scope.gatewayId !== bound.gatewayId) { forbidden(res); return; }
    res.set('Cache-Control', 'no-store').json(scope);
  });
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
      if (!uid || purpose !== requestedPurpose || typeof expiresAt !== "number" || expiresAt <= Date.now()) {
        return { status: 401, body: { error: "unauthorized" } };
      }

      let identity: Awaited<ReturnType<typeof redeemWsIdentity>>;
      try { identity = await redeemWsIdentity(db, tx, ticket, uid, bound.gatewayId); }
      catch { return { status: 502, body: { error: "expected-agent-unresolved" } }; }
      if (!identity) return { status: 403, body: FORBIDDEN };
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
      const grant = 'voiceConversation' in identity ? createVoicePostingGrant({ uid, gatewayId: bound.gatewayId, agentId: identity.expectedAgentId, ...identity.voiceConversation }) : null;
      if (grant) tx.set(db.doc(grant.path), grant.document);
      tx.delete(ticketRef);
      return {
        status: 200,
        body: { uid, gatewayId: bound.gatewayId, gatewayUrl, ...identity, ...(grant ? { voiceGrant: grant.voiceGrant, voiceGrantExpiresAt: grant.voiceGrantExpiresAt } : {}) },
      };
    });
    res.set("Cache-Control", "no-store").status(result.status).json(result.body);
  });
}

function mountSessionContextRoute(
  router: Router,
  db: Firestore,
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

  router.post("/activity/direct-conversation-target", (req, res) => {
    if (!boundGateway(req, res)) return;
    forbidden(res);
  });

  mountSessionContextRoute(router, db);

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

  router.post("/activity/chat-demand", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const activity = chatActivityBody(req);
    if (!activity) {
      res.status(400).json({ error: "invalid_chat_activity" });
      return;
    }
    const result = await requestChatActivityDemand(db, bound.gatewayId, activity);
    res.status(result.statusCode).json(result.body);
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

async function activeReplyRecipient(db: Firestore, uid: string) {
  if (!safeDocId(uid)) return null;
  const recipient = await db.doc(`users/${uid}`).get();
  const mmUserId = readPath(recipient.data() ?? {}, "mattermost.userId");
  if (!recipient.exists || !accountAllowsInteractiveAccess(recipient.data()) || typeof mmUserId !== "string"
    || !MATTERMOST_ID_RE.test(mmUserId)) return null;
  return { uid, mmUserId };
}

async function finalReplyMembershipAuthorized(db: Firestore, target: AuthorizedConversationTarget, identity: FinalReplyIdentity, recipient: { uid: string; mmUserId: string }): Promise<boolean> {
  const binding = boundChannelPath(target.channelDocPath);
  if (!binding) return false;
  if (binding.lane === "project") {
    const [project, membership] = await Promise.all([
      db.doc(binding.ownerPath).get(), db.doc(`${binding.ownerPath}/members/${recipient.uid}`).get(),
    ]);
    const member = membership.data();
    return project.data()?.ownerUid === recipient.uid || (membership.exists && member?.id === recipient.uid
      && (member.role === "owner" || member.role === "member"));
  }
  if (recipient.uid === identity.uid) return true;
  const membership = await db.doc(`workspaces/${binding.workspaceSlug}/members/${recipient.uid}`).get();
  return isCanonicalWorkspaceMembership(membership.data()) && membership.data()?.mattermostUserId === recipient.mmUserId;
}

async function resolveFinalReplyTarget(
  db: Firestore,
  gatewayId: string,
  identity: FinalReplyIdentity,
  channelId: string,
  directPeerId?: string,
): Promise<FinalReplyTarget | null> {
  const owner = await activeReplyRecipient(db, identity.uid);
  if (!owner) return null;
  if (directPeerId !== undefined) {
    if (parseAgentId(identity.agentId).kind !== "coach" || owner.mmUserId !== directPeerId || directPeerId === identity.coachMmUserId) return null;
    return { primaryChannelId: channelId, expectedChannelType: "D", expectedChannelName: null, expectedChannelTeamId: null,
      expectedMemberIds: [identity.coachMmUserId, directPeerId], recipientUid: identity.uid, recipientMmUserId: directPeerId };
  }
  const target = await resolveAuthorizedConversationTarget(db, gatewayId, identity.agentId, channelId);
  if (!target || target === "forbidden") return null;
  const recipientUid = await resolveChannelOwnerUid(db, gatewayId, channelId);
  if (!recipientUid || recipientUid === "forbidden") return null;
  const recipient = await activeReplyRecipient(db, recipientUid);
  if (!recipient || recipient.mmUserId === identity.coachMmUserId || !await finalReplyMembershipAuthorized(db, target, identity, recipient)) return null;
  return { ...target, recipientUid, recipientMmUserId: recipient.mmUserId };
}

function mountFinalReplyRoutes(router: Router, db: Firestore): void {
  router.post("/notifications/final-reply", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const body = { ...req.body };
    delete body.gatewayId;
    const input = parseFinalReply(body);
    if (!input) { res.status(422).json({ error: "invalid_final_reply" }); return; }
    try {
      await notifyNativeFinalReply(input, {
        resolveAgentIdentity: async agentId => {
          const identity = await resolveAgentIdentity(db, bound.gatewayId, agentId);
          return identity === "forbidden" ? null : identity;
        },
        resolveReplyTarget: (identity, channelId, peerId) => resolveFinalReplyTarget(db, bound.gatewayId, identity, channelId, peerId),
        getPost: readFinalReplyPost,
        verifyChannel: verifyFinalReplyChannel,
        notify: async (signal, uid) => {
          const result = await fanOutNotification(buildCoachDmEvent({ ...signal, createdAt: 0 }), [uid]);
          if (result.failed.length) throw new Error("final reply notification delivery failed");
        },
      });
      res.status(202).json({ accepted: true });
    } catch (error) {
      if (error instanceof ReplyBindingDeniedError) { res.status(403).json({ error: "reply_binding_denied" }); return; }
      logger.warn("Final reply notification failed", { messageId: input.messageId, error: error instanceof Error ? error.message : String(error) });
      res.status(503).json({ error: "reply_notification_unavailable", retryable: true });
    }
  });
}

export function createOpenClawRuntimeBrokerRoutes(opts: {
  db: Firestore;
}): Router {
  const router = Router();
  const { db } = opts;
  mountUserAndWsRoutes(router, db);
  mountActivityRoutes(router, db);
  mountFinalReplyRoutes(router, db);
  return router;
}
