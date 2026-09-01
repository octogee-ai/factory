import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  AgentIdentity,
  AuthorizedConversationTarget,
} from "./activity-runtime-types.js";
import type { ActivityMattermostClient, ActivityMattermostPost } from "./mm-client.js";
import { parseMattermostSessionRoute } from "./mattermost-session-route.js";

const MAX_BODY_BYTES = 16 * 1024;
const MATTERMOST_ID = /^[a-z0-9]{26}$/u;

export interface DirectActivityTargetCandidate {
  sessionKey: string;
  agentId: string;
  ownerUserId: string;
  rootPostId: string;
  inboundPostId: string;
  nativeChannelId?: string;
}

export interface DirectActivityTarget {
  sessionKey: string;
  agentId: string;
  conversationId: string;
  rootPostId: string;
}

export interface DirectActivityTargetDeps {
  resolveAgentIdentity(agentId: string): Promise<AgentIdentity | null>;
  resolveDirectConversationTarget(
    agentId: string,
    conversationId: string,
    ownerUserId: string,
  ): Promise<AuthorizedConversationTarget | null>;
  mmClientFor(token: string): ActivityMattermostClient;
  verifyChannel(identity: AgentIdentity, target: AuthorizedConversationTarget): Promise<number>;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exactString(value: unknown): string | null {
  return typeof value === "string" && value.trim() === value && value.length > 0 ? value : null;
}

function directCandidateFields(body: Record<string, unknown>): DirectActivityTargetCandidate | null {
  const sessionKey = exactString(body.sessionKey);
  const agentId = exactString(body.agentId);
  const ownerUserId = exactString(body.ownerUserId);
  const rootPostId = exactString(body.rootPostId);
  const inboundPostId = exactString(body.inboundPostId);
  const nativeChannelId = body.nativeChannelId === undefined
    ? undefined
    : exactString(body.nativeChannelId);
  if ([sessionKey, agentId, ownerUserId, rootPostId, inboundPostId].some((value) => !value)) return null;
  if (body.nativeChannelId !== undefined && !nativeChannelId) return null;
  const mattermostIds = [ownerUserId, rootPostId, inboundPostId, nativeChannelId]
    .filter((value): value is string => Boolean(value));
  if (mattermostIds.some((value) => !MATTERMOST_ID.test(value))) return null;
  return {
    sessionKey: sessionKey!,
    agentId: agentId!,
    ownerUserId: ownerUserId!,
    rootPostId: rootPostId!,
    inboundPostId: inboundPostId!,
    ...(nativeChannelId ? { nativeChannelId } : {}),
  };
}

function candidateMatchesNativeRoute(candidate: DirectActivityTargetCandidate): boolean {
  const route = parseMattermostSessionRoute(candidate.sessionKey);
  return Boolean(
    route
    && route.peerKind === "direct"
    && route.agentId === candidate.agentId
    && route.primaryChannelId === candidate.ownerUserId
    && route.threadRootPostId === candidate.rootPostId,
  );
}

export function parseDirectActivityTargetCandidate(value: unknown): DirectActivityTargetCandidate | null {
  const body = record(value);
  if (!body) return null;
  const allowed = new Set([
    "sessionKey",
    "agentId",
    "ownerUserId",
    "rootPostId",
    "inboundPostId",
    "nativeChannelId",
  ]);
  if (Object.keys(body).some((key) => !allowed.has(key))) return null;
  const candidate = directCandidateFields(body);
  return candidate && candidateMatchesNativeRoute(candidate) ? candidate : null;
}

function authorizedAgentIdentity(
  identity: AgentIdentity | null,
  candidate: DirectActivityTargetCandidate,
): identity is AgentIdentity {
  return Boolean(
    identity
    && identity.agentId === candidate.agentId
    && MATTERMOST_ID.test(identity.coachMmUserId)
    && identity.coachMmUserId !== candidate.ownerUserId
    && identity.coachToken,
  );
}

function inboundPostMatchesCandidate(
  inbound: ActivityMattermostPost | null,
  candidate: DirectActivityTargetCandidate,
): inbound is ActivityMattermostPost {
  return Boolean(
    inbound
    && inbound.id === candidate.inboundPostId
    && inbound.userId === candidate.ownerUserId
    && MATTERMOST_ID.test(inbound.channelId),
  );
}

function postsShareNativeThread(
  inbound: ActivityMattermostPost,
  root: ActivityMattermostPost | null,
  candidate: DirectActivityTargetCandidate,
): root is ActivityMattermostPost {
  if (!root || root.id !== candidate.rootPostId || root.channelId !== inbound.channelId) return false;
  if (root.rootId !== "") return false;
  return candidate.inboundPostId === candidate.rootPostId
    ? inbound.rootId === ""
    : inbound.rootId === candidate.rootPostId;
}

async function directMattermostPosts(
  candidate: DirectActivityTargetCandidate,
  mm: ActivityMattermostClient,
): Promise<{ inbound: ActivityMattermostPost; root: ActivityMattermostPost } | null> {
  const inbound = await mm.getPost(candidate.inboundPostId);
  if (!inboundPostMatchesCandidate(inbound, candidate)) return null;
  if (candidate.nativeChannelId && candidate.nativeChannelId !== inbound.channelId) return null;
  const root = candidate.rootPostId === candidate.inboundPostId
    ? inbound
    : await mm.getPost(candidate.rootPostId);
  return postsShareNativeThread(inbound, root, candidate) ? { inbound, root } : null;
}

function authorizedDirectTarget(
  target: AuthorizedConversationTarget | null,
  identity: AgentIdentity,
  candidate: DirectActivityTargetCandidate,
  posts: { inbound: ActivityMattermostPost; root: ActivityMattermostPost },
): target is AuthorizedConversationTarget {
  const expectedMembers = target?.expectedMemberIds ?? [];
  return Boolean(
    target
    && target.primaryChannelId === posts.inbound.channelId
    && target.expectedChannelType === "D"
    && expectedMembers.length === 2
    && expectedMembers.includes(identity.coachMmUserId)
    && expectedMembers.includes(candidate.ownerUserId)
    && posts.root.userId
    && expectedMembers.includes(posts.root.userId),
  );
}

export async function resolveDirectActivityTarget(
  candidate: DirectActivityTargetCandidate,
  deps: DirectActivityTargetDeps,
): Promise<DirectActivityTarget | null> {
  const identity = await deps.resolveAgentIdentity(candidate.agentId);
  if (!authorizedAgentIdentity(identity, candidate)) return null;
  const mm = deps.mmClientFor(identity.coachToken);
  const posts = await directMattermostPosts(candidate, mm);
  if (!posts) return null;
  const target = await deps.resolveDirectConversationTarget(
    candidate.agentId,
    posts.inbound.channelId,
    candidate.ownerUserId,
  );
  if (!authorizedDirectTarget(target, identity, candidate, posts)) return null;
  await deps.verifyChannel(identity, target);
  return {
    sessionKey: candidate.sessionKey,
    agentId: candidate.agentId,
    conversationId: posts.inbound.channelId,
    rootPostId: candidate.rootPostId,
  };
}

function isLoopback(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  const address = remoteAddress.startsWith("::ffff:")
    ? remoteAddress.slice("::ffff:".length)
    : remoteAddress;
  return address === "127.0.0.1" || address === "::1";
}

function authorized(value: string | undefined, expected: string): boolean {
  const token = value?.startsWith("Bearer ") ? value.slice("Bearer ".length) : "";
  const actual = Buffer.from(token);
  const target = Buffer.from(expected);
  return actual.length === target.length && timingSafeEqual(actual, target);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += body.length;
    if (bytes > MAX_BODY_BYTES) throw new Error("body_too_large");
    chunks.push(body);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new Error("invalid_json");
  }
}

function writeJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export function createDirectActivityTargetHandler(params: {
  gatewayToken: string;
  deps: DirectActivityTargetDeps;
  log?: (message: string, fields: Record<string, unknown>) => void;
}): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const gatewayToken = params.gatewayToken.trim();
  if (!gatewayToken) throw new Error("direct Activity target gateway token is required");
  const log = params.log ?? (() => undefined);
  return async (req, res) => {
    if (req.method !== "POST") {
      req.resume();
      writeJson(res, 405, { error: "method_not_allowed" });
      return;
    }
    if (!isLoopback(req.socket.remoteAddress) || !authorized(req.headers.authorization, gatewayToken)) {
      req.resume();
      writeJson(res, 401, { error: "unauthorized" });
      return;
    }
    try {
      const candidate = parseDirectActivityTargetCandidate(await readJson(req));
      if (!candidate) {
        writeJson(res, 422, { error: "invalid_direct_activity_target" });
        return;
      }
      const target = await resolveDirectActivityTarget(candidate, params.deps);
      if (!target) {
        writeJson(res, 404, { error: "not_found" });
        return;
      }
      writeJson(res, 200, { target });
    } catch (error) {
      log("direct Activity target resolution failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      writeJson(res, 503, { error: "direct_activity_target_unavailable", retryable: true });
    }
  };
}
