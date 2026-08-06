import type { Request } from "express";
import type { Firestore } from "firebase-admin/firestore";

import {
  isValidCustomChannelName,
  parseAgentId,
  workspaceCoachMmUsername,
} from "@octogee/shared/types/identity";

const MATTERMOST_ID_RE = /^[a-z0-9]{26}$/u;
const REQUEST_CONTEXT_KEYS = new Set([
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

function requestContext(req: Request): OwnerWorkspaceRequestContext | null {
  const body = record(req.body);
  const context = record(body?.requestContext);
  if (
    !context
    || Object.keys(context).some((key) => !REQUEST_CONTEXT_KEYS.has(key))
    || context.channel !== "mattermost"
    || typeof context.accountId !== "string"
    || typeof context.requesterSenderId !== "string"
    || !MATTERMOST_ID_RE.test(context.requesterSenderId)
    || typeof context.nativeChannelId !== "string"
    || !MATTERMOST_ID_RE.test(context.nativeChannelId)
    || typeof context.to !== "string"
  ) return null;

  const separator = context.to.indexOf(":");
  if (separator < 0) return null;
  const routeKind = context.to.slice(0, separator);
  const routeId = context.to.slice(separator + 1);
  if (
    (routeKind !== "user" && routeKind !== "channel")
    || !MATTERMOST_ID_RE.test(routeId)
  ) return null;

  return {
    channel: "mattermost",
    accountId: context.accountId,
    requesterSenderId: context.requesterSenderId,
    nativeChannelId: context.nativeChannelId,
    routeKind,
    routeId,
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
    && readPath(data, "commercialLifecycle.status") !== "archived"
    && readPath(data, "mattermost.activityPair.desired") !== "archived";
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
    if (!workspace.exists || workspace.data()?.ownerUid !== ownerUid) return false;

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
