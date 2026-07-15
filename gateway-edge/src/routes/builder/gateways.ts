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
  readGatewayLiveRevisionHeartbeat,
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
      const [artifact, heartbeat] = await Promise.all([
        readGatewayArtifact(
          db,
          authorization.gateway.gatewayId,
          authorization.gateway.liveRelease,
        ),
        readGatewayLiveRevisionHeartbeat(db, authorization.gateway),
      ]);
      out.push(builderViewOf(authorization, via, artifact?.imageTag, heartbeat));
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
      const via = gatewayAccessVia(
        authorization.config.ownerUid,
        authorization.config.coOwnerUids,
        uid,
      );
      if (!via) {
        res.status(404).json({ error: "not-found" });
        return;
      }
      const gatewayClass = resolveGatewayClass({
        gatewayClass: authorization.config.gatewayClass,
        profile: authorization.config.profile ?? undefined,
        imageProfile: authorization.config.imageProfile,
      });
      if (!isGatewayClassControlUiAccessEnabled(
        gatewayClass,
        authorization.config.operatorAccess ?? undefined,
      )) {
        res.status(403).json({ error: "capability-disabled" });
        return;
      }
      const result = await db.runTransaction(async (tx) => {
        const rootRef = db.doc(`gateways/${gatewayId}`);
        const rootSnap = await tx.get(rootRef);
        const serving = rootSnap.exists
          ? gatewayAuthorizationFromRootDocument(rootSnap.data(), gatewayId)
          : null;
        if (!serving) return { kind: "not-ready" as const };
        if (!gatewayAccessVia(serving.config.ownerUid, serving.config.coOwnerUids, uid)) {
          return { kind: "not-found" as const };
        }
        const servingClass = resolveGatewayClass({
          gatewayClass: serving.config.gatewayClass,
          profile: serving.config.profile ?? undefined,
          imageProfile: serving.config.imageProfile,
        });
        if (!isGatewayClassControlUiAccessEnabled(
          servingClass,
          serving.config.operatorAccess ?? undefined,
        )) {
          return { kind: "capability-disabled" as const };
        }
        const ownerUid = serving.config.ownerUid;
        const ownerAssignmentSnap = typeof ownerUid === "string"
          ? await tx.get(db.collection("users").doc(ownerUid))
          : null;
        if (
          !ownerAssignmentSnap?.exists ||
          !userAssignmentMatchesGateway(
            ownerAssignmentSnap.data(),
            gatewayId,
            serving.config.builderSlug,
          )
        ) {
          return { kind: "not-found" as const };
        }
        const revisionId = serving.gateway.liveRevisionId;
        if (
          serving.gateway.desiredStatus !== "running" ||
          serving.gateway.roll !== null ||
          serving.gateway.desiredRelease !== serving.gateway.liveRelease ||
          typeof revisionId !== "string" ||
          serving.gateway.trafficRevisionId !== revisionId
        ) {
          return { kind: "not-ready" as const };
        }
        const revisionRef = db.doc(`glmGateways/${revisionId}`);
        const revisionSnap = await tx.get(revisionRef);
        if (!isOpenClawControlRevisionRuntimeReady(
          revisionSnap.exists ? revisionSnap.data() : undefined,
          { gatewayId, revisionId },
        )) {
          return { kind: "not-ready" as const };
        }
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
      if (result.kind === "not-found") {
        res.status(404).json({ error: "not-found" });
        return;
      }
      if (result.kind === "capability-disabled") {
        res.status(403).json({ error: "capability-disabled" });
        return;
      }
      if (result.kind === "not-ready") {
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
