import { Router, type Request, type Response } from "express";
import type { Firestore, Transaction } from "firebase-admin/firestore";

import { isValidUsername, parseAgentId } from "@octogee/shared/types/identity";
import {
  isGatewayDesiredDoc,
  type GatewayDoc,
} from "@octogee/shared/types/gateway-releases";
import {
  isGatewayMutableConfigForGateway,
  type GatewayMutableConfig,
} from "@octogee/core/gateway-live-release";
import { projectAgentSecretDocId } from "@octogee/core/mattermost/project-agent";
import { readAssignedSlugsForGateway } from "@octogee/core/assigned-roster";
import { parseAssignmentDoc } from "@octogee/core/assignment-doc";
import { deriveExpectedAgentId } from "../../../gateway-edge/src/chat-proxy/openclaw/frame-filter.js";
type GatewayBinding = Extract<Express.Request["boundTenant"], { kind: "gateway" }>;

interface AgentIdentity {
  agentId: string;
  uid: string;
  coachMmUserId: string;
  coachToken: string;
  primaryChannelId: string;
  activityChannelId: string;
  channelDocPath: string;
  workspaceSlug: string;
  projectSlug: string;
}

interface ChannelPair {
  primaryChannelId: string;
  activityChannelId: string;
  channelDocPath: string;
}

interface ApprovalRecord {
  approvalId: string;
  kind: "exec" | "plugin";
  channelId: string;
  runId: string;
  expiresAt: number;
  nonce: string;
  agentId: string;
  postId: string;
  dispatched: boolean;
  createdAt: number;
}

type MarkDispatchedResult =
  | { outcome: "dispatched" }
  | { outcome: "already-dispatched" }
  | { outcome: "not-found" };

const TICKETS = "gatewayTickets";
const APPROVALS = "ocApprovals";
const FORBIDDEN = { error: "forbidden" } as const;

function isDurableGatewayRoot(
  data: unknown,
  gatewayId: string,
): data is GatewayDoc & GatewayMutableConfig {
  return (
    isGatewayDesiredDoc(data) &&
    data.gatewayId === gatewayId &&
    isGatewayMutableConfigForGateway(data, gatewayId)
  );
}

function boundGateway(req: Request, res: Response): GatewayBinding | null {
  const bound = req.boundTenant;
  if (!bound || bound.kind !== "gateway") {
    res.status(403).json(FORBIDDEN);
    return null;
  }
  const claimed = (req.body as { gatewayId?: unknown } | undefined)?.gatewayId;
  if (typeof claimed === "string" && claimed.length > 0 && claimed !== bound.gatewayId) {
    res.status(403).json(FORBIDDEN);
    return null;
  }
  return bound;
}

function stringBody(req: Request, key: string): string {
  const value = (req.body as Record<string, unknown> | undefined)?.[key];
  return typeof value === "string" ? value : "";
}

function readPath(obj: Record<string, unknown> | undefined, dotted: string): unknown {
  let cur: unknown = obj;
  for (const part of dotted.split(".")) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function extractRefPath(ref: unknown): string | null {
  if (!ref || typeof ref !== "object") return null;
  const direct = (ref as { path?: unknown }).path;
  if (typeof direct === "string" && direct.length > 0) return direct;

  const segments: string[] = [];
  let cur: unknown = ref;
  while (cur && typeof cur === "object") {
    const node = cur as { id?: unknown; parent?: unknown };
    if (typeof node.id === "string" && node.id.length > 0) segments.unshift(node.id);
    cur = node.parent;
  }
  return segments.length > 0 ? segments.join("/") : null;
}

function workspaceSlugFromChannelPath(path: string | null): string | null {
  if (!path) return null;
  const parts = path.split("/").filter(Boolean);
  if (parts[0] !== "workspaces") return null;
  return isValidUsername(parts[1]) ? parts[1] : null;
}

// Workspace username for ANY of the customer's agents — coach or project
// agent (approvals and run-live writes authorize by assigned slug).
function usernameFromAgentId(agentId: string): string | null {
  const parsed = parseAgentId(agentId);
  return parsed.kind === "unknown" ? null : parsed.username;
}

async function assignedHere(db: Firestore, gatewayId: string, slug: string): Promise<boolean> {
  const assigned = await readAssignedSlugsForGateway(db, gatewayId);
  return assigned.includes(slug);
}

async function userGatewayId(
  db: Firestore,
  uid: string,
): Promise<{ gatewayId: string; userData: Record<string, unknown> } | null> {
  const snap = await db.doc(`users/${uid}`).get();
  if (!snap.exists) return null;
  const userData = snap.data() ?? {};
  const gatewayId = readPath(userData, "provisioning.openclaw.gatewayId");
  return typeof gatewayId === "string" && gatewayId.length > 0
    ? { gatewayId, userData }
    : null;
}

function forbidden(res: Response): void {
  res.status(403).json(FORBIDDEN);
}

async function resolveUidBySlug(db: Firestore, slug: string): Promise<string | null> {
  const snap = await db.collection("users").where("username", "==", slug).get();
  return snap.docs[0]?.id ?? null;
}

interface CoachSecret {
  coachToken: string;
  coachMmUserId: string;
}

interface CoachChannelPair {
  primaryChannelId: string;
  activityChannelId: string;
}

function readCoachSecret(data: Record<string, unknown>): CoachSecret | null {
  const coachToken = typeof data.personalToken === "string" ? data.personalToken : "";
  const coachMmUserId = typeof data.coachMmUserId === "string" ? data.coachMmUserId : "";
  return coachToken && coachMmUserId ? { coachToken, coachMmUserId } : null;
}

function readCoachChannelPair(data: Record<string, unknown>): CoachChannelPair | null {
  const primaryChannelId = readPath(data, "mattermost.channelId");
  const activityChannelId = readPath(data, "mattermost.activityChannelId");
  return typeof primaryChannelId === "string" &&
    primaryChannelId.length > 0 &&
    typeof activityChannelId === "string" &&
    activityChannelId.length > 0
    ? { primaryChannelId, activityChannelId }
    : null;
}

// Project-agent secrets carry {personalToken, mmUserId}; adapt to the coach
// shape the bridge consumes.
function readProjectAgentSecret(data: Record<string, unknown>): CoachSecret | null {
  const coachToken = typeof data.personalToken === "string" ? data.personalToken : "";
  const coachMmUserId = typeof data.mmUserId === "string" ? data.mmUserId : "";
  return coachToken && coachMmUserId ? { coachToken, coachMmUserId } : null;
}

async function resolveAgentIdentity(
  db: Firestore,
  gatewayId: string,
  agentId: string,
): Promise<AgentIdentity | null | "forbidden"> {
  const parsed = parseAgentId(agentId);
  if (parsed.kind === "unknown") return null;
  const slug = parsed.username;
  if (!(await assignedHere(db, gatewayId, slug))) return "forbidden";

  const uid = await resolveUidBySlug(db, slug);
  if (!uid) return null;

  // Vegas: a project agent authenticates as ITS OWN bot (never the coach
  // PAT) and its runs anchor to the project's general channel pair.
  const secretPath =
    parsed.kind === "project"
      ? `users/${uid}/secrets/${projectAgentSecretDocId(parsed.project)}`
      : `users/${uid}/secrets/coachMattermost`;
  const channelDocPath =
    parsed.kind === "project"
      ? `workspaces/${slug}/projects/${parsed.project}/channels/general`
      : `workspaces/${slug}/channels/coach-dm`;

  const [tokenSnap, channelSnap] = await Promise.all([
    db.doc(secretPath).get(),
    db.doc(channelDocPath).get(),
  ]);
  if (!tokenSnap.exists || !channelSnap.exists) return null;
  const secret =
    parsed.kind === "project"
      ? readProjectAgentSecret(tokenSnap.data() ?? {})
      : readCoachSecret(tokenSnap.data() ?? {});
  const channel = readCoachChannelPair(channelSnap.data() ?? {});
  if (!secret || !channel) return null;
  return {
    agentId,
    uid,
    coachMmUserId: secret.coachMmUserId,
    coachToken: secret.coachToken,
    primaryChannelId: channel.primaryChannelId,
    activityChannelId: channel.activityChannelId,
    channelDocPath,
    workspaceSlug: slug,
    projectSlug: parsed.kind === "project" ? parsed.project : "workspace",
  };
}

function trimTrailingSlashes(value: string): string {
  let out = value;
  while (out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

async function resolveChannelPair(
  db: Firestore,
  gatewayId: string,
  primaryChannelId: string,
): Promise<ChannelPair | null | "forbidden"> {
  if (!primaryChannelId) return null;
  const snap = await db
    .collectionGroup("channels")
    .where("mattermost.channelId", "==", primaryChannelId)
    .get();
  const doc = snap.docs[0];
  if (!doc) return null;
  const channelDocPath = extractRefPath((doc as { ref?: unknown }).ref);
  const slug = workspaceSlugFromChannelPath(channelDocPath);
  if (!slug) return null;
  if (!(await assignedHere(db, gatewayId, slug))) return "forbidden";
  const data = doc.data() ?? {};
  const activityChannelId = readPath(data, "mattermost.activityChannelId");
  if (typeof activityChannelId !== "string" || !activityChannelId) return null;
  return { primaryChannelId, activityChannelId, channelDocPath: channelDocPath! };
}

function validateRunLiveWrite(
  body: Record<string, unknown>,
): { path: string; slug: string; doc: Record<string, unknown> } | null {
  const path = typeof body.path === "string" ? body.path : "";
  const doc = body.doc && typeof body.doc === "object" ? body.doc as Record<string, unknown> : null;
  const slug = typeof body.workspaceSlug === "string" ? body.workspaceSlug : "";
  if (!path || !doc || !isValidUsername(slug)) return null;
  const runId = typeof doc.runId === "string" ? doc.runId : "";
  const workspaceId = typeof doc.workspaceId === "string" ? doc.workspaceId : "";
  const channelPath = typeof doc.channelPath === "string" ? doc.channelPath : "";
  if (!runId || workspaceId !== slug || !channelPath.startsWith(`workspaces/${slug}/`)) return null;
  if (path !== `${trimTrailingSlashes(channelPath)}/liveRuns/${runId}`) return null;
  return { path, slug, doc };
}

function slugFromRunLivePath(path: string): string | null {
  const parts = path.split("/").filter(Boolean);
  if (parts[0] !== "workspaces") return null;
  if (!isValidUsername(parts[1])) return null;
  if (!parts.includes("liveRuns")) return null;
  return parts[1];
}

async function resolveChannelOwnerUid(
  db: Firestore,
  gatewayId: string,
  channelId: string,
): Promise<string | null | "forbidden"> {
  for (const field of ["mattermost.channelId", "mattermost.activityChannelId"]) {
    const snap = await db.collectionGroup("channels").where(field, "==", channelId).get();
    const doc = snap.docs[0];
    if (!doc) continue;
    const channelPath = extractRefPath((doc as { ref?: unknown }).ref);
    const slug = workspaceSlugFromChannelPath(channelPath);
    if (!slug) return null;
    if (!(await assignedHere(db, gatewayId, slug))) return "forbidden";
    const ownerPath = channelPath?.slice(0, channelPath.lastIndexOf("/channels/"));
    if (!ownerPath) return null;
    const ownerSnap = await db.doc(ownerPath).get();
    const ownerUid = ownerSnap.data()?.ownerUid;
    return typeof ownerUid === "string" && ownerUid ? ownerUid : null;
  }
  return null;
}

async function resolveUidByMmUser(
  db: Firestore,
  gatewayId: string,
  mmUserId: string,
): Promise<string | null | "forbidden"> {
  if (!mmUserId) return null;
  const snap = await db.collection("users").where("mattermost.userId", "==", mmUserId).get();
  const doc = snap.docs[0];
  if (!doc) return null;
  const uid = doc.id;
  const data = doc.data() ?? {};
  const slug = typeof data.username === "string" ? data.username : "";
  if (!slug || !(await assignedHere(db, gatewayId, slug))) return "forbidden";
  return uid;
}

function requiredString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function optionalString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function approvalKind(value: unknown): ApprovalRecord["kind"] | null {
  return value === "exec" || value === "plugin" ? value : null;
}

function approvalRecordFromBody(body: Record<string, unknown>): ApprovalRecord | null {
  const record = body.record;
  if (!record || typeof record !== "object") return null;
  const r = record as Record<string, unknown>;
  const approvalId = requiredString(r.approvalId);
  const kind = approvalKind(r.kind);
  const channelId = requiredString(r.channelId);
  const runId = requiredString(r.runId);
  const expiresAt = finiteNumber(r.expiresAt);
  const nonce = requiredString(r.nonce);
  const agentId = requiredString(r.agentId);
  const createdAt = finiteNumber(r.createdAt);
  if (!approvalId || !kind || !channelId || !runId || expiresAt === null || !nonce || !agentId || createdAt === null) {
    return null;
  }
  return {
    approvalId,
    kind,
    channelId,
    runId,
    expiresAt,
    nonce,
    agentId,
    postId: optionalString(r.postId),
    dispatched: r.dispatched === true,
    createdAt,
  };
}

async function approvalAssigned(
  db: Firestore,
  gatewayId: string,
  record: ApprovalRecord,
): Promise<boolean> {
  const slug = usernameFromAgentId(record.agentId);
  return !!slug && assignedHere(db, gatewayId, slug);
}

// Resolve the customer's serving revision for WS redemption. A BACKFILLED
// gateway (Step 2) carries its durable identity in gateways/{id} with NO
// internalUrl; the serving URL lives on the revision realization doc. Resolution
// is scoped entirely to the bound gateway: the assignment doc is read from
// gateways/{boundGatewayId}/assignments/{uid} and liveRevisionId from the bound
// gateway doc — never from request content — so this cannot widen tenant access.
export function resolveServingRevisionId(input: {
  gatewayData: Record<string, unknown>;
  assignmentData: Record<string, unknown> | undefined;
  uid: string;
}): string | null {
  const assignment = parseAssignmentDoc(input.uid, input.assignmentData);
  if (assignment && assignment.revisionId.length > 0) return assignment.revisionId;
  const live = input.gatewayData.liveRevisionId;
  return typeof live === "string" && live.length > 0 ? live : null;
}

// Read the revision's serving internalUrl, failing LOUD rather than dialing a
// wrong revision: the revision doc must belong to the bound gateway and must
// carry a non-empty heartbeat.internalUrl.
export function readRevisionInternalUrl(input: {
  revisionData: Record<string, unknown> | undefined;
  expectedGatewayId: string;
  revisionId: string;
}): { url: string } | { error: string } {
  const data = input.revisionData;
  if (!data) return { error: `revision ${input.revisionId} not found` };
  if (data.gateway !== input.expectedGatewayId) {
    return {
      error: `revision ${input.revisionId} belongs to gateway ${String(data.gateway)}, not ${input.expectedGatewayId}`,
    };
  }
  // Never dial a corpse: a retired/failed revision may still carry a stale
  // heartbeat.internalUrl, but the pod is gone (or unhealthy). Reject BEFORE the
  // caller consumes the one-time ticket so the client can retry once the roll
  // settles onto a live revision.
  if (data.lifecycle === "retired" || data.lifecycle === "failed") {
    return { error: `revision ${input.revisionId} is ${String(data.lifecycle)} — not serving` };
  }
  if (data.retiredAt != null) {
    return { error: `revision ${input.revisionId} is retired (retiredAt set) — not serving` };
  }
  const url = readPath(data, "heartbeat.internalUrl");
  if (typeof url !== "string" || url.length === 0) {
    return { error: `revision ${input.revisionId} has no serving internalUrl` };
  }
  return { url };
}

// Resolve the serving gateway URL for a WS redemption inside the redeem
// transaction: legacy internalUrl passthrough, else revision-scoped resolution.
export async function resolveRedeemGatewayUrl(input: {
  tx: Transaction;
  db: Firestore;
  gatewayId: string;
  uid: string;
  gatewayExists: boolean;
  gatewayData: Record<string, unknown>;
}): Promise<{ url: string } | { error: string }> {
  // Un-backfilled path, byte-identical to legacy: a genuine pre-backfill
  // gateways/{id} heartbeat doc carries its own flat internalUrl → use it. A
  // BACKFILLED GatewayDoc must NEVER honor a flat internalUrl even if one is
  // still contaminating the doc (a stale heartbeat dual-write) — that flat URL
  // pins whichever revision heartbeat'd last, silently bypassing assignment /
  // live-revision resolution and attaching the customer to the WRONG revision.
  // A GatewayDoc always goes through revision resolution below.
  const legacyUrl = input.gatewayData.internalUrl;
  if (
    !input.gatewayExists &&
    typeof legacyUrl === "string" &&
    legacyUrl.length > 0
  ) {
    return { url: legacyUrl };
  }
  if (input.gatewayExists && !isDurableGatewayRoot(input.gatewayData, input.gatewayId)) {
    return { error: "gateway-root-invalid" };
  }

  // Backfilled desired doc: resolve the customer's serving revision and read its
  // heartbeat.internalUrl. Fail loud rather than dial the wrong revision.
  const assignmentSnap = await input.tx.get(
    input.db.doc(`gateways/${input.gatewayId}/assignments/${input.uid}`),
  );
  const revisionId = resolveServingRevisionId({
    gatewayData: input.gatewayData,
    assignmentData: assignmentSnap.data(),
    uid: input.uid,
  });
  if (!revisionId) return { error: "gateway-url-unresolved" };
  const revSnap = await input.tx.get(input.db.doc(`glmGateways/${revisionId}`));
  return readRevisionInternalUrl({
    revisionData: revSnap.data(),
    expectedGatewayId: input.gatewayId,
    revisionId,
  });
}

function mountUserAndWsRoutes(router: Router, db: Firestore): void {
  router.post("/users/gateway-id", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const uid = stringBody(req, "uid");
    const resolved = uid ? await userGatewayId(db, uid) : null;
    if (!resolved) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (resolved.gatewayId !== bound.gatewayId) {
      forbidden(res);
      return;
    }
    res.json({ gatewayId: resolved.gatewayId });
  });

  router.post("/ws/redeem", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const ticketId = stringBody(req, "ticketId");
    if (!ticketId) {
      res.status(400).json({ error: "ticketId required" });
      return;
    }

    const result = await db.runTransaction<{
      status: number;
      body: Record<string, unknown>;
    }>(async (tx) => {
      const ticketRef = db.collection(TICKETS).doc(ticketId);
      const ticketSnap = await tx.get(ticketRef);
      if (!ticketSnap.exists) return { status: 401, body: { error: "unauthorized" } };
      const ticket = ticketSnap.data() ?? {};
      const uid = typeof ticket.uid === "string" ? ticket.uid : "";
      const purpose = ticket.purpose;
      const expiresAt = ticket.expiresAt;
      if (!uid || purpose !== "openclaw-ws" || typeof expiresAt !== "number" || expiresAt < Date.now()) {
        return { status: 401, body: { error: "unauthorized" } };
      }

      const userRef = db.doc(`users/${uid}`);
      const userSnap = await tx.get(userRef);
      const userData = userSnap.data() ?? {};
      const gatewayId = readPath(userData, "provisioning.openclaw.gatewayId");
      if (gatewayId !== bound.gatewayId) {
        return { status: 403, body: FORBIDDEN };
      }
      const gwRef = db.doc(`gateways/${bound.gatewayId}`);
      const gwSnap = await tx.get(gwRef);
      const urlResult = await resolveRedeemGatewayUrl({
        tx,
        db,
        gatewayId: bound.gatewayId,
        uid,
        gatewayExists: gwSnap.exists,
        gatewayData: gwSnap.data() ?? {},
      });
      if ("error" in urlResult) {
        return {
          status: 502,
          body: {
            error:
              urlResult.error === "gateway-root-invalid"
                ? "gateway-root-invalid"
                : "gateway-url-unresolved",
          },
        };
      }
      const gatewayUrl = urlResult.url;
      let expectedAgentId: string;
      try {
        expectedAgentId = deriveExpectedAgentId(uid, userData);
      } catch {
        return { status: 502, body: { error: "expected-agent-unresolved" } };
      }
      tx.delete(ticketRef);
      return {
        status: 200,
        body: { uid, gatewayId: bound.gatewayId, gatewayUrl, expectedAgentId },
      };
    });
    res.status(result.status).json(result.body);
  });
}

function mountActivityRoutes(router: Router, db: Firestore): void {
  router.post("/activity/agent-identity", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const identity = await resolveAgentIdentity(db, bound.gatewayId, stringBody(req, "agentId"));
    if (identity === "forbidden") {
      forbidden(res);
      return;
    }
    if (!identity) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({ identity });
  });

  router.post("/activity/channel-pair", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const pair = await resolveChannelPair(db, bound.gatewayId, stringBody(req, "primaryChannelId"));
    if (pair === "forbidden") {
      forbidden(res);
      return;
    }
    if (!pair) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({ pair });
  });

  router.post("/activity/run-live", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const valid = validateRunLiveWrite((req.body ?? {}) as Record<string, unknown>);
    if (!valid) {
      res.status(400).json({ error: "invalid_run_live_doc" });
      return;
    }
    if (!(await assignedHere(db, bound.gatewayId, valid.slug))) {
      forbidden(res);
      return;
    }
    await db.doc(valid.path).set(valid.doc, { merge: true });
    res.status(204).end();
  });

  router.post("/activity/run-live/delete", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const path = stringBody(req, "path");
    const slug = slugFromRunLivePath(path);
    if (!slug) {
      res.status(400).json({ error: "invalid_run_live_path" });
      return;
    }
    if (!(await assignedHere(db, bound.gatewayId, slug))) {
      forbidden(res);
      return;
    }
    await db.doc(path).delete();
    res.status(204).end();
  });

  router.post("/activity/channel-owner", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const ownerUid = await resolveChannelOwnerUid(db, bound.gatewayId, stringBody(req, "channelId"));
    if (ownerUid === "forbidden") {
      forbidden(res);
      return;
    }
    if (!ownerUid) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({ ownerUid });
  });

  router.post("/activity/user-by-mm", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const uid = await resolveUidByMmUser(db, bound.gatewayId, stringBody(req, "mmUserId"));
    if (uid === "forbidden") {
      forbidden(res);
      return;
    }
    if (!uid) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({ uid });
  });
}

function mountApprovalRoutes(router: Router, db: Firestore): void {
  router.post("/activity/approval/register", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const record = approvalRecordFromBody((req.body ?? {}) as Record<string, unknown>);
    if (!record) {
      res.status(400).json({ error: "invalid_approval_record" });
      return;
    }
    if (!(await approvalAssigned(db, bound.gatewayId, record))) {
      forbidden(res);
      return;
    }
    await db.runTransaction(async (tx) => {
      const ref = db.doc(`${APPROVALS}/${record.approvalId}`);
      const snap = await tx.get(ref);
      if (!snap.exists) tx.set(ref, record as unknown as Record<string, unknown>);
    });
    res.status(204).end();
  });

  router.post("/activity/approval/lookup", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const approvalId = stringBody(req, "approvalId");
    const snap = approvalId ? await db.doc(`${APPROVALS}/${approvalId}`).get() : null;
    if (!snap?.exists) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const record = snap.data() as unknown as ApprovalRecord;
    if (!(await approvalAssigned(db, bound.gatewayId, record))) {
      forbidden(res);
      return;
    }
    res.json({ record });
  });

  router.post("/activity/approval/attach-post", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const approvalId = stringBody(req, "approvalId");
    const postId = stringBody(req, "postId");
    const ref = db.doc(`${APPROVALS}/${approvalId}`);
    const snap = approvalId ? await ref.get() : null;
    if (!snap?.exists || !postId) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (!(await approvalAssigned(db, bound.gatewayId, snap.data() as unknown as ApprovalRecord))) {
      forbidden(res);
      return;
    }
    await ref.update({ postId });
    res.status(204).end();
  });

  router.post("/activity/approval/mark-dispatched", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const approvalId = stringBody(req, "approvalId");
    const ref = db.doc(`${APPROVALS}/${approvalId}`);
    const snap = approvalId ? await ref.get() : null;
    if (!snap?.exists) {
      res.json({ outcome: "not-found" satisfies MarkDispatchedResult["outcome"] });
      return;
    }
    if (!(await approvalAssigned(db, bound.gatewayId, snap.data() as unknown as ApprovalRecord))) {
      forbidden(res);
      return;
    }
    const result = await db.runTransaction<MarkDispatchedResult>(async (tx) => {
      const txSnap = await tx.get(ref);
      if (!txSnap.exists) return { outcome: "not-found" };
      const data = txSnap.data() ?? {};
      if (data.dispatched === true) return { outcome: "already-dispatched" };
      tx.update(ref, { dispatched: true });
      return { outcome: "dispatched" };
    });
    res.json(result);
  });

  router.post("/activity/approval/reset-dispatched", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const approvalId = stringBody(req, "approvalId");
    const ref = db.doc(`${APPROVALS}/${approvalId}`);
    const snap = approvalId ? await ref.get() : null;
    if (!snap?.exists) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (!(await approvalAssigned(db, bound.gatewayId, snap.data() as unknown as ApprovalRecord))) {
      forbidden(res);
      return;
    }
    await ref.update({ dispatched: false });
    res.status(204).end();
  });
}

export function createOpenClawRuntimeBrokerRoutes(opts: { db: Firestore }): Router {
  const router = Router();
  const { db } = opts;
  mountUserAndWsRoutes(router, db);
  mountActivityRoutes(router, db);
  mountApprovalRoutes(router, db);
  return router;
}
