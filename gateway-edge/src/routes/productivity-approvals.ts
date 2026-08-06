import { createHash, timingSafeEqual } from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import { FieldValue, type Firestore } from "firebase-admin/firestore";

import { timestampMillis } from "@octogee/core/gateway-principal-access";
import { accountAllowsInteractiveAccess } from "@octogee/shared/types/account-lifecycle";

import { db as defaultDb } from "../lib/db.js";
import {
  executeApprovedCalendarViaBroker,
  type ApprovedCalendarExecution,
  type CalendarApprovalKind,
} from "../lib/calendar-approval-executor.js";
import { requireAuth } from "../middleware/auth.js";

const PRODUCTIVITY_APPROVALS_COLLECTION = "productivityApprovals";
const NOT_FOUND = { error: "not_found" } as const;
const APPROVAL_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface Deps {
  db: Firestore;
  now: () => number;
  executeApprovedCalendar: (input: ApprovedCalendarExecution) => Promise<void>;
}

type ApprovalState = "pending" | "approved" | "denied" | "executing" | "succeeded" | "failed" | "unknown";

const APPROVAL_STATES = new Set<ApprovalState>([
  "pending", "approved", "denied", "executing", "succeeded", "failed", "unknown",
]);

function isApprovalState(value: unknown): value is ApprovalState {
  return typeof value === "string" && APPROVAL_STATES.has(value as ApprovalState);
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonceHash(value: unknown): string | null {
  if (typeof value !== "string" || value.length < 16 || value.length > 256) return null;
  return createHash("sha256").update(value).digest("hex");
}

function hashesEqual(left: unknown, right: string | null): boolean {
  if (typeof left !== "string" || !right || left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

interface ProductivityApprovalView {
  approvalId: string;
  state: ApprovalState | "expired";
  action: { kind: string };
  preview: Record<string, unknown>;
  reason: string | null;
  approvalExpiresAt: string;
}

function projectApproval(id: string, data: Record<string, unknown>, now: number): ProductivityApprovalView {
  const approvalExpiresAt = timestampMillis(data.approvalExpiresAt);
  const action = record(data.action);
  if (
    !isApprovalState(data.state)
    || typeof approvalExpiresAt !== "number"
    || !action
    || typeof action.kind !== "string"
  ) {
    throw new Error("canonical productivity approval is malformed");
  }
  const state = data.state === "pending" && approvalExpiresAt <= now ? "expired" : data.state;
  return {
    approvalId: id,
    state,
    action: { kind: action.kind },
    preview: record(data.preview) ?? {},
    reason: typeof data.reason === "string" ? data.reason : null,
    approvalExpiresAt: new Date(approvalExpiresAt).toISOString(),
  };
}

async function loadOwnedApproval(
  deps: Deps,
  approvalId: string,
  uid: string,
  providedNonceHash: string | null,
): Promise<Record<string, unknown> | null> {
  if (!APPROVAL_ID_PATTERN.test(approvalId)) return null;
  const snap = await deps.db.doc(`${PRODUCTIVITY_APPROVALS_COLLECTION}/${approvalId}`).get();
  const data = snap.data();
  if (!snap.exists || !data || data.ownerUid !== uid || !hashesEqual(data.nonceHash, providedNonceHash)) {
    return null;
  }
  return data;
}

async function preview(deps: Deps, req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const approvalId = typeof req.params.approvalId === "string" ? req.params.approvalId : "";
    const data = await loadOwnedApproval(deps, approvalId, req.uid!, nonceHash(req.query.nonce));
    if (!data) {
      res.status(404).json(NOT_FOUND);
      return;
    }
    res.json(projectApproval(approvalId, data, deps.now()));
  } catch (error) {
    next(error);
  }
}

type ResolveOutcome =
  | { kind: "not-found" }
  | { kind: "expired" }
  | { kind: "forbidden" }
  | { kind: "resolved"; data: Record<string, unknown> };

function resolvedDecision(
  data: Record<string, unknown>,
  targetState: "approved" | "denied",
): ResolveOutcome | null {
  if (data.state === "pending" || data.state === "approved") return null;
  const sameDecision = data.state === targetState;
  const completedApproval = targetState === "approved"
    && ["executing", "succeeded", "failed", "unknown"].includes(String(data.state));
  return sameDecision || completedApproval
    ? { kind: "resolved", data }
    : { kind: "expired" };
}

async function resolveApproval(
  deps: Deps,
  approvalId: string,
  uid: string,
  providedNonceHash: string,
  targetState: "approved" | "denied",
): Promise<ResolveOutcome> {
  if (!APPROVAL_ID_PATTERN.test(approvalId)) return { kind: "not-found" };
  const ref = deps.db.doc(`${PRODUCTIVITY_APPROVALS_COLLECTION}/${approvalId}`);
  const ownerRef = deps.db.doc(`users/${uid}`);
  return deps.db.runTransaction(async (tx): Promise<ResolveOutcome> => {
    const [snap, ownerSnap] = await Promise.all([tx.get(ref), tx.get(ownerRef)]);
    const data = snap.data();
    if (!snap.exists || !data || data.ownerUid !== uid || !hashesEqual(data.nonceHash, providedNonceHash)) {
      return { kind: "not-found" };
    }
    const priorDecision = resolvedDecision(data, targetState);
    if (priorDecision) return priorDecision;
    if (data.state === "approved" && targetState !== "approved") return { kind: "expired" };
    const approvalExpiresAt = timestampMillis(data.approvalExpiresAt);
    if (typeof approvalExpiresAt !== "number" || approvalExpiresAt <= deps.now()) return { kind: "expired" };
    if (!accountAllowsInteractiveAccess(ownerSnap.data())) return { kind: "forbidden" };

    if (data.state === "approved") return { kind: "resolved", data };

    tx.update(ref, { state: targetState, updatedAt: FieldValue.serverTimestamp() });
    return { kind: "resolved", data: { ...data, state: targetState } };
  });
}

function calendarExecution(approvalId: string, data: Record<string, unknown>): ApprovedCalendarExecution | null {
  const action = record(data.action);
  const request = record(data.request);
  const kind = action?.kind;
  if (
    !request
    || typeof data.agentId !== "string"
    || (kind !== "calendar-create" && kind !== "calendar-update" && kind !== "calendar-delete")
  ) return null;
  return {
    approvalId,
    agentId: data.agentId,
    kind: kind as CalendarApprovalKind,
    request,
  };
}

async function respondToApproval(
  deps: Deps,
  targetState: "approved" | "denied",
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const providedHash = nonceHash(record(req.body)?.nonce);
    if (!providedHash) {
      res.status(400).json({ error: "invalid-request" });
      return;
    }
    const approvalId = String(req.params.approvalId);
    const result = await resolveApproval(deps, approvalId, req.uid!, providedHash, targetState);
    if (result.kind === "not-found") {
      res.status(404).json(NOT_FOUND);
      return;
    }
    if (result.kind === "expired") {
      res.status(409).json({ error: "approval_expired" });
      return;
    }
    if (result.kind === "forbidden") {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    let data = result.data;
    const execution = targetState === "approved" && data.state === "approved"
      ? calendarExecution(approvalId, data)
      : null;
    if (execution) {
      try {
        await deps.executeApprovedCalendar(execution);
      } catch (error) {
        console.error("[productivity-approvals] Calendar execution failed", {
          approvalId,
          errorType: error instanceof Error ? error.name : "unknown",
        });
        const current = await loadOwnedApproval(deps, approvalId, req.uid!, providedHash);
        if (!current || current.state === "approved") {
          res.status(502).json({ error: "execution_unavailable" });
          return;
        }
        data = current;
      }
      const current = await loadOwnedApproval(deps, approvalId, req.uid!, providedHash);
      if (current) data = current;
    }
    res.json(projectApproval(approvalId, data, deps.now()));
  } catch (error) {
    next(error);
  }
}

export function createProductivityApprovalRoutes(options: Partial<Deps> = {}): Router {
  const deps: Deps = {
    db: options.db ?? defaultDb,
    now: options.now ?? Date.now,
    executeApprovedCalendar: options.executeApprovedCalendar ?? executeApprovedCalendarViaBroker,
  };
  const router = Router();
  router.get("/:approvalId", (req, res, next) => preview(deps, req, res, next));
  router.post("/:approvalId/approve", (req, res, next) => {
    void respondToApproval(deps, "approved", req, res, next);
  });
  router.post("/:approvalId/deny", (req, res, next) => {
    void respondToApproval(deps, "denied", req, res, next);
  });
  return router;
}

const router = Router();
router.use(requireAuth);
router.use(createProductivityApprovalRoutes());

export default router;
