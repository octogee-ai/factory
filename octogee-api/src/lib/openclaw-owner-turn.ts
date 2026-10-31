import type { Request } from "express";
import type { Firestore } from "firebase-admin/firestore";

import { isCanonicalWorkspaceMembership } from "@octogee/core/gateway-principal-access";
import {
  isValidCustomChannelName,
  parseAgentId,
  workspaceCoachMmUsername,
} from "@octogee/shared/types/identity";

import { isRunnableProject } from "./project-runs/active-project.js";

const MATTERMOST_ID_RE = /^[a-z0-9]{26}$/u;
const REQUEST_CONTEXT_FIELDS = new Set([
  "channel",
  "accountId",
  "requesterSenderId",
  "nativeChannelId",
  "to",
]);
const SCHEDULED_REQUEST_CONTEXT_FIELDS = new Set([
  "origin",
  "channel",
  "accountId",
  "requesterSenderId",
  "to",
]);

export interface OwnerWorkspaceTurnInput {
  req: Request;
  gatewayId: string;
  agentId: string;
  ownerUid: string;
  assignedData: Record<string, unknown>;
}

export type OwnerWorkspaceTurnVerifier = (
  input: OwnerWorkspaceTurnInput,
) => Promise<boolean>;

type OwnerWorkspaceRequestContext =
  | {
    origin: "turn";
    channel: "mattermost";
    accountId: string;
    requesterSenderId: string;
    nativeChannelId: string;
    routeKind: "user" | "channel";
    routeId: string;
  }
  | {
    origin: "scheduled";
    channel: "mattermost";
    accountId: string;
    requesterSenderId: string;
    routeKind: "user" | "channel";
    routeId: string;
  };

interface RequestContextRecord extends Record<string, unknown> {
  channel: "mattermost";
  accountId: string;
  requesterSenderId: string;
  nativeChannelId: string;
  to: string;
}

interface ScheduledRequestContextRecord extends Record<string, unknown> {
  origin: "scheduled";
  channel: "mattermost";
  accountId: string;
  requesterSenderId: string;
  to: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readPath(value: Record<string, unknown>, path: string): unknown {
  let current: unknown = value;
  for (const segment of path.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function parseQueryContext(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (value.length > 2048) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function hasExactFields(context: Record<string, unknown>, fields: Set<string>): boolean {
  return Object.keys(context).length === fields.size
    && Object.keys(context).every((key) => fields.has(key));
}

function hasMattermostSender(context: Record<string, unknown>): boolean {
  return context.channel === "mattermost"
    && typeof context.accountId === "string"
    && typeof context.requesterSenderId === "string"
    && MATTERMOST_ID_RE.test(context.requesterSenderId)
    && typeof context.to === "string";
}

function isRequestContextRecord(
  context: Record<string, unknown> | null,
): context is RequestContextRecord {
  return Boolean(
    context
    && hasExactFields(context, REQUEST_CONTEXT_FIELDS)
    && hasMattermostSender(context)
    && typeof context.nativeChannelId === "string"
    && MATTERMOST_ID_RE.test(context.nativeChannelId),
  );
}

function isScheduledRequestContextRecord(
  context: Record<string, unknown> | null,
): context is ScheduledRequestContextRecord {
  return Boolean(
    context
    && hasExactFields(context, SCHEDULED_REQUEST_CONTEXT_FIELDS)
    && context.origin === "scheduled"
    && hasMattermostSender(context),
  );
}

function parseRoute(to: string): { routeKind: "user" | "channel"; routeId: string } | null {
  const separator = to.indexOf(":");
  if (separator < 0) return null;
  const routeKind = to.slice(0, separator);
  const routeId = to.slice(separator + 1);
  if (
    (routeKind !== "user" && routeKind !== "channel")
    || !MATTERMOST_ID_RE.test(routeId)
  ) return null;
  return { routeKind, routeId };
}

export function ownerWorkspaceRequestContext(req: Request): OwnerWorkspaceRequestContext | null {
  const body = record(req.body);
  const queryValue = req.query?.requestContext;
  const bodyHasContext = body && Object.hasOwn(body, "requestContext");
  if (bodyHasContext && queryValue !== undefined) return null;
  const context = record(body?.requestContext ?? parseQueryContext(queryValue));
  if (isScheduledRequestContextRecord(context)) {
    const route = parseRoute(context.to);
    return route
      ? {
        origin: "scheduled",
        channel: "mattermost",
        accountId: context.accountId,
        requesterSenderId: context.requesterSenderId,
        ...route,
      }
      : null;
  }
  if (!isRequestContextRecord(context)) return null;
  const route = parseRoute(context.to);
  if (!route) return null;

  return {
    origin: "turn",
    channel: "mattermost",
    accountId: context.accountId,
    requesterSenderId: context.requesterSenderId,
    nativeChannelId: context.nativeChannelId,
    ...route,
  };
}

function assignedMattermostUserId(data: Record<string, unknown>): string | null {
  const userId = readPath(data, "mattermost.userId");
  return typeof userId === "string" && MATTERMOST_ID_RE.test(userId) ? userId : null;
}

function directWorkspaceChannel(path: unknown, slug: string): string | null {
  if (typeof path !== "string") return null;
  const parts = path.split("/");
  if (
    parts.length !== 4
    || parts[0] !== "workspaces"
    || parts[1] !== slug
    || parts[2] !== "channels"
  ) return null;
  const channelName = parts[3];
  if (
    channelName === "admin"
    || (
      channelName !== "general"
      && channelName !== "coach-dm"
      && !isValidCustomChannelName(channelName)
    )
  ) return null;
  return channelName;
}

function channelIsActive(data: Record<string, unknown>): boolean {
  return (data.archivedAt === undefined || data.archivedAt === null)
    && data.status !== "archived"
    && readPath(data, "commercialLifecycle.status") !== "archived";
}

async function workspaceChannelName(
  db: Firestore,
  channelId: string,
  slug: string,
): Promise<string | null> {
  const snap = await db
    .collectionGroup("channels")
    .where("mattermost.channelId", "==", channelId)
    .limit(2)
    .get();
  if (snap.docs.length !== 1) return null;
  const channel = snap.docs[0];
  const channelName = directWorkspaceChannel(channel.ref.path, slug);
  if (!channelName || !channelIsActive(channel.data() ?? {})) return null;
  return channelName;
}

async function isActiveWorkspaceMember(
  db: Firestore,
  slug: string,
  senderId: string,
): Promise<boolean> {
  const snap = await db
    .collection(`workspaces/${slug}/members`)
    .where("mattermostUserId", "==", senderId)
    .limit(2)
    .get();
  return snap.docs.length === 1 && isCanonicalWorkspaceMembership(snap.docs[0].data());
}

async function trustedWorkspaceSender(
  db: Firestore,
  slug: string,
  assignedData: Record<string, unknown>,
  senderId: string,
): Promise<boolean> {
  if (assignedMattermostUserId(assignedData) === senderId) return true;
  return isActiveWorkspaceMember(db, slug, senderId);
}

export function isOwnerDirectRoute(
  context: Pick<OwnerWorkspaceRequestContext, "routeKind" | "routeId" | "requesterSenderId">,
  assignedData: Record<string, unknown>,
): boolean {
  return context.routeKind === "user"
    && context.routeId === context.requesterSenderId
    && assignedMattermostUserId(assignedData) === context.requesterSenderId;
}

export function createGoogleTurnVerifier(
  db: Firestore,
): OwnerWorkspaceTurnVerifier {
  return async ({ req, agentId, ownerUid, assignedData }) => {
    const parsed = parseAgentId(agentId);
    const context = ownerWorkspaceRequestContext(req);
    if (
      parsed.kind !== "coach"
      || !context
      || context.accountId !== workspaceCoachMmUsername(parsed.username)
      || assignedData.workspaceId !== parsed.username
    ) return false;

    const workspace = await db.doc(`workspaces/${parsed.username}`).get();
    if (!workspace.exists || workspace.data()?.ownerUid !== ownerUid
      || workspace.data()?.ownerActive !== true) return false;

    if (context.origin === "scheduled") return isOwnerDirectRoute(context, assignedData);

    const channelName = await workspaceChannelName(
      db,
      context.nativeChannelId,
      parsed.username,
    );
    if (!channelName) return false;
    if (context.routeKind === "user") {
      return channelName === "coach-dm" && isOwnerDirectRoute(context, assignedData);
    }
    if (context.routeId !== context.nativeChannelId) return false;
    return trustedWorkspaceSender(db, parsed.username, assignedData, context.requesterSenderId);
  };
}

async function activeOwnedWorkspace(db: Firestore, slug: string, ownerUid: string): Promise<boolean> {
  const workspace = await db.doc(`workspaces/${slug}`).get();
  return workspace.exists
    && workspace.data()?.ownerUid === ownerUid
    && workspace.data()?.ownerActive === true;
}

export function createOwnerWorkspaceTurnVerifier(
  db: Firestore,
): OwnerWorkspaceTurnVerifier {
  return async ({ agentId, ownerUid, assignedData }) => {
    const parsed = parseAgentId(agentId);
    if (parsed.kind !== "coach" || assignedData.workspaceId !== parsed.username) return false;
    return activeOwnedWorkspace(db, parsed.username, ownerUid);
  };
}

export function createProjectWorkspaceTurnVerifier(
  db: Firestore,
): OwnerWorkspaceTurnVerifier {
  return async ({ agentId, ownerUid, assignedData }) => {
    const parsed = parseAgentId(agentId);
    if (parsed.kind !== "project" || assignedData.workspaceId !== parsed.username) return false;
    if (!await activeOwnedWorkspace(db, parsed.username, ownerUid)) return false;
    const project = await db.doc(`workspaces/${parsed.username}/projects/${parsed.project}`).get();
    return project.exists && isRunnableProject(project.data() ?? {}, ownerUid);
  };
}

export function createAgentSupportTurnVerifier(
  db: Firestore,
): OwnerWorkspaceTurnVerifier {
  const verifyCoach = createOwnerWorkspaceTurnVerifier(db);
  const verifyProject = createProjectWorkspaceTurnVerifier(db);
  return async (turn) => {
    const kind = parseAgentId(turn.agentId).kind;
    if (kind === "project") return verifyProject(turn);
    if (kind === "coach") return verifyCoach(turn);
    return false;
  };
}
