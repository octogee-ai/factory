import { createHash } from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import { Timestamp, type Firestore, type Transaction } from "firebase-admin/firestore";

import { userAssignmentMatchesGateway } from "@octogee/core/assigned-roster";
import { gatewayAuthorizationFromRootDocument } from "@octogee/core/gateway-live-release";
import {
  OPENCLAW_CONTROL_AUDIT_COLLECTION,
  OPENCLAW_CONTROL_TICKETS_COLLECTION,
  inspectOpenClawControlTicket,
  openClawControlTicketHash,
  type OpenClawControlTicketRejectionReason,
} from "@octogee/core/openclaw-control-tickets";
import { isOpenClawControlRevisionRuntimeReady } from "@octogee/core/openclaw-control-runtime-ready";
import { isGatewayDesiredDoc, isRevisionRealizationDoc } from "@octogee/shared/types/gateway-releases";
import { isGatewayClassControlUiAccessEnabled, resolveGatewayClass } from "@octogee/shared/types/glm";
import { revisionIdFromGatewayPodName } from "../lib/gateway-pod-revision.js";

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

interface ControlSession {
  uid: string;
  gatewayId: string;
  revisionId: string;
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
  | { kind: "assignment-missing" }
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

function controlUiAuthorization(root: unknown, gatewayId: string, uid: string) {
  const authorization = gatewayAuthorizationFromRootDocument(root, gatewayId);
  if (!authorization) return null;
  const config = authorization.config;
  if (config.ownerUid !== uid && !config.coOwnerUids.includes(uid)) return null;
  const gatewayClass = resolveGatewayClass({
    gatewayClass: config.gatewayClass,
    profile: config.profile ?? undefined,
    imageProfile: config.imageProfile,
  });
  return isGatewayClassControlUiAccessEnabled(gatewayClass, config.operatorAccess ?? undefined)
    ? authorization
    : null;
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
    root.roll === null &&
    root.desiredRelease === root.liveRelease &&
    root.liveRevisionId === revisionId &&
    root.trafficRevisionId === revisionId &&
    isRevisionRealizationDoc(revision) &&
    revision.revisionId === revisionId &&
    revision.gateway === gatewayId &&
    revision.release === root.liveRelease &&
    revision.lifecycle === "serving" &&
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
  if (
    !uid ||
    item.gatewayId !== gatewayId ||
    item.revisionId !== revisionId ||
    typeof item.expiresAt !== "number" ||
    !Number.isFinite(item.expiresAt) ||
    item.expiresAt <= now
  ) {
    return null;
  }
  return { uid, gatewayId, revisionId, expiresAt: item.expiresAt };
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
  const authorization = controlUiAuthorization(root, args.gatewayId, session.uid);
  if (!authorization) return { kind: CAPABILITY_DISABLED };
  const ownerUid = authorization.config.ownerUid;
  if (typeof ownerUid !== "string") return { kind: "assignment-missing" };
  const ownerAssignmentSnap = await args.tx.get(args.db.doc(`users/${ownerUid}`));
  if (!userAssignmentMatchesGateway(
    ownerAssignmentSnap.exists ? ownerAssignmentSnap.data() : undefined,
    args.gatewayId,
    authorization.config.builderSlug,
  )) {
    return { kind: "assignment-missing" };
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
  } else if (result.kind === "assignment-missing") {
    res.status(403).json({ error: "assignment-missing" });
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
    | "protocol_invalid"
    | "entitlement_missing"
    | "assignment_missing"
    | "gateway_not_ready";
  createdAt: number;
  uid?: string;
  sessionHash?: string;
  ticketHash?: string;
}

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

async function redeemControlTicket(
  context: BrokerContext,
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const authenticated = authenticatedGateway(req);
    if (!authenticated) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    const body = record(req.body);
    const claimedGateway = boundedString(body?.gatewayId, 32);
    const claimedRevision = boundedString(body?.revisionId, 64);
    const ticket = boundedString(body?.ticket, 256);
    const ticketHash = ticket ? openClawControlTicketHash(ticket) : undefined;
    const attemptAt = context.now();
    const baseAudit = {
      gatewayId: authenticated.bound.gatewayId,
      revisionId: authenticated.revisionId,
      createdAt: attemptAt,
      ...(ticketHash ? { ticketHash } : {}),
    };
    if (!requestFits(req)) {
      await addRedeemAudit(context, {
        ...baseAudit,
        outcome: "denied",
        reason: "protocol_invalid",
      });
      res.status(413).json({ error: "request-too-large" });
      return;
    }
    if (!claimedGateway || !claimedRevision) {
      await addRedeemAudit(context, {
        ...baseAudit,
        outcome: "denied",
        reason: "protocol_invalid",
      });
      res.status(403).json({ error: "forbidden" });
      return;
    }
    if (claimedGateway !== authenticated.bound.gatewayId) {
      await addRedeemAudit(context, {
        ...baseAudit,
        outcome: "denied",
        reason: "gateway_mismatch",
      });
      res.status(403).json({ error: "forbidden" });
      return;
    }
    if (claimedRevision !== authenticated.revisionId) {
      await addRedeemAudit(context, {
        ...baseAudit,
        outcome: "denied",
        reason: "revision_mismatch",
      });
      res.status(403).json({ error: "forbidden" });
      return;
    }
    if (
      !body ||
      !exactKeys(body, ["gatewayId", "revisionId", "sessionId", "ticket"]) ||
      !validSessionId(body.sessionId) ||
      !ticket
    ) {
      await addRedeemAudit(context, {
        ...baseAudit,
        outcome: "denied",
        reason: "protocol_invalid",
      });
      res.status(400).json({ error: INVALID_REQUEST });
      return;
    }
    const revisionId = authenticated.revisionId;
    const sessionHash = openClawControlSessionHash(body.sessionId);
    const result = await context.db.runTransaction(async (tx) => {
      const rootRef = context.db.doc(`gateways/${authenticated.bound.gatewayId}`);
      const revisionRef = context.db.doc(`glmGateways/${revisionId}`);
      const ticketRef = context.db.doc(
        `${OPENCLAW_CONTROL_TICKETS_COLLECTION}/${ticketHash}`,
      );
      const sessionRef = context.db.doc(`${OPENCLAW_CONTROL_SESSIONS_COLLECTION}/${sessionHash}`);
      const [rootSnap, revisionSnap, ticketSnap, sessionSnap] = await Promise.all([
        tx.get(rootRef),
        tx.get(revisionRef),
        tx.get(ticketRef),
        tx.get(sessionRef),
      ]);
      const inspected = inspectOpenClawControlTicket({
        document: ticketSnap.exists ? ticketSnap.data() : undefined,
        gatewayId: authenticated.bound.gatewayId,
        revisionId,
        now: attemptAt,
      });
      if (inspected.kind === "rejected") {
        setRedeemAudit(context, tx, {
          ...baseAudit,
          ...(inspected.uid ? { uid: inspected.uid } : {}),
          outcome: inspected.reason === "ticket_expired" ? "expired" : "denied",
          reason: inspected.reason,
        });
        return { kind: "ticket-invalid" as const };
      }
      if (sessionSnap.exists) {
        setRedeemAudit(context, tx, {
          ...baseAudit,
          uid: inspected.uid,
          sessionHash,
          outcome: "denied",
          reason: "protocol_invalid",
        });
        return { kind: "session-conflict" as const };
      }
      const root = rootSnap.data();
      const authorization = controlUiAuthorization(
        root,
        authenticated.bound.gatewayId,
        inspected.uid,
      );
      if (!authorization) {
        setRedeemAudit(context, tx, {
          ...baseAudit,
          uid: inspected.uid,
          outcome: "denied",
          reason: "entitlement_missing",
        });
        return { kind: CAPABILITY_DISABLED };
      }
      const ownerUid = authorization.config.ownerUid;
      const ownerAssignmentSnap = typeof ownerUid === "string"
        ? await tx.get(context.db.doc(`users/${ownerUid}`))
        : null;
      if (
        !ownerAssignmentSnap?.exists ||
        !userAssignmentMatchesGateway(
          ownerAssignmentSnap.data(),
          authenticated.bound.gatewayId,
          authorization.config.builderSlug,
        )
      ) {
        setRedeemAudit(context, tx, {
          ...baseAudit,
          uid: inspected.uid,
          outcome: "denied",
          reason: "assignment_missing",
        });
        return { kind: "assignment-missing" as const };
      }
      if (!isReadyLiveServingRevision(
        root,
        revisionSnap.data(),
        authenticated.bound.gatewayId,
        revisionId,
        attemptAt,
      )) {
        setRedeemAudit(context, tx, {
          ...baseAudit,
          uid: inspected.uid,
          outcome: "error",
          reason: "gateway_not_ready",
        });
        return { kind: "not-ready" as const };
      }
      const expiresAt = attemptAt + OPENCLAW_CONTROL_SESSION_TTL_MS;
      tx.update(ticketRef, { redeemedAt: attemptAt });
      tx.set(sessionRef, {
        uid: inspected.uid,
        gatewayId: authenticated.bound.gatewayId,
        revisionId,
        createdAt: attemptAt,
        expiresAt,
        expireAt: Timestamp.fromMillis(expiresAt),
      });
      setRedeemAudit(context, tx, {
        ...baseAudit,
        uid: inspected.uid,
        sessionHash,
        outcome: "ok",
        reason: "none",
      });
      return { kind: "redeemed" as const, redeemed: inspected, expiresAt };
    });
    if (result.kind === "not-ready") {
      res.status(409).json({ error: "gateway-not-ready", retryable: true });
      return;
    }
    if (
      result.kind === "ticket-invalid" ||
      result.kind === "session-conflict" ||
      result.kind === CAPABILITY_DISABLED ||
      result.kind === "assignment-missing"
    ) {
      res.status(404).json({ error: "ticket-invalid" });
      return;
    }
    res.json({ ...result.redeemed, expiresAt: result.expiresAt });
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
