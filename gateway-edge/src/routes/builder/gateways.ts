import { Router, Request, Response, NextFunction } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { db } from "../../lib/db.js";
import {
  BuilderGatewayListEntry,
  BuilderGatewaysMeResponse,
} from "../../../../shared/types/builder-shell.js";

const router = Router();
router.use(requireAuth);

interface GlmGatewayDoc {
  gatewayId: string;
  instanceName: string;
  profile?: string;
  ownerUid?: string;
  coOwnerUids?: string[];
  desiredStatus?: string;
  imageTag?: string;
}

function builderViewOf(
  doc: GlmGatewayDoc,
  via: "owner" | "co-owner",
): BuilderGatewayListEntry {
  return {
    gatewayId: doc.gatewayId,
    instanceName: doc.instanceName,
    profile: doc.profile ?? "standard",
    desiredStatus: doc.desiredStatus ?? "running",
    imageTag: doc.imageTag,
    via,
  };
}

router.get("/gateways/me", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const uid = req.uid!;
    const ownedSnap = await db
      .collection("glmGateways")
      .where("ownerUid", "==", uid)
      .get();
    const coOwnedSnap = await db
      .collection("glmGateways")
      .where("coOwnerUids", "array-contains", uid)
      .get();

    const seen = new Set<string>();
    const out: BuilderGatewayListEntry[] = [];
    for (const d of ownedSnap.docs) {
      const data = d.data() as GlmGatewayDoc;
      if (seen.has(data.gatewayId)) continue;
      seen.add(data.gatewayId);
      out.push(builderViewOf(data, "owner"));
    }
    for (const d of coOwnedSnap.docs) {
      const data = d.data() as GlmGatewayDoc;
      if (seen.has(data.gatewayId)) continue;
      seen.add(data.gatewayId);
      out.push(builderViewOf(data, "co-owner"));
    }
    out.sort((a, b) => a.gatewayId.localeCompare(b.gatewayId));
    const body: BuilderGatewaysMeResponse = { gateways: out };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

export default router;
