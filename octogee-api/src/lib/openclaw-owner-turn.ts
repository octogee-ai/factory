import type { Request } from "express";
import type { Firestore } from "firebase-admin/firestore";

import {
  isValidCustomChannelName,
  parseAgentId,
  workspaceCoachMmUsername,
} from "@octogee/shared/types/identity";

const MATTERMOST_ID_RE = /^[a-z0-9]{26}$/u;
const REQUEST_CONTEXT_FIELDS = new Set([
  "channel",
  "accountId",
  "requesterSenderId",
  "nativeChannelId",
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

interface OwnerWorkspaceRequestContext {
  channel: "mattermost";
  accountId: string;
  requesterSenderId: string;
  nativeChannelId: string;
  routeKind: "user" | "channel";
  routeId: string;
}

interface RequestContextRecord extends Record<string, unknown> {
  channel: "mattermost";
  accountId: string;
  requesterSenderId: string;
  nativeChannelId: string;
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

function isRequestContextRecord(
  context: Record<string, unknown> | null,
): context is RequestContextRecord {
  return Boolean(
    context
    && Object.keys(context).length === REQUEST_CONTEXT_FIELDS.size
    && Object.keys(context).every((key) => REQUEST_CONTEXT_FIELDS.has(key))
    && context.channel === "mattermost"
    && typeof context.accountId === "string"
    && typeof context.requesterSenderId === "string"
    && MATTERMOST_ID_RE.test(context.requesterSenderId)
    && typeof context.nativeChannelId === "string"
    && MATTERMOST_ID_RE.test(context.nativeChannelId)
    && typeof context.to === "string",
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

function requestContext(req: Request): OwnerWorkspaceRequestContext | null {
  const body = record(req.body);
  const queryValue = req.query?.requestContext;
  const bodyHasContext = body && Object.hasOwn(body, "requestContext");
  if (bodyHasContext && queryValue !== undefined) return null;
  const context = record(body?.requestContext ?? parseQueryContext(queryValue));
  if (!isRequestContextRecord(context)) return null;
  const route = parseRoute(context.to);
  if (!route) return null;

  return {
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

async function isCanonicalProjectChannel(
  db: Firestore,
  channelId: string,
  slug: string,
  project: string,
): Promise<boolean> {
  const snap = await db
    .collectionGroup("channels")
    .where("mattermost.channelId", "==", channelId)
    .limit(2)
    .get();
  if (snap.docs.length !== 1) return false;
  const channel = snap.docs[0];
  return channel.ref.path === `workspaces/${slug}/projects/${project}/channels/general`
    && channelIsActive(channel.data() ?? {});
}
export function createOwnerWorkspaceTurnVerifier(
  db: Firestore,
): OwnerWorkspaceTurnVerifier {
  return async ({ req, agentId, ownerUid, assignedData }) => {
    const parsed = parseAgentId(agentId);
    const context = requestContext(req);
    if (
      parsed.kind !== "coach"
      || !context
      || context.accountId !== workspaceCoachMmUsername(parsed.username)
      || assignedData.workspaceId !== parsed.username
      || assignedMattermostUserId(assignedData) !== context.requesterSenderId
    ) return false;

    const workspace = await db.doc(`workspaces/${parsed.username}`).get();
    if (!workspace.exists || workspace.data()?.ownerUid !== ownerUid
      || workspace.data()?.ownerActive !== true) return false;

    const channelName = await workspaceChannelName(
      db,
      context.nativeChannelId,
      parsed.username,
    );
    if (!channelName) return false;
    if (context.routeKind === "user") {
      return context.routeId === context.requesterSenderId && channelName === "coach-dm";
    }
    return context.routeId === context.nativeChannelId;
  };
}

async function projectSenderAuthorized(db: Firestore, ownerUid: string, assignedData: Record<string, unknown>, senderId: string): Promise<boolean> {
  if (assignedMattermostUserId(assignedData) === senderId) return true;
  const coach = await db.doc(`agents/${ownerUid}`).get();
  return coach.data()?.mattermost?.userId === senderId;
}

export function createProjectWorkspaceTurnVerifier(
  db: Firestore,
): OwnerWorkspaceTurnVerifier {
  return async ({ req, agentId, ownerUid, assignedData }) => {
    const parsed = parseAgentId(agentId);
    const context = requestContext(req);
    if (
      parsed.kind !== "project"
      || !context
      || context.accountId !== `${parsed.username}-proj-${parsed.project}`
      || assignedData.workspaceId !== parsed.username
      || context.routeKind !== "channel"
      || context.routeId !== context.nativeChannelId
    ) return false;

    const workspace = await db.doc(`workspaces/${parsed.username}`).get();
    if (!workspace.exists || workspace.data()?.ownerUid !== ownerUid
      || workspace.data()?.ownerActive !== true) return false;

    if (!await projectSenderAuthorized(db, ownerUid, assignedData, context.requesterSenderId)) return false;
    return isCanonicalProjectChannel(
      db,
      context.nativeChannelId,
      parsed.username,
      parsed.project,
    );
  };
}
