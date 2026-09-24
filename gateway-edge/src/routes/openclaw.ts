import { Router, Request, Response, NextFunction } from "express";
import { randomUUID } from "node:crypto";
import { requireAuth } from "../middleware/auth.js";
import { db } from "../lib/db.js";
import { mintTicket } from "../lib/gateway-ticket.js";
import { accountAllowsInteractiveAccess } from "@octogee/shared/types/account-lifecycle";
import { resolveBuilderTier } from "@octogee/shared/types/billing";
import { BUILDER_TIERS } from "@octogee/shared/types/billing-tiers";
import { isValidGatewayId } from "@octogee/shared/types/glm";
import {
  requestBuilderActivationLease,
  type BuilderActivationLeaseResult,
  type BuilderRuntimeDemandCause,
} from "@octogee/core/builder-activation-lease";

const router = Router();

function activationGatewayId(
  userData: Record<string, unknown> | undefined,
): string | null {
  if (!userData || !accountAllowsInteractiveAccess(userData)) return null;
  const builderTier = resolveBuilderTier(userData);
  if (!builderTier || BUILDER_TIERS[builderTier].instance === null) return null;
  const provisioning = userData.provisioning as
    | { openclaw?: { gatewayId?: unknown; slug?: unknown } }
    | undefined;
  const hasSlug =
    typeof provisioning?.openclaw?.slug === "string" ||
    typeof userData.username === "string";
  return hasSlug && isValidGatewayId(provisioning?.openclaw?.gatewayId)
    ? provisioning.openclaw.gatewayId
    : null;
}

async function requestRuntimeDemand(input: {
  uid: string;
  userData: Record<string, unknown> | undefined;
  cause: BuilderRuntimeDemandCause;
  eventKey: string;
  createdBy: string;
}): Promise<BuilderActivationLeaseResult | null> {
  const reportingGatewayId = activationGatewayId(input.userData);
  if (!reportingGatewayId) return null;
  const assignmentSnap = await db.doc(
    `gateways/${reportingGatewayId}/assignments/${input.uid}`,
  ).get();
  const assignmentData = assignmentSnap.exists
    ? assignmentSnap.data() as Record<string, unknown>
    : undefined;
  return requestBuilderActivationLease({
    db,
    uid: input.uid,
    reportingGatewayId,
    assignmentEpoch:
      typeof assignmentData?.epoch === "number"
        ? assignmentData.epoch
        : undefined,
    eventKey: input.eventKey,
    cause: input.cause,
    observedAt: Date.now(),
    createdBy: input.createdBy,
  });
}

router.post("/ticket", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const uid = req.uid!;
    const provisioning = req.user?.provisioning as { openclaw?: { gatewayId?: unknown } } | undefined;
    const rawGatewayId = provisioning?.openclaw?.gatewayId;
    const gatewayId =
      isValidGatewayId(rawGatewayId)
        ? rawGatewayId
        : "";

    const t = await mintTicket({ uid, gatewayId, purpose: "openclaw-ws" });

    const proxyUrl = process.env.API_PUBLIC_URL || "";
    res.json({ wsTicket: t.ticket, proxyUrl, gatewayId });
  } catch (e) {
    next(e);
  }
});

// The sleep-warning modal's "I'm still here" ack. Manual demand resets the
// disposable idle clock on an active lease and summons the runtime from
// parked/returning — same lease semantics as any other intent signal.
router.post(
  "/runtime-keepalive",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const uid = req.uid!;
      const result = await requestRuntimeDemand({
        uid,
        userData: req.user,
        cause: "manual",
        eventKey: `keepalive:${randomUUID()}`,
        createdBy: `runtime-keepalive:${uid}`,
      });
      if (!result) {
        res.json({ recorded: false });
        return;
      }
      const recorded = result.statusCode === 200 || result.statusCode === 202;
      res.json({
        recorded,
        ...(typeof result.body.status === "string" ? { status: result.body.status } : {}),
        ...(recorded || typeof result.body.code !== "string" ? {} : { code: result.body.code }),
      });
    } catch (e) {
      next(e);
    }
  },
);

export default router;
