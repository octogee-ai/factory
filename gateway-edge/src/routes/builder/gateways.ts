import { Router, Request, Response, NextFunction } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { db } from "../../lib/db.js";
import {
  BuilderGatewayListEntry,
  BuilderGatewaysMeResponse,
} from "@octogee/shared/types/builder-shell";
import {
  isGatewayClassShellAccessEnabled,
  isGatewayClass,
  isGatewayProfile,
  resolveGatewayClass,
  resolveGatewayImageProfile,
  type GatewayClass,
  type GatewayImageProfile,
  type OperatorGatewayAccessSpec,
} from "@octogee/shared/types/glm";

const router = Router();
router.use(requireAuth);

interface GlmGatewayDoc {
  gatewayId: string;
  profile?: string;
  gatewayClass?: string;
  imageProfile?: string;
  ownerUid?: string;
  coOwnerUids?: string[];
  desiredStatus?: string;
  imageTag?: string;
  operatorAccess?: OperatorGatewayAccessSpec;
}

function builderViewOf(
  doc: GlmGatewayDoc,
  via: "owner" | "co-owner",
): BuilderGatewayListEntry {
  const explicitProfile = isGatewayProfile(doc.profile) ? doc.profile : undefined;
  const profile = explicitProfile ?? "standard";
  const explicitImageProfile = isGatewayProfile(doc.imageProfile)
    ? doc.imageProfile
    : undefined;
  const gatewayClass: GatewayClass = resolveGatewayClass({
    gatewayClass: isGatewayClass(doc.gatewayClass) ? doc.gatewayClass : undefined,
    profile: explicitProfile,
    imageProfile: explicitImageProfile,
  });
  const imageProfile: GatewayImageProfile = resolveGatewayImageProfile({
    gatewayClass,
    imageProfile: explicitImageProfile,
    profile: explicitProfile,
  });
  return {
    gatewayId: doc.gatewayId,
    profile,
    gatewayClass,
    imageProfile,
    desiredStatus: doc.desiredStatus ?? "running",
    imageTag: doc.imageTag,
    shellsEnabled: isGatewayClassShellAccessEnabled(gatewayClass, doc.operatorAccess),
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
