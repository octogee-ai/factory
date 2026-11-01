import { createHmac, timingSafeEqual } from "node:crypto";
import type { Firestore } from "firebase-admin/firestore";

import { isSafeAgentId } from "@octogee/core/byosub-restore";
import { accountAllowsInteractiveAccess } from "@octogee/shared/types/account-lifecycle";
import { parseAgentId } from "@octogee/shared/types/identity";

import { verifyOwnerAutomationTurn } from "./openclaw-owner-turn.js";

export const OWNER_AUTOMATIONS_PROOF_PATH = "/internal/owner-automations";

const MAX_AGE_MS = 30_000;

export interface OwnerAutomationProof {
  timestamp: string;
  signature: string;
  body: string;
}

export interface OwnerAutomationAuthorization {
  slug: string;
  agentId: string;
  ownerMattermostUserId: string;
  coachChannelId: string;
  readOnly: boolean;
}

export type AssignedUserLookup = (
  db: Firestore,
  gatewayId: string,
  agentId: string,
) => Promise<{ uid: string; data: Record<string, unknown> } | null>;

export function ownerAutomationProofSignature(
  secret: string,
  timestamp: string,
  path: string,
  body: string,
): string {
  return createHmac("sha256", secret)
    .update(`octogee-owner-automation-v1\n${timestamp}\n${path}\n${body}`)
    .digest("hex");
}

function signaturesMatch(actual: string, expected: string): boolean {
  if (!/^[a-f0-9]{64}$/u.test(actual)) return false;
  return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

function freshTimestamp(timestamp: string, now: () => number): boolean {
  if (!/^\d{10,16}$/u.test(timestamp)) return false;
  const proofTime = Number(timestamp);
  return Number.isSafeInteger(proofTime) && Math.abs(now() - proofTime) <= MAX_AGE_MS;
}

function signedRequest(body: string): { agentId: string; requestContext: unknown; readOnly: boolean } | null {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  const agentId = data.agentId;
  if (typeof agentId !== "string" || !isSafeAgentId(agentId) || parseAgentId(agentId).kind !== "coach") {
    return null;
  }
  return { agentId, requestContext: data.requestContext, readOnly: data.action === "list" };
}

async function coachProofSecret(db: Firestore, uid: string): Promise<string | null> {
  const secret = await db.doc(`users/${uid}/secrets/coachMattermost`).get();
  const personalToken = secret.exists ? secret.data()?.personalToken : undefined;
  return typeof personalToken === "string" && personalToken.length > 0 ? personalToken : null;
}

export async function authorizeOwnerAutomation(
  db: Firestore,
  gatewayId: string,
  proof: OwnerAutomationProof,
  deps: { findAssignedUser: AssignedUserLookup; now?: () => number },
): Promise<OwnerAutomationAuthorization | null> {
  const timestamp = proof.timestamp.trim();
  if (!freshTimestamp(timestamp, deps.now ?? Date.now)) return null;
  const request = signedRequest(proof.body);
  if (!request) return null;
  const assigned = await deps.findAssignedUser(db, gatewayId, request.agentId);
  if (!assigned || !accountAllowsInteractiveAccess(assigned.data)) return null;
  const secret = await coachProofSecret(db, assigned.uid);
  if (!secret) return null;
  const expected = ownerAutomationProofSignature(secret, timestamp, OWNER_AUTOMATIONS_PROOF_PATH, proof.body);
  if (!signaturesMatch(proof.signature.trim(), expected)) return null;
  const turn = await verifyOwnerAutomationTurn(db, {
    agentId: request.agentId,
    ownerUid: assigned.uid,
    assignedData: assigned.data,
    requestContext: request.requestContext,
  });
  if (!turn) return null;
  const parsed = parseAgentId(request.agentId);
  if (parsed.kind !== "coach") return null;
  return { slug: parsed.username, agentId: request.agentId, ...turn, readOnly: request.readOnly };
}
