import { FieldValue, Timestamp, type Firestore } from "firebase-admin/firestore";
import { timestampMillis } from "@octogee/core/timestamps";
import type { PlatformStateStore } from "@octogee/core/platform-state";
import { accountActiveInStore } from "./user-platform-state.js";
import { logger } from "../middleware/logging.js";
import { applyGoogleGrantApproval } from "./google-grant-approval.js";
import type { NativeApprovalSnapshot } from "./native-connector-approval.js";

export type ApprovalDecisionState = "approved" | "denied";

export type ApprovalDecision =
  | {
      state: ApprovalDecisionState;
      reviewerUid: string;
      reviewerAuthTime: number | null;
      decidedAt: Timestamp;
      digest: string;
      surface: "app";
      proof: "bearer";
    }
  | {
      state: "denied";
      reviewerUid: null;
      reviewerAuthTime: null;
      decidedAt: Timestamp;
      digest: string;
      surface: "native";
      proof: "native-deny";
    };

export interface RecordApprovalDecisionInput {
  state: ApprovalDecisionState;
  reviewerUid: string;
  reviewerAuthTime: number | null;
  nowMs: number;
}

export interface RecordedApprovalDecision {
  data: Record<string, unknown>;
  recorded: boolean;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isAppDecision(decision: Record<string, unknown>): boolean {
  return (decision.state === "approved" || decision.state === "denied")
    && decision.surface === "app"
    && decision.proof === "bearer"
    && typeof decision.reviewerUid === "string"
    && decision.reviewerUid.length > 0;
}

function isNativeDenial(decision: Record<string, unknown>): boolean {
  return decision.state === "denied"
    && decision.surface === "native"
    && decision.proof === "native-deny"
    && decision.reviewerUid === null;
}

export function approvalDecision(data: Record<string, unknown>): ApprovalDecision | null {
  if (data.decision === undefined) return null;
  const decision = record(data.decision);
  if (
    !decision
    || !(isAppDecision(decision) || isNativeDenial(decision))
    || typeof decision.digest !== "string"
    || decision.digest !== data.digest
  ) {
    throw new Error("productivity approval decision is malformed");
  }
  return decision as unknown as ApprovalDecision;
}

function awaitingDecision(stored: Record<string, unknown>, nowMs: number): boolean {
  if (stored.state !== "prepared" || stored.decision !== undefined) return false;
  const approvalExpiresAt = timestampMillis(stored.approvalExpiresAt);
  return typeof approvalExpiresAt === "number" && approvalExpiresAt > nowMs;
}

function storedDigest(stored: Record<string, unknown>): string {
  if (typeof stored.digest !== "string" || stored.digest.length === 0) throw new Error("productivity approval digest is missing");
  return stored.digest;
}

export async function recordApprovalDecision(
  db: Firestore,
  store: Pick<PlatformStateStore, "builders" | "workspaces">,
  approvalId: string,
  input: RecordApprovalDecisionInput,
): Promise<RecordedApprovalDecision> {
  const ref = db.doc(`productivityApprovals/${approvalId}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const stored = snap.data();
    if (!snap.exists || !stored) throw new Error("productivity approval is missing");
    if (!awaitingDecision(stored, input.nowMs)) return { data: stored, recorded: false };

    const decision: ApprovalDecision = {
      state: input.state,
      reviewerUid: input.reviewerUid,
      reviewerAuthTime: input.reviewerAuthTime,
      decidedAt: Timestamp.fromMillis(input.nowMs),
      digest: storedDigest(stored),
      surface: "app",
      proof: "bearer",
    };
    const update: Record<string, unknown> = { decision, updatedAt: FieldValue.serverTimestamp() };
    if ((stored.action as { kind?: string } | undefined)?.kind === "google-access" && input.state === "approved") {
      const granted = await accountActiveInStore(String(stored.ownerUid), store)
        && await applyGoogleGrantApproval(db, store, tx, String(stored.ownerUid), stored.preview, approvalId);
      update.state = granted ? "succeeded" : "failed";
      if (!granted) update.failReason = "grant_authority_changed";
    }
    tx.update(ref, update);
    return { data: { ...stored, ...update }, recorded: true };
  });
}

async function recordNativeDenial(
  db: Firestore,
  approvalId: string,
  native: NativeApprovalSnapshot,
  nowMs: number,
): Promise<Record<string, unknown>> {
  const ref = db.doc(`productivityApprovals/${approvalId}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const stored = snap.data();
    if (!snap.exists || !stored) throw new Error("productivity approval is missing");
    if (stored.nativeApprovalId !== native.id || !awaitingDecision(stored, nowMs)) return stored;
    const decision: ApprovalDecision = {
      state: "denied",
      reviewerUid: null,
      reviewerAuthTime: null,
      decidedAt: Timestamp.fromMillis(nowMs),
      digest: storedDigest(stored),
      surface: "native",
      proof: "native-deny",
    };
    tx.update(ref, { decision, updatedAt: FieldValue.serverTimestamp() });
    return { ...stored, decision };
  });
}

export async function honorNativeDenial(
  db: Firestore,
  approvalId: string,
  data: Record<string, unknown>,
  readNative: () => Promise<NativeApprovalSnapshot>,
  now: () => number,
): Promise<Record<string, unknown>> {
  if (typeof data.nativeApprovalId !== "string" || !awaitingDecision(data, now())) return data;
  let native: NativeApprovalSnapshot;
  try {
    native = await readNative();
  } catch (error) {
    logger.warn("productivity approval native read failed", { approvalId, error: error instanceof Error ? error.message : String(error) });
    return data;
  }
  if (native.status !== "denied") return data;
  return recordNativeDenial(db, approvalId, native, now());
}
