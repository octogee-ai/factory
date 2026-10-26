import { FieldValue, Timestamp, type Firestore } from "firebase-admin/firestore";
import { timestampMillis } from "@octogee/core/timestamps";
import { accountAllowsInteractiveAccess } from "@octogee/shared/types/account-lifecycle";
import { applyGoogleGrantApproval } from "./google-grant-approval.js";

export type ApprovalDecisionState = "approved" | "denied";

export interface ApprovalDecision {
  state: ApprovalDecisionState;
  reviewerUid: string;
  reviewerAuthTime: number | null;
  decidedAt: Timestamp;
  digest: string;
  surface: "app";
  proof: "bearer";
}

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

export function approvalDecision(data: Record<string, unknown>): ApprovalDecision | null {
  if (data.decision === undefined) return null;
  const decision = record(data.decision);
  if (
    !decision
    || (decision.state !== "approved" && decision.state !== "denied")
    || typeof decision.reviewerUid !== "string"
    || decision.reviewerUid.length === 0
    || typeof decision.digest !== "string"
    || decision.digest !== data.digest
  ) {
    throw new Error("productivity approval decision is malformed");
  }
  return decision as unknown as ApprovalDecision;
}

export async function recordApprovalDecision(
  db: Firestore,
  approvalId: string,
  input: RecordApprovalDecisionInput,
): Promise<RecordedApprovalDecision> {
  const ref = db.doc(`productivityApprovals/${approvalId}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const stored = snap.data();
    if (!snap.exists || !stored) throw new Error("productivity approval is missing");
    if (stored.state !== "prepared" || approvalDecision(stored)) return { data: stored, recorded: false };
    const approvalExpiresAt = timestampMillis(stored.approvalExpiresAt);
    if (typeof approvalExpiresAt !== "number" || approvalExpiresAt <= input.nowMs) return { data: stored, recorded: false };
    if (typeof stored.digest !== "string" || stored.digest.length === 0) throw new Error("productivity approval digest is missing");

    const decision: ApprovalDecision = {
      state: input.state,
      reviewerUid: input.reviewerUid,
      reviewerAuthTime: input.reviewerAuthTime,
      decidedAt: Timestamp.fromMillis(input.nowMs),
      digest: stored.digest,
      surface: "app",
      proof: "bearer",
    };
    const update: Record<string, unknown> = { decision, updatedAt: FieldValue.serverTimestamp() };
    if ((stored.action as { kind?: string } | undefined)?.kind === "google-access" && input.state === "approved") {
      const owner = await tx.get(db.doc(`users/${stored.ownerUid}`));
      const granted = accountAllowsInteractiveAccess(owner.data())
        && await applyGoogleGrantApproval(db, tx, String(stored.ownerUid), stored.preview, approvalId);
      update.state = granted ? "succeeded" : "failed";
      if (!granted) update.failReason = "grant_authority_changed";
    }
    tx.update(ref, update);
    return { data: { ...stored, ...update }, recorded: true };
  });
}
