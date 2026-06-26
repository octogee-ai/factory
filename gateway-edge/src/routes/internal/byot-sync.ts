import { Router, Request, Response, NextFunction } from "express";
import { syncModelCredentialsForCustomer } from "@octogee/core/model-credential-sync-runtime";
import { requireByotSyncInternalAuth } from "../../middleware/byot-sync-auth.js";

const router = Router();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isValidPayload(value: unknown): value is Parameters<typeof syncModelCredentialsForCustomer>[0] {
  if (!isRecord(value)) return false;
  if (typeof value.username !== "string" || value.username.trim().length === 0) return false;
  const provisioning = value.provisioning;
  if (!isRecord(provisioning)) return false;
  const openclaw = provisioning.openclaw;
  if (!isRecord(openclaw)) return false;
  return typeof openclaw.status === "string" && openclaw.status.length > 0;
}

router.post(
  ["/model-credential-sync", "/byot-sync"],
  requireByotSyncInternalAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!isValidPayload(req.body)) {
        res.status(400).json({ error: "username and provisioning.openclaw.status required" });
        return;
      }
      await syncModelCredentialsForCustomer(req.body);
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  },
);

export default router;
