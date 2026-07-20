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
  OPENCLAW_CONTROL_AUDIT_COLLECTION,
  OPENCLAW_CONTROL_TICKETS_COLLECTION,
  inspectOpenClawControlTicket,
  openClawControlTicketHash,
  type OpenClawControlTicketInspection,
  type OpenClawControlTicketRejectionReason,
} from "@octogee/core/openclaw-control-tickets";
import { isOpenClawControlRevisionRuntimeReady } from "@octogee/core/openclaw-control-runtime-ready";
import {
  GATEWAY_ACCESS_GRANTS_COLLECTION,
  gatewayAccessGrantId,
  isCanonicalWorkspaceMembership,
  permissionSetIds,
  resolveGatewayPrincipalAccess,
  type GatewayPermissionSetId,
  type GatewayPrincipalAccess,
  type OpenClawBrokerProfile,
  type ResolvedGatewayAccess,
} from "@octogee/core/gateway-principal-access";
import { isGatewayDesiredDoc, isGatewayRuntimeDoc } from "@octogee/shared/types/gateway-releases";
import { isGatewayClassControlUiAccessEnabled, resolveGatewayClass } from "@octogee/shared/types/glm";
import { revisionIdFromGatewayPodName } from "../lib/gateway-pod-revision.js";
import { setGatewayAccessDenialAudit } from "../../../gateway-edge/src/lib/gateway-access-audit.js";

type GatewayBinding = Extract<Express.Request["boundTenant"], { kind: "gateway" }>;

export const OPENCLAW_CONTROL_SESSIONS_COLLECTION = "openclawControlSessions";
export { OPENCLAW_CONTROL_AUDIT_COLLECTION } from "@octogee/core/openclaw-control-tickets";
export const OPENCLAW_CONTROL_SESSION_TTL_MS = 60 * 60_000;
export const OPENCLAW_CONTROL_AUDIT_MAX_BATCH = 32;
export const OPENCLAW_CONTROL_REQUEST_MAX_BYTES = 16 * 1024;

const CONTROL_EVENTS = new Set([
  "session_open",
  "session_close",
  "rpc_allow",
  "rpc_deny",
  "rpc_result",
]);
const METHOD_CATEGORIES = new Set([
  "read",
  "config_mutation",
  "tools_invoke",
  "forbidden_mutation",
  "unknown",
]);
const OUTCOMES = new Set([
  "ok",
  "denied",
  "error",
  "expired",
  "revoked",
  "rate_limited",
]);
const REASONS = new Set([
  "none",
  "auth_invalid",
  "entitlement_missing",
  "revision_mismatch",
  "ticket_expired",
  "ticket_replay",
  "session_revoked",
  "method_denied",
  "rate_limited",
  "upstream_unavailable",
  "protocol_invalid",
  "ticket_invalid",
  "gateway_mismatch",
  "assignment_missing",
  "gateway_not_ready",
]);
const RPC_EVENTS = new Set(["rpc_allow", "rpc_deny", "rpc_result"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CAPABILITY_DISABLED = "capability-disabled";
const INVALID_REQUEST = "invalid-request";
const PROTOCOL_INVALID = "protocol_invalid";
const ASSIGNMENT_MISSING = "assignment-missing";

interface ControlSession {
  uid: string;
  gatewayId: string;
  revisionId: string;
  brokerProfile: OpenClawBrokerProfile;
  permissionSetIds: GatewayPermissionSetId[];
  grantRevision: number | null;
  expiresAt: number;
}

interface AuditEvent {
  event: string;
  methodCategory?: string;
  outcome: string;
  reason: string;
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
  if (!access.dashboard || !access.brokerProfile) return null;
  const gatewayClass = resolveGatewayClass({
    gatewayClass: config.gatewayClass,
    profile: config.profile ?? undefined,
    imageProfile: config.imageProfile,
  });
  return isGatewayClassControlUiAccessEnabled(gatewayClass, config.operatorAccess ?? undefined)
    ? authorization
    : null;
}

function accessBindingMatches(
  access: ResolvedGatewayAccess,
  binding: Pick<ControlSession, "brokerProfile" | "permissionSetIds" | "grantRevision">,
): boolean {
  return access.brokerProfile === binding.brokerProfile &&
    access.grantRevision === binding.grantRevision &&
    access.permissionSetIds.length === binding.permissionSetIds.length &&
    access.permissionSetIds.every((id, index) => id === binding.permissionSetIds[index]);
}

async function storedPrincipalAccess(args: {
  db: Firestore;
  tx: Transaction;
  root: unknown;
  gatewayId: string;
  uid: string;
  now: number;
}): Promise<GatewayPrincipalAccess | null> {
  const authorization = gatewayAuthorizationFromRootDocument(args.root, args.gatewayId);
  if (!authorization) return null;
  const ownerUid = authorization.config.ownerUid;
  const workspaceSlug = authorization.config.builderSlug;
  if (ownerUid === args.uid) {
    const owner = resolveGatewayPrincipalAccess({
      gateway: { gatewayId: args.gatewayId, ownerUid, workspaceSlug },
      uid: args.uid,
      grant: null,
      isWorkspaceMember: false,
      now: args.now,
    });
    return owner.kind === "denied" ? null : owner;
  }
  if (!workspaceSlug) return null;
  const [grantSnap, memberSnap] = await Promise.all([
    args.tx.get(args.db.doc(
      `${GATEWAY_ACCESS_GRANTS_COLLECTION}/${gatewayAccessGrantId(args.gatewayId, args.uid)}`,
    )),
    args.tx.get(args.db.doc(`workspaces/${workspaceSlug}/members/${args.uid}`)),
  ]);
  const delegated = resolveGatewayPrincipalAccess({
    gateway: { gatewayId: args.gatewayId, ownerUid, workspaceSlug },
    uid: args.uid,
    grant: grantSnap.exists ? grantSnap.data() : null,
    isWorkspaceMember: memberSnap.exists && isCanonicalWorkspaceMembership(memberSnap.data()),
    now: args.now,
  });
  return delegated;
}

function auditPrincipalDenial(args: {
  db: Firestore;
  tx: Transaction;
  root: unknown;
  gatewayId: string;
  uid: string;
  principal: GatewayPrincipalAccess;
  now: number;
}): void {
  const authorization = gatewayAuthorizationFromRootDocument(args.root, args.gatewayId);
  const ownerUid = authorization?.config.ownerUid;
  const workspaceSlug = authorization?.config.builderSlug;
  if (!ownerUid || !workspaceSlug || args.uid === ownerUid) return;
  setGatewayAccessDenialAudit(args.db, args.tx, {
    gatewayId: args.gatewayId,
    workspaceSlug,
    ownerUid,
    actorUid: args.uid,
    granteeUid: args.uid,
    reason: args.principal.kind === "denied" ? args.principal.reason : "binding_changed",
    source: "system",
    now: args.now,
    beforePermissionSetIds: args.principal.kind === "denied"
      ? []
      : args.principal.permissionSetIds,
    beforeRevision: args.principal.kind === "denied" ? null : args.principal.grantRevision,
  });
}

function isReadyLiveServingRevision(
  root: unknown,
  revision: unknown,
  gatewayId: string,
  revisionId: string,
  now: number,
): boolean {
  return isGatewayDesiredDoc(root) &&
    root.gatewayId === gatewayId &&
    root.desiredStatus === "running" &&
    root.desiredRelease === root.liveRelease &&
    revisionId === gatewayId &&
    isGatewayRuntimeDoc(revision) &&
    revision.gatewayId === gatewayId &&
    revision.release === root.liveRelease &&
    revision.lifecycle === "serving" &&
    isOpenClawControlRevisionRuntimeReady(revision, { gatewayId, revisionId, now });
}

export function openClawControlSessionHash(sessionId: string): string {
  return createHash("sha256").update("openclaw-control-session\0").update(sessionId).digest("hex");
}

function controlProfile(value: unknown): OpenClawBrokerProfile | null {
  return value === "native-owner" || value === "native-co-owner" ||
    value === "delegated-config" || value === "delegated-read"
    ? value
    : null;
}

function controlSessionBinding(
  profile: OpenClawBrokerProfile,
  rawPermissionSetIds: unknown,
  grantRevision: unknown,
): { ids: GatewayPermissionSetId[]; revision: number | null } | null {
  const ids = Array.isArray(rawPermissionSetIds) && rawPermissionSetIds.length === 0
    ? []
    : permissionSetIds(rawPermissionSetIds);
  if (profile === "native-owner") {
    return ids?.length === 0 && grantRevision === null ? { ids: [], revision: null } : null;
  }
  return ids && Number.isSafeInteger(grantRevision) && (grantRevision as number) >= 1
    ? { ids, revision: grantRevision as number }
    : null;
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
  const profile = controlProfile(item.brokerProfile);
  const binding = profile
    ? controlSessionBinding(profile, item.permissionSetIds, item.grantRevision)
    : null;
  if (
    !uid ||
    !profile ||
    !binding ||
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
    revisionId,
    brokerProfile: profile,
    permissionSetIds: binding.ids,
    grantRevision: binding.revision,
    expiresAt: item.expiresAt,
  };
}

function parseAuditEvent(value: unknown): AuditEvent | null {
  const event = record(value);
  if (!event || !exactKeys(event, ["event", "methodCategory", "outcome", "reason"])) return null;
  const eventName = typeof event.event === "string" && CONTROL_EVENTS.has(event.event)
    ? event.event
    : null;
  const outcome = typeof event.outcome === "string" && OUTCOMES.has(event.outcome)
    ? event.outcome
    : null;
  const reason = typeof event.reason === "string" && REASONS.has(event.reason)
    ? event.reason
    : null;
  if (!eventName || !outcome || !reason) return null;
  const methodCategory = event.methodCategory;
  const hasMethodCategory = typeof methodCategory === "string" && METHOD_CATEGORIES.has(methodCategory);
  if (RPC_EVENTS.has(eventName) !== hasMethodCategory) return null;
  return {
    event: eventName,
    ...(hasMethodCategory ? { methodCategory: methodCategory as string } : {}),
    outcome,
    reason,
  };
}

function parseAuditEvents(value: unknown): AuditEvent[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > OPENCLAW_CONTROL_AUDIT_MAX_BATCH) {
    return null;
  }
  const events = value.map(parseAuditEvent);
  return events.every((event): event is AuditEvent => event !== null) ? events : null;
}

class FixedWindowLimiter {
  private readonly entries = new Map<string, { startedAt: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly now: () => number,
  ) {}

  consume(key: string, count: number): boolean {
    const current = this.now();
    const existing = this.entries.get(key);
    const entry = !existing || current - existing.startedAt >= 60_000
      ? { startedAt: current, count: 0 }
      : existing;
    if (entry.count + count > this.limit) return false;
    entry.count += count;
    this.entries.set(key, entry);
    return true;
  }
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
  const principal = await storedPrincipalAccess({
    db: args.db,
    tx: args.tx,
    root,
    gatewayId: args.gatewayId,
    uid: session.uid,
    now: args.now,
  });
  if (!principal || principal.kind === "denied" || !accessBindingMatches(principal, session)) {
    if (principal) {
      auditPrincipalDenial({
        db: args.db,
        tx: args.tx,
        root,
        gatewayId: args.gatewayId,
        uid: session.uid,
        principal,
        now: args.now,
      });
    }
    return { kind: CAPABILITY_DISABLED };
  }
  const authorization = controlUiAuthorization(root, args.gatewayId, principal);
  if (!authorization) return { kind: CAPABILITY_DISABLED };
  const ownerUid = authorization.config.ownerUid;
  if (typeof ownerUid !== "string") return { kind: ASSIGNMENT_MISSING };
  const ownerAssignmentSnap = await args.tx.get(args.db.doc(`users/${ownerUid}`));
  if (!userAssignmentMatchesGateway(
    ownerAssignmentSnap.exists ? ownerAssignmentSnap.data() : undefined,
    args.gatewayId,
    authorization.config.builderSlug,
  )) {
    return { kind: ASSIGNMENT_MISSING };
  }
  if (!isReadyLiveServingRevision(
    root,
    revisionSnap.data(),
    args.gatewayId,
    args.revisionId,
    args.now,
  )) {
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
  userAuditLimiter: FixedWindowLimiter;
  gatewayAuditLimiter: FixedWindowLimiter;
}

interface RedeemAuditInput {
  gatewayId: string;
  revisionId: string;
  outcome: "ok" | "denied" | "error" | "expired";
  reason:
    | OpenClawControlTicketRejectionReason
    | "none"
    | typeof PROTOCOL_INVALID
    | "entitlement_missing"
    | "assignment_missing"
    | "gateway_not_ready";
  createdAt: number;
  uid?: string;
  sessionHash?: string;
  ticketHash?: string;
}

type AuthenticatedGateway = NonNullable<ReturnType<typeof authenticatedGateway>>;
type RedeemBaseAudit = Pick<
  RedeemAuditInput,
  "gatewayId" | "revisionId" | "createdAt" | "ticketHash"
>;
type RedeemableTicket = Extract<OpenClawControlTicketInspection, { kind: "redeemable" }>;

interface RedeemAttempt {
  authenticated: AuthenticatedGateway;
  ticketHash: string;
  sessionHash: string;
  attemptAt: number;
  baseAudit: RedeemBaseAudit;
}

type RedeemResult =
  | { kind: "ticket-invalid" }
  | { kind: "session-conflict" }
  | { kind: typeof CAPABILITY_DISABLED }
  | { kind: typeof ASSIGNMENT_MISSING }
  | { kind: "not-ready" }
  | { kind: "redeemed"; redeemed: RedeemableTicket; expiresAt: number };

function redeemAuditDocument(input: RedeemAuditInput): Record<string, unknown> {
  return {
    gatewayId: input.gatewayId,
    revisionId: input.revisionId,
    ...(input.uid ? { uid: input.uid } : {}),
    ...(input.sessionHash ? { sessionHash: input.sessionHash } : {}),
    ...(input.ticketHash ? { ticketHash: input.ticketHash } : {}),
    event: "ticket_redeem",
    outcome: input.outcome,
    reason: input.reason,
    createdAt: input.createdAt,
  };
}

function setRedeemAudit(
  context: BrokerContext,
  tx: Transaction,
  input: RedeemAuditInput,
): void {
  tx.set(
    context.db.collection(OPENCLAW_CONTROL_AUDIT_COLLECTION).doc(),
    redeemAuditDocument(input),
  );
}

async function addRedeemAudit(
  context: BrokerContext,
  input: RedeemAuditInput,
): Promise<void> {
  await context.db.collection(OPENCLAW_CONTROL_AUDIT_COLLECTION).add(
    redeemAuditDocument(input),
  );
}

async function rejectRedeemAttempt(
  context: BrokerContext,
  res: Response,
  baseAudit: RedeemBaseAudit,
  rejection: {
    reason: RedeemAuditInput["reason"];
    status: number;
    error: string;
  },
): Promise<null> {
  await addRedeemAudit(context, {
    ...baseAudit,
    outcome: "denied",
    reason: rejection.reason,
  });
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

async function validateRedeemAttempt(
  context: BrokerContext,
  req: Request,
  res: Response,
): Promise<RedeemAttempt | null> {
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
  const baseAudit: RedeemBaseAudit = {
    gatewayId: authenticated.bound.gatewayId,
    revisionId: authenticated.revisionId,
    createdAt: attemptAt,
    ...(ticketHash ? { ticketHash } : {}),
  };
  if (!requestFits(req)) {
    return rejectRedeemAttempt(
      context,
      res,
      baseAudit,
      { reason: PROTOCOL_INVALID, status: 413, error: "request-too-large" },
    );
  }
  if (!claimedGateway || !claimedRevision) {
    return rejectRedeemAttempt(context, res, baseAudit, {
      reason: PROTOCOL_INVALID,
      status: 403,
      error: "forbidden",
    });
  }
  if (claimedGateway !== authenticated.bound.gatewayId) {
    return rejectRedeemAttempt(context, res, baseAudit, {
      reason: "gateway_mismatch",
      status: 403,
      error: "forbidden",
    });
  }
  if (claimedRevision !== authenticated.revisionId) {
    return rejectRedeemAttempt(context, res, baseAudit, {
      reason: "revision_mismatch",
      status: 403,
      error: "forbidden",
    });
  }
  const payload = parseRedeemPayload(body, ticket, ticketHash);
  if (!payload) {
    return rejectRedeemAttempt(context, res, baseAudit, {
      reason: PROTOCOL_INVALID,
      status: 400,
      error: INVALID_REQUEST,
    });
  }
  return {
    authenticated,
    ticketHash: payload.ticketHash,
    sessionHash: openClawControlSessionHash(payload.sessionId),
    attemptAt,
    baseAudit,
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
  context: BrokerContext;
  attempt: RedeemAttempt;
  documents: RedeemDocuments;
  tx: Transaction;
}): RedeemableTicket | RedeemResult {
  const { context, attempt, documents, tx } = args;
  const inspected = inspectOpenClawControlTicket({
    document: documents.ticket,
    gatewayId: attempt.authenticated.bound.gatewayId,
    revisionId: attempt.authenticated.revisionId,
    now: attempt.attemptAt,
  });
  if (inspected.kind === "rejected") {
    setRedeemAudit(context, tx, {
      ...attempt.baseAudit,
      ...(inspected.uid ? { uid: inspected.uid } : {}),
      outcome: inspected.reason === "ticket_expired" ? "expired" : "denied",
      reason: inspected.reason,
    });
    return { kind: "ticket-invalid" };
  }
  if (!documents.sessionExists) return inspected;
  setRedeemAudit(context, tx, {
    ...attempt.baseAudit,
    uid: inspected.uid,
    sessionHash: attempt.sessionHash,
    outcome: "denied",
    reason: PROTOCOL_INVALID,
  });
  return { kind: "session-conflict" };
}

function rejectRedeemPrincipal(args: {
  context: BrokerContext;
  attempt: RedeemAttempt;
  inspected: RedeemableTicket;
  principal: GatewayPrincipalAccess | null;
  root: unknown;
  tx: Transaction;
}): RedeemResult {
  if (args.principal) {
    auditPrincipalDenial({
      db: args.context.db,
      tx: args.tx,
      root: args.root,
      gatewayId: args.attempt.authenticated.bound.gatewayId,
      uid: args.inspected.uid,
      principal: args.principal,
      now: args.attempt.attemptAt,
    });
  }
  setRedeemAudit(args.context, args.tx, {
    ...args.attempt.baseAudit,
    uid: args.inspected.uid,
    outcome: "denied",
    reason: "entitlement_missing",
  });
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
  const principal = await storedPrincipalAccess({
    db: args.context.db,
    tx: args.tx,
    root: args.root,
    gatewayId,
    uid: args.inspected.uid,
    now: args.attempt.attemptAt,
  });
  const authorization = principal && principal.kind !== "denied"
    ? controlUiAuthorization(args.root, gatewayId, principal)
    : null;
  if (!authorization || !principal || principal.kind === "denied" ||
    !accessBindingMatches(principal, args.inspected)) {
    return rejectRedeemPrincipal({ ...args, principal });
  }
  const ownerUid = authorization.config.ownerUid;
  const owner = typeof ownerUid === "string"
    ? await args.tx.get(args.context.db.doc(`users/${ownerUid}`))
    : null;
  if (owner?.exists && userAssignmentMatchesGateway(
    owner.data(),
    gatewayId,
    authorization.config.builderSlug,
  )) return null;
  setRedeemAudit(args.context, args.tx, {
    ...args.attempt.baseAudit,
    uid: args.inspected.uid,
    outcome: "denied",
    reason: "assignment_missing",
  });
  return { kind: ASSIGNMENT_MISSING };
}

function persistRedeemedSession(args: {
  context: BrokerContext;
  attempt: RedeemAttempt;
  documents: RedeemDocuments;
  inspected: RedeemableTicket;
  tx: Transaction;
}): RedeemResult {
  const { attempt, context, documents, inspected, tx } = args;
  const expiresAt = attempt.attemptAt + OPENCLAW_CONTROL_SESSION_TTL_MS;
  tx.update(documents.ticketRef, { redeemedAt: attempt.attemptAt });
  tx.set(documents.sessionRef, {
    uid: inspected.uid,
    gatewayId: attempt.authenticated.bound.gatewayId,
    revisionId: attempt.authenticated.revisionId,
    brokerProfile: inspected.brokerProfile,
    permissionSetIds: inspected.permissionSetIds,
    grantRevision: inspected.grantRevision,
    createdAt: attempt.attemptAt,
    expiresAt,
    expireAt: Timestamp.fromMillis(expiresAt),
  });
  setRedeemAudit(context, tx, {
    ...attempt.baseAudit,
    uid: inspected.uid,
    sessionHash: attempt.sessionHash,
    outcome: "ok",
    reason: "none",
  });
  return { kind: "redeemed", redeemed: inspected, expiresAt };
}

async function applyRedeemAttempt(
  context: BrokerContext,
  attempt: RedeemAttempt,
  tx: Transaction,
): Promise<RedeemResult> {
  const documents = await loadRedeemDocuments(context, attempt, tx);
  const inspected = inspectRedeemDocuments({ context, attempt, documents, tx });
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
  )) {
    setRedeemAudit(context, tx, {
      ...attempt.baseAudit,
      uid: inspected.uid,
      outcome: "error",
      reason: "gateway_not_ready",
    });
    return { kind: "not-ready" };
  }
  return persistRedeemedSession({ context, attempt, documents, inspected, tx });
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
    const attempt = await validateRedeemAttempt(context, req, res);
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
  const sessionHash = openClawControlSessionHash(body.sessionId);
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

async function auditControlEvents(
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
    !exactKeys(body, ["gatewayId", "revisionId", "sessionId", "events"]) ||
    !validSessionId(body.sessionId)
  ) {
    res.status(400).json({ error: INVALID_REQUEST });
    return;
  }
  const events = parseAuditEvents(body.events);
  if (!events) {
    res.status(400).json({ error: INVALID_REQUEST });
    return;
  }
  const revisionId = body.revisionId as string;
  const sessionHash = openClawControlSessionHash(body.sessionId);
  if (!context.gatewayAuditLimiter.consume(bound.gatewayId, events.length)) {
    res.status(429).json({ error: "audit-rate-limited", retryable: true });
    return;
  }
  try {
    const readResult = await context.db.runTransaction((tx) => sessionAccessInTransaction({
      db: context.db,
      tx,
      gatewayId: bound.gatewayId,
      revisionId,
      sessionHash,
      now: context.now(),
    }));
    if (readResult.kind !== "allowed") {
      sendSessionAccessFailure(readResult, res);
      return;
    }
    if (!context.userAuditLimiter.consume(
      `${bound.gatewayId}:${readResult.session.uid}`,
      events.length,
    )) {
      res.status(429).json({ error: "audit-rate-limited", retryable: true });
      return;
    }
    const writeResult = await context.db.runTransaction(async (tx) => {
      const access = await sessionAccessInTransaction({
        db: context.db,
        tx,
        gatewayId: bound.gatewayId,
        revisionId,
        sessionHash,
        now: context.now(),
      });
      if (access.kind !== "allowed") return access;
      for (const event of events) {
        tx.set(context.db.collection(OPENCLAW_CONTROL_AUDIT_COLLECTION).doc(), {
          gatewayId: bound.gatewayId,
          revisionId,
          uid: access.session.uid,
          sessionHash,
          ...event,
          createdAt: context.now(),
        });
      }
      return access;
    });
    if (writeResult.kind !== "allowed") {
      sendSessionAccessFailure(writeResult, res);
      return;
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

export function createOpenClawControlBrokerRoutes(args: {
  db: Firestore;
  now?: () => number;
  auditEventsPerMinute?: number;
}): Router {
  const router = Router();
  const now = args.now ?? Date.now;
  const auditLimit = args.auditEventsPerMinute ?? 240;
  const context: BrokerContext = {
    db: args.db,
    now,
    userAuditLimiter: new FixedWindowLimiter(auditLimit, now),
    gatewayAuditLimiter: new FixedWindowLimiter(auditLimit * 4, now),
  };
  router.post("/redeem", (req, res, next) => redeemControlTicket(context, req, res, next));
  router.post("/authorize", (req, res, next) => authorizeControlSession(context, req, res, next));
  router.post("/audit", (req, res, next) => auditControlEvents(context, req, res, next));
  return router;
}
