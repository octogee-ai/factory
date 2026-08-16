import { createHmac, timingSafeEqual } from "node:crypto";
import type { Firestore } from "firebase-admin/firestore";
import { parseAgentId } from "@octogee/shared/types/identity";

export const WORKSPACE_COMMIT_PROOF_PATH = "/internal/workspace/commit";

const MAX_AGE_MS = 30_000;

export interface WorkspaceCommitProofTarget {
  agentId: string;
  slug: string;
  project: string | null;
}

export interface WorkspaceCommitProof {
  timestamp: string;
  signature: string;
  body: string;
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

export function workspaceCommitProofTargetFromBody(
  serializedBody: string,
): WorkspaceCommitProofTarget | null {
  let body: unknown;
  try {
    body = JSON.parse(serializedBody);
  } catch {
    return null;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const data = body as Record<string, unknown>;
  const agentId = typeof data.agentId === "string" ? data.agentId : "";
  const slug = typeof data.slug === "string" ? data.slug : "";
  if (!agentId || !slug) return null;
  return {
    agentId,
    slug,
    project: typeof data.project === "string" ? data.project : null,
  };
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

function normalizedProof(
  proof: WorkspaceCommitProof,
  now: () => number,
): Pick<WorkspaceCommitProof, "timestamp" | "signature"> | null {
  const timestamp = proof.timestamp.trim();
  const signature = proof.signature.trim();
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
  proof: WorkspaceCommitProof,
  target: WorkspaceCommitProofTarget,
  db: Firestore,
  now: () => number = Date.now,
): Promise<boolean> {
  const normalized = normalizedProof(proof, now);
  if (!normalized) return false;
  const secret = await proofSecret(db, target);
  if (!secret) return false;

  const expected = workspaceCommitProofSignature(
    secret,
    normalized.timestamp,
    WORKSPACE_COMMIT_PROOF_PATH,
    proof.body,
  );
  return signaturesMatch(normalized.signature, expected);
}
