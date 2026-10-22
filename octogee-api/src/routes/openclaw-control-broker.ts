import { createHash } from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import {
  Timestamp,
  type DocumentData,
  type DocumentReference,
  type Firestore,
  type Transaction,
} from "firebase-admin/firestore";

import { userAssignmentMatchesGateway } from "@octogee/core/assigned-roster";
import { gatewayAuthorizationFromRootDocument } from "@octogee/core/gateway-live-release";
import {
  OPENCLAW_CONTROL_TICKETS_COLLECTION,
  inspectOpenClawControlTicket,
  openClawControlTicketHash,
  type OpenClawControlTicketInspection,
} from "@octogee/core/openclaw-control-tickets";
import { isOpenClawControlRevisionRuntimeReady } from "@octogee/core/openclaw-control-runtime-ready";
import {
  resolveGatewayPrincipalAccess,
  type GatewayPrincipalAccess,
  workspacePermissionsEnabled,
  type ResolvedGatewayAccess,
} from "@octogee/core/gateway-principal-access";
import {
  isGatewayRuntimeDoc,
  projectGatewayDesiredRootForGateway,
} from "@octogee/shared/types/gateway-releases";
import { isGatewayClassControlUiAccessEnabled, resolveGatewayClass } from "@octogee/shared/types/glm";
import { revisionIdFromGatewayPodName } from "../lib/gateway-pod-revision.js";
import { setGatewayAccessDenialAudit } from "../../../gateway-edge/src/lib/gateway-access-audit.js";

type GatewayBinding = Extract<Express.Request["boundTenant"], { kind: "gateway" }>;

export const OPENCLAW_CONTROL_SESSIONS_COLLECTION = "openclawControlSessions";
export const OPENCLAW_CONTROL_SESSION_TTL_MS = 60 * 60_000;
export const OPENCLAW_CONTROL_REQUEST_MAX_BYTES = 16 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CAPABILITY_DISABLED = "capability-disabled";
const INVALID_REQUEST = "invalid-request";
const ASSIGNMENT_MISSING = "assignment-missing";

interface ControlSession {
  uid: string;
  gatewayId: string;
  workspaceSlug: string;
  revisionId: string;
  expiresAt: number;
}

type SessionAccess =
  | { kind: "allowed"; session: ControlSession }
  | { kind: "session-invalid" }
  | { kind: "capability-disabled" }
  | { kind: typeof ASSIGNMENT_MISSING }
  | { kind: "not-ready" };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

function boundedString(value: unknown, maxLength: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength
    ? value
    : null;
}

function validSessionId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function requestFits(req: Request): boolean {
  const encoded = JSON.stringify(req.body ?? null);
  return Buffer.byteLength(encoded, "utf8") <= OPENCLAW_CONTROL_REQUEST_MAX_BYTES;
}

function authenticatedGateway(req: Request): { bound: GatewayBinding; revisionId: string } | null {
  const bound = req.boundTenant;
  const revisionId = bound?.kind === "gateway"
    ? revisionIdFromGatewayPodName(bound.gatewayId, bound.podName)
    : null;
  return bound?.kind === "gateway" && revisionId ? { bound, revisionId } : null;
}

function boundGateway(req: Request, res: Response): GatewayBinding | null {
  const body = record(req.body);
  const authenticated = authenticatedGateway(req);
  const claimedGateway = boundedString(body?.gatewayId, 32);
  const claimedRevision = boundedString(body?.revisionId, 64);
  if (
    !authenticated ||
    claimedGateway !== authenticated.bound.gatewayId ||
    !claimedRevision ||
    claimedRevision !== authenticated.revisionId
  ) {
    res.status(403).json({ error: "forbidden" });
    return null;
  }
  return authenticated.bound;
}

function controlUiAuthorization(
  root: unknown,
  gatewayId: string,
  access: ResolvedGatewayAccess,
) {
  const authorization = gatewayAuthorizationFromRootDocument(root, gatewayId);
  if (!authorization) return null;
  const config = authorization.config;
  if (!access.dashboard) return null;
  const gatewayClass = resolveGatewayClass({
    gatewayClass: config.gatewayClass,
    profile: config.profile ?? undefined,
    imageProfile: config.imageProfile,
  });
  return isGatewayClassControlUiAccessEnabled(gatewayClass, config.builderAccess ?? undefined)
    ? authorization
    : null;
}

interface ScopedPrincipalAccess {
  scope: { gatewayId: string; workspaceSlug: string; ownerUid: string; perUserIdentity: boolean };
  principal: GatewayPrincipalAccess | null;
  assignmentMissing: boolean;
  assignmentServing: boolean;
}

type GatewayRootAuthorization = NonNullable<ReturnType<typeof gatewayAuthorizationFromRootDocument>>;

async function storedOwnerScope(
  args: {
    db: Firestore;
    tx: Transaction;
    gatewayId: string;
    workspaceSlug: string;
    now: number;
  },
  authorization: GatewayRootAuthorization,
): Promise<Omit<ScopedPrincipalAccess, "principal"> | null> {
  const gatewayClass = resolveGatewayClass({
    gatewayClass: authorization.config.gatewayClass,
    profile: authorization.config.profile ?? undefined,
    imageProfile: authorization.config.imageProfile,
  });
  if (gatewayClass !== "shared" && authorization.config.builderSlug !== args.workspaceSlug) {
    return null;
  }
  const workspace = await args.tx.get(args.db.doc(`workspaces/${args.workspaceSlug}`));
  const ownerUid = gatewayClass === "shared"
    ? workspace.data()?.ownerUid
    : authorization.config.ownerUid;
  if (typeof ownerUid !== "string" || !ownerUid) return null;
  const workspaceData = workspace.data();
  const [owner, assignment] = await Promise.all([
    args.tx.get(args.db.doc(`users/${ownerUid}`)),
    args.tx.get(args.db.doc(`gateways/${args.gatewayId}/assignments/${ownerUid}`)),
  ]);
  const scope = { gatewayId: args.gatewayId, workspaceSlug: args.workspaceSlug, ownerUid,
    perUserIdentity: workspaceData?.ownerUid === ownerUid &&
      workspacePermissionsEnabled(authorization.config, owner.data() ?? {}, new Date(args.now)),
  };
  return {
    scope,
    assignmentServing: assignment.data()?.state === "serving",
    assignmentMissing: !owner.exists || !userAssignmentMatchesGateway(
      owner.data(),
      args.gatewayId,
      args.workspaceSlug,
    ),
  };
}

async function storedMemberPrincipal(
  args: {
    db: Firestore;
    tx: Transaction;
    uid: string;
    now: number;
  },
  scope: ScopedPrincipalAccess["scope"],
): Promise<GatewayPrincipalAccess> {
  const memberSnap = await args.tx.get(args.db.doc(`workspaces/${scope.workspaceSlug}/members/${args.uid}`));
  return resolveGatewayPrincipalAccess({ gateway: scope, uid: args.uid, membership: memberSnap.exists ? memberSnap.data() : null });
}

async function storedPrincipalAccess(args: {
  db: Firestore;
  tx: Transaction;
  root: unknown;
  gatewayId: string;
  workspaceSlug: string;
  uid: string;
  now: number;
}): Promise<ScopedPrincipalAccess | null> {
  const authorization = gatewayAuthorizationFromRootDocument(args.root, args.gatewayId);
  if (!authorization) return null;
  const storedScope = await storedOwnerScope(args, authorization);
  if (!storedScope) return null;
  if (storedScope.assignmentMissing) {
    return { ...storedScope, principal: null };
  }
  if (storedScope.scope.ownerUid === args.uid) {
    const principal = resolveGatewayPrincipalAccess({
      gateway: storedScope.scope,
      uid: args.uid,
      membership: null,
    });
    return principal.kind === "denied"
      ? null
      : { ...storedScope, principal };
  }
  const principal = await storedMemberPrincipal(args, storedScope.scope);
  return { ...storedScope, principal };
}

function auditPrincipalDenial(args: {
  db: Firestore;
  tx: Transaction;
  scope: { gatewayId: string; workspaceSlug: string; ownerUid: string; perUserIdentity: boolean };
  uid: string;
  principal: GatewayPrincipalAccess;
  now: number;
}): void {
  if (args.uid === args.scope.ownerUid) return;
  setGatewayAccessDenialAudit(args.db, args.tx, {
    ...args.scope,
    actorUid: args.uid,
    granteeUid: args.uid,
    reason: args.principal.kind === "denied" ? args.principal.reason : "binding_changed",
    source: "system",
    now: args.now,
  });
}

function isLiveServingRevision(
  root: unknown,
  revision: unknown,
  gatewayId: string,
  revisionId: string,
): boolean {
  const gateway = projectGatewayDesiredRootForGateway(root, gatewayId);
  return gateway !== null &&
    gateway.desiredStatus === "running" &&
    gateway.desiredRelease === gateway.liveRelease &&
    revisionId === gatewayId &&
    isGatewayRuntimeDoc(revision) &&
    revision.gatewayId === gatewayId &&
    revision.release === gateway.liveRelease &&
    revision.lifecycle === "serving";
}

function isReadyLiveServingRevision(
  root: unknown,
  revision: unknown,
  gatewayId: string,
  revisionId: string,
  now: number,
): boolean {
  return isLiveServingRevision(root, revision, gatewayId, revisionId) &&
    isOpenClawControlRevisionRuntimeReady(revision, { gatewayId, revisionId, now });
}

export function openClawControlSessionHash(sessionId: string): string {
  return createHash("sha256").update("openclaw-control-session\0").update(sessionId).digest("hex");
}

function parseSession(
  value: unknown,
  gatewayId: string,
  revisionId: string,
  now: number,
): ControlSession | null {
  const item = record(value);
  if (!item) return null;
  const uid = boundedString(item.uid, 128);
  const workspaceSlug = boundedString(item.workspaceSlug, 128);
  if (
    !uid ||
    !workspaceSlug ||
    item.gatewayId !== gatewayId ||
    item.revisionId !== revisionId ||
    typeof item.expiresAt !== "number" ||
    !Number.isFinite(item.expiresAt) ||
    item.expiresAt <= now
  ) {
    return null;
  }
  return {
    uid,
    gatewayId,
    workspaceSlug,
    revisionId,
    expiresAt: item.expiresAt,
  };
}

async function sessionAccessInTransaction(args: {
  db: Firestore;
  tx: Transaction;
  gatewayId: string;
  revisionId: string;
  sessionHash: string;
  now: number;
}): Promise<SessionAccess> {
  const [rootSnap, revisionSnap, sessionSnap] = await Promise.all([
    args.tx.get(args.db.doc(`gateways/${args.gatewayId}`)),
    args.tx.get(args.db.doc(`glmGateways/${args.revisionId}`)),
    args.tx.get(args.db.doc(`${OPENCLAW_CONTROL_SESSIONS_COLLECTION}/${args.sessionHash}`)),
  ]);
  const session = parseSession(
    sessionSnap.exists ? sessionSnap.data() : undefined,
    args.gatewayId,
    args.revisionId,
    args.now,
  );
  if (!session) return { kind: "session-invalid" };
  const root = rootSnap.data();
  const stored = await storedPrincipalAccess({
    db: args.db,
    tx: args.tx,
    root,
    gatewayId: args.gatewayId,
    workspaceSlug: session.workspaceSlug,
    uid: session.uid,
    now: args.now,
  });
  if (stored?.assignmentMissing) return { kind: ASSIGNMENT_MISSING };
  const principal = stored?.principal;
  if (!stored || !principal || principal.kind === "denied") {
    if (stored && principal) {
      auditPrincipalDenial({
        db: args.db,
        tx: args.tx,
        scope: stored.scope,
        uid: session.uid,
        principal,
        now: args.now,
      });
    }
    return { kind: CAPABILITY_DISABLED };
  }
  const authorization = controlUiAuthorization(root, args.gatewayId, principal);
  if (!authorization) return { kind: CAPABILITY_DISABLED };
  if (!stored.assignmentServing || !isLiveServingRevision(root, revisionSnap.data(), args.gatewayId, args.revisionId)) {
    return { kind: "not-ready" };
  }
  return { kind: "allowed", session };
}

function sendSessionAccessFailure(result: Exclude<SessionAccess, { kind: "allowed" }>, res: Response): void {
  if (result.kind === "session-invalid") {
    res.status(404).json({ error: "session-invalid" });
  } else if (result.kind === CAPABILITY_DISABLED) {
    res.status(403).json({ error: CAPABILITY_DISABLED });
  } else if (result.kind === ASSIGNMENT_MISSING) {
    res.status(403).json({ error: ASSIGNMENT_MISSING });
  } else {
    res.status(409).json({ error: "gateway-not-ready", retryable: true });
  }
}

interface BrokerContext {
  db: Firestore;
  now: () => number;
}

type AuthenticatedGateway = NonNullable<ReturnType<typeof authenticatedGateway>>;
type RedeemableTicket = Extract<OpenClawControlTicketInspection, { kind: "redeemable" }>;

interface RedeemAttempt {
  authenticated: AuthenticatedGateway;
  ticketHash: string;
  sessionHash: string;
  attemptAt: number;
}

type RedeemResult =
  | { kind: "ticket-invalid" }
  | { kind: "session-conflict" }
  | { kind: typeof CAPABILITY_DISABLED }
  | { kind: typeof ASSIGNMENT_MISSING }
  | { kind: "not-ready" }
  | { kind: "redeemed"; redeemed: RedeemableTicket; expiresAt: number };

function rejectRedeemAttempt(
  res: Response,
  rejection: { status: number; error: string },
): null {
  res.status(rejection.status).json({ error: rejection.error });
  return null;
}

function parseRedeemPayload(
  body: Record<string, unknown> | null,
  ticket: string | null,
  ticketHash: string | undefined,
): { sessionId: string; ticketHash: string } | null {
  if (
    body === null ||
    !exactKeys(body, ["gatewayId", "revisionId", "sessionId", "ticket"]) ||
    !validSessionId(body.sessionId) ||
    ticket === null ||
    ticketHash === undefined
  ) {
    return null;
  }
  return { sessionId: body.sessionId, ticketHash };
}

function validateRedeemAttempt(
  context: BrokerContext,
  req: Request,
  res: Response,
): RedeemAttempt | null {
  const authenticated = authenticatedGateway(req);
  if (!authenticated) {
    res.status(403).json({ error: "forbidden" });
    return null;
  }
  const body = record(req.body);
  const claimedGateway = boundedString(body?.gatewayId, 32);
  const claimedRevision = boundedString(body?.revisionId, 64);
  const ticket = boundedString(body?.ticket, 256);
  const ticketHash = ticket ? openClawControlTicketHash(ticket) : undefined;
  const attemptAt = context.now();
  if (!requestFits(req)) {
    return rejectRedeemAttempt(res, { status: 413, error: "request-too-large" });
  }
  if (!claimedGateway || !claimedRevision) {
    return rejectRedeemAttempt(res, { status: 403, error: "forbidden" });
  }
  if (claimedGateway !== authenticated.bound.gatewayId) {
    return rejectRedeemAttempt(res, { status: 403, error: "forbidden" });
  }
  if (claimedRevision !== authenticated.revisionId) {
    return rejectRedeemAttempt(res, { status: 403, error: "forbidden" });
  }
  const payload = parseRedeemPayload(body, ticket, ticketHash);
  if (!payload) {
    return rejectRedeemAttempt(res, { status: 400, error: INVALID_REQUEST });
  }
  return {
    authenticated,
    ticketHash: payload.ticketHash,
    sessionHash: openClawControlSessionHash(payload.sessionId),
    attemptAt,
  };
}

interface RedeemDocuments {
  root: DocumentData | undefined;
  revision: DocumentData | undefined;
  ticket: DocumentData | undefined;
  ticketRef: DocumentReference;
  sessionExists: boolean;
  sessionRef: DocumentReference;
}

async function loadRedeemDocuments(
  context: BrokerContext,
  attempt: RedeemAttempt,
  tx: Transaction,
): Promise<RedeemDocuments> {
  const gatewayId = attempt.authenticated.bound.gatewayId;
  const revisionId = attempt.authenticated.revisionId;
  const ticketRef = context.db.doc(
    `${OPENCLAW_CONTROL_TICKETS_COLLECTION}/${attempt.ticketHash}`,
  );
  const sessionRef = context.db.doc(
    `${OPENCLAW_CONTROL_SESSIONS_COLLECTION}/${attempt.sessionHash}`,
  );
  const [root, revision, ticket, session] = await Promise.all([
    tx.get(context.db.doc(`gateways/${gatewayId}`)),
    tx.get(context.db.doc(`glmGateways/${revisionId}`)),
    tx.get(ticketRef),
    tx.get(sessionRef),
  ]);
  return {
    root: root.data(),
    revision: revision.data(),
    ticket: ticket.exists ? ticket.data() : undefined,
    ticketRef,
    sessionExists: session.exists,
    sessionRef,
  };
}

function inspectRedeemDocuments(args: {
  attempt: RedeemAttempt;
  documents: RedeemDocuments;
}): RedeemableTicket | RedeemResult {
  const { attempt, documents } = args;
  const inspected = inspectOpenClawControlTicket({
    document: documents.ticket,
    gatewayId: attempt.authenticated.bound.gatewayId,
    revisionId: attempt.authenticated.revisionId,
    now: attempt.attemptAt,
  });
  if (inspected.kind === "rejected") return { kind: "ticket-invalid" };
  if (!documents.sessionExists) return inspected;
  return { kind: "session-conflict" };
}

function rejectRedeemPrincipal(args: {
  context: BrokerContext;
  attempt: RedeemAttempt;
  inspected: RedeemableTicket;
  principal: GatewayPrincipalAccess | null;
  scope: { gatewayId: string; workspaceSlug: string; ownerUid: string; perUserIdentity: boolean } | null;
  tx: Transaction;
}): RedeemResult {
  if (args.principal && args.scope) {
    auditPrincipalDenial({
      db: args.context.db,
      tx: args.tx,
      scope: args.scope,
      uid: args.inspected.uid,
      principal: args.principal,
      now: args.attempt.attemptAt,
    });
  }
  return { kind: CAPABILITY_DISABLED };
}

async function redeemPrincipalFailure(args: {
  context: BrokerContext;
  attempt: RedeemAttempt;
  inspected: RedeemableTicket;
  root: unknown;
  tx: Transaction;
}): Promise<RedeemResult | null> {
  const gatewayId = args.attempt.authenticated.bound.gatewayId;
  const stored = await storedPrincipalAccess({
    db: args.context.db,
    tx: args.tx,
    root: args.root,
    gatewayId,
    workspaceSlug: args.inspected.workspaceSlug,
    uid: args.inspected.uid,
    now: args.attempt.attemptAt,
  });
  if (stored?.assignmentMissing) {
    return { kind: ASSIGNMENT_MISSING };
  }
  const principal = stored?.principal ?? null;
  const authorization = principal && principal.kind !== "denied"
    ? controlUiAuthorization(args.root, gatewayId, principal)
    : null;
  if (!authorization || !principal || principal.kind === "denied") {
    return rejectRedeemPrincipal({ ...args, principal, scope: stored?.scope ?? null });
  }
  if (!stored?.assignmentServing) return { kind: "not-ready" };
  return null;
}

function persistRedeemedSession(args: {
  attempt: RedeemAttempt;
  documents: RedeemDocuments;
  inspected: RedeemableTicket;
  tx: Transaction;
}): RedeemResult {
  const { attempt, documents, inspected, tx } = args;
  const expiresAt = attempt.attemptAt + OPENCLAW_CONTROL_SESSION_TTL_MS;
  tx.update(documents.ticketRef, { redeemedAt: attempt.attemptAt });
  tx.set(documents.sessionRef, {
    uid: inspected.uid,
    gatewayId: attempt.authenticated.bound.gatewayId,
    workspaceSlug: inspected.workspaceSlug,
    revisionId: attempt.authenticated.revisionId,
    createdAt: attempt.attemptAt,
    expiresAt,
    expireAt: Timestamp.fromMillis(expiresAt),
  });
  return { kind: "redeemed", redeemed: inspected, expiresAt };
}

async function applyRedeemAttempt(
  context: BrokerContext,
  attempt: RedeemAttempt,
  tx: Transaction,
): Promise<RedeemResult> {
  const documents = await loadRedeemDocuments(context, attempt, tx);
  const inspected = inspectRedeemDocuments({ attempt, documents });
  if (inspected.kind !== "redeemable") return inspected;
  const principalFailure = await redeemPrincipalFailure({
    context,
    attempt,
    inspected,
    root: documents.root,
    tx,
  });
  if (principalFailure) return principalFailure;
  if (!isReadyLiveServingRevision(
    documents.root,
    documents.revision,
    attempt.authenticated.bound.gatewayId,
    attempt.authenticated.revisionId,
    attempt.attemptAt,
  )) return { kind: "not-ready" };
  return persistRedeemedSession({ attempt, documents, inspected, tx });
}

async function redeemAttemptInTransaction(
  context: BrokerContext,
  attempt: RedeemAttempt,
): Promise<RedeemResult> {
  return context.db.runTransaction((tx) => applyRedeemAttempt(context, attempt, tx));
}

function sendRedeemResult(result: RedeemResult, res: Response): void {
  if (result.kind === "not-ready") {
    res.status(409).json({ error: "gateway-not-ready", retryable: true });
    return;
  }
  if (result.kind !== "redeemed") {
    res.status(404).json({ error: "ticket-invalid" });
    return;
  }
  res.json({ ...result.redeemed, expiresAt: result.expiresAt });
}

async function redeemControlTicket(
  context: BrokerContext,
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const attempt = validateRedeemAttempt(context, req, res);
    if (!attempt) return;
    sendRedeemResult(await redeemAttemptInTransaction(context, attempt), res);
  } catch (err) {
    next(err);
  }
}

async function authorizeControlSession(
  context: BrokerContext,
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!requestFits(req)) {
    res.status(413).json({ error: "request-too-large" });
    return;
  }
  const bound = boundGateway(req, res);
  if (!bound) return;
  const body = record(req.body);
  if (
    !body ||
    !exactKeys(body, ["gatewayId", "revisionId", "sessionId"]) ||
    !validSessionId(body.sessionId)
  ) {
    res.status(400).json({ error: INVALID_REQUEST });
    return;
  }
  const revisionId = body.revisionId as string;
  const sessionHash = openClawControlSessionHash(body.sessionId as string);
  try {
    const result = await context.db.runTransaction((tx) => sessionAccessInTransaction({
      db: context.db,
      tx,
      gatewayId: bound.gatewayId,
      revisionId,
      sessionHash,
      now: context.now(),
    }));
    if (result.kind !== "allowed") {
      sendSessionAccessFailure(result, res);
      return;
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

function validProfileRequest(body: Record<string, unknown> | null): body is Record<string, unknown> {
  if (!body || !exactKeys(body, ["gatewayId", "revisionId", "sessionId", "channelId", "postId"]) || !validSessionId(body.sessionId)) return false;
  if (body.channelId === undefined && body.postId === undefined) return true;
  return typeof body.channelId === "string" && /^[a-z0-9]{26}$/u.test(body.channelId) &&
    typeof body.postId === "string" && /^[a-z0-9]{26}$/u.test(body.postId);
}

async function loadControlProfile(
  context: BrokerContext & {
    profile: typeof import("../lib/openclaw-profile-appearance.js").loadOpenClawProfileAppearance;
    chatAuthor: typeof import("../lib/openclaw-chat-author.js").resolveOpenClawChatAuthor;
  },
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  res.setHeader("cache-control", "no-store");
  if (!requestFits(req)) {
    res.status(413).json({ error: "request-too-large" });
    return;
  }
  const bound = boundGateway(req, res);
  if (!bound) return;
  const body = record(req.body);
  if (!validProfileRequest(body)) {
    res.status(400).json({ error: INVALID_REQUEST });
    return;
  }
  const revisionId = body.revisionId as string;
  const sessionHash = openClawControlSessionHash(body.sessionId as string);
  try {
    const result = await context.db.runTransaction((tx) => sessionAccessInTransaction({
      db: context.db,
      tx,
      gatewayId: bound.gatewayId,
      revisionId,
      sessionHash,
      now: context.now(),
    }));
    if (result.kind !== "allowed") {
      sendSessionAccessFailure(result, res);
      return;
    }
    let author: Awaited<ReturnType<typeof context.chatAuthor>> = null;
    if (typeof body.postId === "string") {
      author = await context.chatAuthor(result.session.uid, result.session.workspaceSlug, body.channelId as string, body.postId);
      if (!author) {
        res.status(204).end();
        return;
      }
    }
    const appearance = await context.profile(author?.uid ?? result.session.uid);
    res.json({ ...(author ? { author } : {}), displayName: appearance.displayName, avatar: appearance.avatar ? {
      revision: appearance.avatar.revision,
      avatarBase64: (await appearance.avatar.read()).toString("base64"),
    } : null });
  } catch (err) {
    next(err);
  }
}

interface MattermostBrokerDependencies {
  authorize: typeof import("../../../gateway-edge/src/lib/channel-session-authorization.js").authorizeChannelCredentials;
  listChannels: typeof import("../../../gateway-edge/src/lib/channel-session-authorization.js").listWorkspaceChannelCandidates;
}

const mattermostDefaults: MattermostBrokerDependencies = {
  authorize: async (...args) => (await import("../../../gateway-edge/src/lib/channel-session-authorization.js")).authorizeChannelCredentials(...args),
  listChannels: async (...args) => (await import("../../../gateway-edge/src/lib/channel-session-authorization.js")).listWorkspaceChannelCandidates(...args),
};

function validMattermostRequest(body: Record<string, unknown> | null, operation: "authorize" | "channels"): body is Record<string, unknown> {
  const keys = ["gatewayId", "revisionId", "sessionId"];
  if (operation === "authorize") keys.push("channelId", "requireActiveLedger");
  if (!body || !exactKeys(body, keys) || !validSessionId(body.sessionId)) return false;
  return operation === "channels" || (typeof body.channelId === "string" &&
    /^[a-z0-9]{26}$/u.test(body.channelId) &&
    (body.requireActiveLedger === undefined || typeof body.requireActiveLedger === "boolean"));
}

async function controlMattermostRequest(
  context: BrokerContext & { mattermost: MattermostBrokerDependencies; operation: "authorize" | "channels" },
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const { mattermost, operation } = context;
  res.setHeader("cache-control", "no-store");
  if (!requestFits(req)) {
    res.status(413).json({ error: "request-too-large" });
    return;
  }
  const bound = boundGateway(req, res);
  if (!bound) return;
  const body = record(req.body);
  if (!validMattermostRequest(body, operation)) {
    res.status(400).json({ error: INVALID_REQUEST });
    return;
  }
  try {
    const access = await context.db.runTransaction((tx) => sessionAccessInTransaction({
      db: context.db, tx, gatewayId: bound.gatewayId,
      revisionId: body.revisionId as string,
      sessionHash: openClawControlSessionHash(body.sessionId as string), now: context.now(),
    }));
    if (access.kind !== "allowed") {
      sendSessionAccessFailure(access, res);
      return;
    }
    const signal = AbortSignal.timeout(5_000);
    const { uid, workspaceSlug } = access.session;
    if (operation === "channels") {
      res.json(await mattermost.listChannels(workspaceSlug, signal));
      return;
    }
    const channel = await mattermost.authorize(uid, body.channelId as string, workspaceSlug, {
      requireActiveLedger: body.requireActiveLedger === true, includeCoachConversation: true, signal,
    });
    if (!channel || channel.forbidden) {
      res.status(channel?.forbidden ? 403 : 404).json({ error: "channel-unavailable" });
      return;
    }
    res.json(channel);
  } catch (error) {
    next(error);
  }
}

function cacheProfileAvatars(
  load: typeof import("../lib/openclaw-profile-appearance.js").loadOpenClawProfileAppearance,
): typeof load {
  const avatars = new Map<string, { revision: string; bytes: Buffer }>();
  return async (uid) => {
    const appearance = await load(uid);
    const avatar = appearance.avatar;
    if (!avatar) {
      avatars.delete(uid);
      return appearance;
    }
    return { ...appearance, avatar: { revision: avatar.revision, read: async () => {
      const cached = avatars.get(uid);
      const bytes = cached?.revision === avatar.revision ? cached.bytes : await avatar.read();
      avatars.delete(uid);
      avatars.set(uid, { revision: avatar.revision, bytes });
      if (avatars.size > 128) avatars.delete(avatars.keys().next().value!);
      return bytes;
    } } };
  };
}

export function createOpenClawControlBrokerRoutes(args: {
  db: Firestore;
  now?: () => number;
  mattermost?: MattermostBrokerDependencies;
  profile?: typeof import("../lib/openclaw-profile-appearance.js").loadOpenClawProfileAppearance;
  chatAuthor?: typeof import("../lib/openclaw-chat-author.js").resolveOpenClawChatAuthor;
}): Router {
  const router = Router();
  const context: BrokerContext = {
    db: args.db,
    now: args.now ?? Date.now,
  };
  router.post("/redeem", (req, res, next) => redeemControlTicket(context, req, res, next));
  router.post("/authorize", (req, res, next) => authorizeControlSession(context, req, res, next));
  const profile = cacheProfileAvatars(args.profile ?? (async (uid) =>
    (await import("../lib/openclaw-profile-appearance.js")).loadOpenClawProfileAppearance(uid)));
  const chatAuthor = args.chatAuthor ?? (async (...params) =>
    (await import("../lib/openclaw-chat-author.js")).resolveOpenClawChatAuthor(...params));
  router.post("/profile", (req, res, next) => loadControlProfile({ ...context, profile, chatAuthor }, req, res, next));
  for (const operation of ["authorize", "channels"] as const) {
    router.post(`/mattermost/${operation}`, (req, res, next) =>
      controlMattermostRequest({ ...context, mattermost: args.mattermost ?? mattermostDefaults, operation }, req, res, next));
  }
  return router;
}
