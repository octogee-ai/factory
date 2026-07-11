import { Router, Request, Response, NextFunction } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { db } from "../../lib/db.js";
import {
  BuilderGatewayListEntry,
  BuilderGatewaysMeResponse,
} from "@octogee/shared/types/builder-shell";
import {
  isGatewayClassShellAccessEnabled,
  resolveGatewayClass,
  resolveGatewayImageProfile,
} from "@octogee/shared/types/glm";
import {
  readGatewayArtifact,
  gatewayAuthorizationFromRootDocument,
  type GatewayAuthorization,
} from "@octogee/core/gateway-live-release";

const router = Router();
router.use(requireAuth);

function builderViewOf(
  authorization: Extract<GatewayAuthorization, { kind: "durable" }>,
  via: "owner" | "co-owner",
  imageTag: string | undefined,
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
  return {
    gatewayId: gateway.gatewayId,
    profile,
    gatewayClass,
    imageProfile,
    desiredStatus: gateway.desiredStatus,
    imageTag,
    shellsEnabled: isGatewayClassShellAccessEnabled(gatewayClass, config.operatorAccess ?? undefined),
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
      const artifact = await readGatewayArtifact(
        db,
        authorization.gateway.gatewayId,
        authorization.gateway.liveRelease,
      );
      out.push(builderViewOf(authorization, via, artifact?.imageTag));
    }
    out.sort((a, b) => a.gatewayId.localeCompare(b.gatewayId));
    const body: BuilderGatewaysMeResponse = { gateways: out };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

export default router;
