import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request } from "express";
import type { Firestore } from "firebase-admin/firestore";
import { parseAgentId } from "@octogee/shared/types/identity";

const TIMESTAMP_HEADER = "x-octogee-agent-proof-timestamp";
const SIGNATURE_HEADER = "x-octogee-agent-proof-signature";
const MAX_AGE_MS = 30_000;

export interface WorkspaceCommitProofTarget {
  agentId: string;
  slug: string;
  project: string | null;
}

export function workspaceCommitProofSignature(
  secret: string,
  timestamp: string,
  path: string,
  body: string,
): string {
  return createHmac("sha256", secret)
    .update(`octogee-workspace-commit-v1\n${timestamp}\n${path}\n${body}`)
    .digest("hex");
}

function signaturesMatch(actual: string, expected: string): boolean {
  if (!/^[a-f0-9]{64}$/u.test(actual)) return false;
  return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

function secretDocument(ownerUid: string, target: WorkspaceCommitProofTarget): string | null {
  const identity = parseAgentId(target.agentId);
  if (identity.kind === "unknown" || identity.username !== target.slug) return null;
  if (identity.kind === "project") {
    if (identity.project !== target.project) return null;
    return `users/${ownerUid}/secrets/projectAgentMattermost-${identity.project}`;
  }
  return `users/${ownerUid}/secrets/coachMattermost`;
}

function proofHeaders(
  req: Request,
  now: () => number,
): { timestamp: string; signature: string } | null {
  const timestamp = req.get(TIMESTAMP_HEADER)?.trim() ?? "";
  const signature = req.get(SIGNATURE_HEADER)?.trim() ?? "";
  if (!/^\d{10,16}$/u.test(timestamp) || !signature) return null;
  const proofTime = Number(timestamp);
  if (!Number.isSafeInteger(proofTime) || Math.abs(now() - proofTime) > MAX_AGE_MS) return null;
  return { timestamp, signature };
}

async function proofSecret(
  db: Firestore,
  target: WorkspaceCommitProofTarget,
): Promise<string | null> {
  const workspace = await db.doc(`workspaces/${target.slug}`).get();
  const ownerUid = workspace.exists ? workspace.data()?.ownerUid : undefined;
  if (typeof ownerUid !== "string" || ownerUid.length === 0) return null;
  const secretPath = secretDocument(ownerUid, target);
  if (!secretPath) return null;
  const identity = parseAgentId(target.agentId);
  if (identity.kind === "project") {
    const project = await db.doc(`workspaces/${target.slug}/projects/${identity.project}`).get();
    if (!project.exists || project.data()?.agent?.enabled !== true) return null;
  }
  const secret = await db.doc(secretPath).get();
  const personalToken = secret.exists ? secret.data()?.personalToken : undefined;
  return typeof personalToken === "string" && personalToken.length > 0 ? personalToken : null;
}

export async function verifyWorkspaceCommitProof(
  req: Request,
  target: WorkspaceCommitProofTarget,
  db: Firestore,
  now: () => number = Date.now,
): Promise<boolean> {
  const proof = proofHeaders(req, now);
  if (!proof) return false;
  const secret = await proofSecret(db, target);
  if (!secret) return false;

  const expected = workspaceCommitProofSignature(
    secret,
    proof.timestamp,
    req.originalUrl,
    JSON.stringify(req.body),
  );
  return signaturesMatch(proof.signature, expected);
}
