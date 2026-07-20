import { Router, type Request, type Response } from "express";
import type { Firestore } from "firebase-admin/firestore";

import { slugFromAssignedUser } from "@octogee/core/assigned-roster";
import { isValidGatewayId } from "@octogee/shared/types/glm";
import { isValidUsername } from "@octogee/shared/types/identity";

type GatewayBinding = Extract<Express.Request["boundTenant"], { kind: "gateway" }>;

const FORBIDDEN = { error: "forbidden" } as const;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function boundGateway(req: Request, res: Response): GatewayBinding | null {
  const bound = req.boundTenant;
  const body = record(req.body);
  if (
    !bound ||
    bound.kind !== "gateway" ||
    !body ||
    Object.keys(body).length !== 1 ||
    !isValidGatewayId(body.gatewayId) ||
    body.gatewayId !== bound.gatewayId
  ) {
    res.status(403).json(FORBIDDEN);
    return null;
  }
  return bound;
}

function safeUid(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !value.includes("/");
}

export function createAutomationAuthorizationBrokerRoutes(opts: { db: Firestore }): Router {
  const router = Router();

  router.post("/authorize", async (req, res, next) => {
    try {
      const bound = boundGateway(req, res);
      if (!bound) return;
      if (!safeUid(req.uid)) {
        res.status(401).json({ error: "Unauthenticated" });
        return;
      }
      if (bound.ownerUid && bound.ownerUid !== req.uid) {
        res.status(403).json(FORBIDDEN);
        return;
      }
      const userSnap = await opts.db.doc(`users/${req.uid}`).get();
      const user = userSnap.exists ? userSnap.data() : undefined;
      const slug = slugFromAssignedUser(user);
      const provisioning = user?.provisioning as Record<string, unknown> | undefined;
      const openclaw = provisioning?.openclaw as Record<string, unknown> | undefined;
      if (!slug || !isValidUsername(slug) || openclaw?.gatewayId !== bound.gatewayId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const workspaceSnap = await opts.db.doc(`workspaces/${slug}`).get();
      if (!workspaceSnap.exists || workspaceSnap.data()?.ownerUid !== req.uid) {
        res.status(403).json(FORBIDDEN);
        return;
      }
      res.json({ slug, gatewayId: bound.gatewayId });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
