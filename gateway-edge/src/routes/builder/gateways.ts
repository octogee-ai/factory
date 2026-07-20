import { Router, Request, Response, NextFunction } from "express";
import rateLimit from "express-rate-limit";
import { requireAuth } from "../../middleware/auth.js";
import { db, FieldValue, Timestamp } from "../../lib/db.js";
import {
  BuilderGatewayListEntry,
  BuilderGatewaysMeResponse,
} from "@octogee/shared/types/builder-shell";
import {
  isGatewayClassShellAccessEnabled,
  isGatewayClassControlUiAccessEnabled,
  isValidGatewayId,
  resolveGatewayClass,
  resolveGatewayImageProfile,
} from "@octogee/shared/types/glm";
import {
  readGatewayArtifact,
  readGatewayAuthorization,
  readGatewayRuntimeHeartbeat,
  gatewayAuthorizationFromRootDocument,
  type GatewayAuthorization,
} from "@octogee/core/gateway-live-release";
import { projectOpenClawConfigStatus } from "../../lib/openclaw-config-status.js";
import {
  OPENCLAW_CONTROL_AUDIT_COLLECTION,
  OPENCLAW_CONTROL_TICKETS_COLLECTION,
  createOpenClawControlTicket,
} from "@octogee/core/openclaw-control-tickets";
import { userAssignmentMatchesGateway } from "@octogee/core/assigned-roster";
import { isOpenClawControlRevisionRuntimeReady } from "../../openclaw-control/runtime-ready.js";

const router = Router();
router.use(requireAuth);
const NOT_FOUND = "not-found";
const CAPABILITY_DISABLED = "capability-disabled";
const NOT_READY = "not-ready";

const openClawTicketRateLimit = rateLimit({
  windowMs: 60_000,
  limit: 6,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => `${req.uid}:${req.params.gatewayId}`,
  message: { error: "ticket-rate-limited", retryable: true },
});

function builderViewOf(
  authorization: Extract<GatewayAuthorization, { kind: "durable" }>,
  via: "owner" | "co-owner",
  imageTag: string | undefined,
  heartbeat: Record<string, unknown> | null,
  isCurrentAssignment: boolean,
): BuilderGatewayListEntry {
  const { gateway, config } = authorization;
  const explicitProfile = config.profile ?? undefined;
  const profile = explicitProfile ?? "standard";
  const gatewayClass = resolveGatewayClass({
    gatewayClass: config.gatewayClass,
    profile: explicitProfile,
    imageProfile: config.imageProfile,
  });
  const imageProfile = resolveGatewayImageProfile({
    gatewayClass,
    imageProfile: config.imageProfile,
    profile: explicitProfile,
  });
  const configStatus = projectOpenClawConfigStatus(heartbeat);
  return {
    gatewayId: gateway.gatewayId,
    ...(config.builderSlug ? { workspaceSlug: config.builderSlug } : {}),
    profile,
    gatewayClass,
    imageProfile,
    desiredStatus: gateway.desiredStatus,
    imageTag,
    shellsEnabled: isGatewayClassShellAccessEnabled(gatewayClass, config.operatorAccess ?? undefined),
    controlUiEnabled: isGatewayClassControlUiAccessEnabled(
      gatewayClass,
      config.operatorAccess ?? undefined,
    ),
    isCurrentAssignment,
    ...(configStatus ? { configStatus } : {}),
    via,
  };
}

function gatewayAccessVia(
  ownerUid: string | null,
  coOwnerUids: readonly string[],
  uid: string,
): "owner" | "co-owner" | null {
  if (ownerUid === uid) return "owner";
  if (coOwnerUids.includes(uid)) return "co-owner";
  return null;
}

router.get("/gateways/me", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const uid = req.uid!;
    const seen = new Set<string>();
    const out: BuilderGatewayListEntry[] = [];
    const [ownedSnap, coOwnedSnap] = await Promise.all([
      db.collection("gateways").where("ownerUid", "==", uid).get(),
      db.collection("gateways").where("coOwnerUids", "array-contains", uid).get(),
    ]);
    for (const doc of [...ownedSnap.docs, ...coOwnedSnap.docs]) {
      const authorization = gatewayAuthorizationFromRootDocument(doc.data(), doc.id);
      if (!authorization) continue;
      const { ownerUid, coOwnerUids } = authorization.config;
      const via = gatewayAccessVia(ownerUid, coOwnerUids, uid);
      if (!via || seen.has(authorization.gateway.gatewayId)) continue;
      seen.add(authorization.gateway.gatewayId);
      const ownerAssignmentPromise = typeof ownerUid === "string"
        ? db.collection("users").doc(ownerUid).get()
        : Promise.resolve(null);
      const [artifact, heartbeat, ownerAssignment] = await Promise.all([
        readGatewayArtifact(
          db,
          authorization.gateway.gatewayId,
          authorization.gateway.liveRelease,
        ),
        readGatewayRuntimeHeartbeat(db, authorization.gateway),
        ownerAssignmentPromise,
      ]);
      const isCurrentAssignment = ownerAssignment?.exists === true && userAssignmentMatchesGateway(
        ownerAssignment.data(),
        authorization.gateway.gatewayId,
        authorization.config.builderSlug,
      );
      out.push(builderViewOf(
        authorization,
        via,
        artifact?.imageTag,
        heartbeat,
        isCurrentAssignment,
      ));
    }
    out.sort((a, b) => a.gatewayId.localeCompare(b.gatewayId));
    const body: BuilderGatewaysMeResponse = { gateways: out };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

function apiOrigin(): string {
  const configured = process.env.API_PUBLIC_URL?.trim();
  if (!configured) throw new Error("API_PUBLIC_URL is required for OpenClaw Dashboard launch URLs");
  return configured.replace(/\/$/u, "");
}

type TicketResult =
  | { kind: typeof NOT_FOUND }
  | { kind: typeof CAPABILITY_DISABLED }
  | { kind: typeof NOT_READY }
  | { kind: "minted"; minted: ReturnType<typeof createOpenClawControlTicket> };

function controlUiAccess(
  authorization: Extract<GatewayAuthorization, { kind: "durable" }>,
  uid: string,
): "allowed" | typeof NOT_FOUND | typeof CAPABILITY_DISABLED {
  if (!gatewayAccessVia(
    authorization.config.ownerUid,
    authorization.config.coOwnerUids,
    uid,
  )) return NOT_FOUND;
  const gatewayClass = resolveGatewayClass({
    gatewayClass: authorization.config.gatewayClass,
    profile: authorization.config.profile ?? undefined,
    imageProfile: authorization.config.imageProfile,
  });
  return isGatewayClassControlUiAccessEnabled(
    gatewayClass,
    authorization.config.operatorAccess ?? undefined,
  ) ? "allowed" : CAPABILITY_DISABLED;
}

function servingRevisionId(
  authorization: Extract<GatewayAuthorization, { kind: "durable" }>,
): string | null {
  const { gateway } = authorization;
  if (gateway.desiredStatus !== "running" ||
    gateway.desiredRelease !== gateway.liveRelease ||
    typeof gateway.liveRelease !== "number") return null;
  return gateway.gatewayId;
}

async function mintOpenClawTicket(gatewayId: string, uid: string): Promise<TicketResult> {
  return db.runTransaction(async (tx) => {
    const rootSnap = await tx.get(db.doc(`gateways/${gatewayId}`));
    const serving = rootSnap.exists
      ? gatewayAuthorizationFromRootDocument(rootSnap.data(), gatewayId)
      : null;
    if (!serving) return { kind: NOT_READY };
    const access = controlUiAccess(serving, uid);
    if (access !== "allowed") return { kind: access };
    const ownerUid = serving.config.ownerUid;
    const ownerAssignmentSnap = typeof ownerUid === "string"
      ? await tx.get(db.collection("users").doc(ownerUid))
      : null;
    if (!ownerAssignmentSnap?.exists || !userAssignmentMatchesGateway(
      ownerAssignmentSnap.data(),
      gatewayId,
      serving.config.builderSlug,
    )) return { kind: NOT_FOUND };
    const revisionId = servingRevisionId(serving);
    if (!revisionId) return { kind: NOT_READY };
    const revisionSnap = await tx.get(db.doc(`glmGateways/${revisionId}`));
    if (!isOpenClawControlRevisionRuntimeReady(
      revisionSnap.exists ? revisionSnap.data() : undefined,
      { gatewayId, revisionId },
    )) return { kind: NOT_READY };
    const minted = createOpenClawControlTicket({ uid, gatewayId, revisionId });
    tx.set(db.collection(OPENCLAW_CONTROL_TICKETS_COLLECTION).doc(minted.ticketHash), {
      ...minted.document,
      createdAt: FieldValue.serverTimestamp(),
      expireAt: Timestamp.fromMillis(minted.document.expiresAt),
    });
    tx.set(db.collection(OPENCLAW_CONTROL_AUDIT_COLLECTION).doc(), {
      gatewayId,
      revisionId,
      uid,
      event: "ticket_mint",
      outcome: "ok",
      reason: "none",
      createdAt: FieldValue.serverTimestamp(),
    });
    return { kind: "minted" as const, minted };
  });
}

router.post(
  "/gateways/:gatewayId/openclaw-ticket",
  openClawTicketRateLimit,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const gatewayId = req.params.gatewayId;
      if (!isValidGatewayId(gatewayId)) {
        res.status(404).json({ error: "not-found" });
        return;
      }
      const uid = req.uid!;
      const authorization = await readGatewayAuthorization(db, gatewayId);
      if (!authorization) {
        res.status(404).json({ error: "not-found" });
        return;
      }
      const access = controlUiAccess(authorization, uid);
      if (access === NOT_FOUND) {
        res.status(404).json({ error: "not-found" });
        return;
      }
      if (access === CAPABILITY_DISABLED) {
        res.status(403).json({ error: CAPABILITY_DISABLED });
        return;
      }
      const result = await mintOpenClawTicket(gatewayId, uid);
      if (result.kind === NOT_FOUND) {
        res.status(404).json({ error: "not-found" });
        return;
      }
      if (result.kind === CAPABILITY_DISABLED) {
        res.status(403).json({ error: CAPABILITY_DISABLED });
        return;
      }
      if (result.kind === NOT_READY) {
        res.status(409).json({ error: "gateway-not-ready", retryable: true });
        return;
      }
      res.status(201).json({
        launchUrl: `${apiOrigin()}/g/${gatewayId}/openclaw/launch/${result.minted.ticket}`,
        expiresAt: result.minted.document.expiresAt,
      });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
