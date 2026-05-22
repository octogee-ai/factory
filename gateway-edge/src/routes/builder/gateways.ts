import { Router, Request, Response, NextFunction } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { db } from "../../lib/db.js";
import { logger } from "../../middleware/logging.js";
import {
  mintTicket,
  HourlyMintQuotaExceededError,
  TicketCapExceededError,
} from "../../lib/builder-shell-tickets.js";
import {
  BuilderGatewayListEntry,
  BuilderGatewaysMeResponse,
  BuilderShellTicketMintResponse,
  BUILDER_SHELL_WS_PATH_PREFIX,
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

// Builder-facing projection of the raw glmGateways doc — strips every
// operator-internal field (byosub, openclawOverrides, image refs apart
// from tag, serviceAccountName, security context overrides, lastError).
// The Firestore rule denies client reads on glmGateways; this is the
// only Builder-visible surface.
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

router.post(
  "/gateways/:id/shell-ticket",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const uid = req.uid!;
      const gatewayId = req.params.id as string;
      if (!/^[a-z0-9-]+$/.test(gatewayId)) {
        res.status(400).json({ error: "Invalid gateway id" });
        return;
      }
      const snap = await db.collection("glmGateways").doc(gatewayId).get();
      // "Not yours" and "does not exist" return the same 404. Distinct
      // codes would let an authenticated Builder enumerate the gatewayId
      // namespace (slugs are predictable from public profiles) — a
      // reconnaissance vector for any future shell-related vuln.
      if (!snap.exists) {
        res.status(404).json({ error: "Gateway not found" });
        return;
      }
      const data = snap.data() as GlmGatewayDoc;
      // `via` is decided here from the Firestore doc — never from a
      // request-supplied value. The PWA / chat-proxy / gateway must
      // trust the `via` returned by /redeem; nothing they send is
      // load-bearing for that decision.
      //
      // TOCTOU window: if the owner removes a co-owner during the 30s
      // ticket lifetime, the already-minted ticket still redeems.
      // Acceptable for 30s; documented so a future reader doesn't
      // assume "revocation is immediate."
      let via: "owner" | "co-owner" | null = null;
      if (data.ownerUid === uid) via = "owner";
      else if (Array.isArray(data.coOwnerUids) && data.coOwnerUids.includes(uid)) via = "co-owner";
      if (!via) {
        res.status(404).json({ error: "Gateway not found" });
        return;
      }

      let ticket;
      try {
        ticket = await mintTicket({ uid, gatewayId, via });
      } catch (err) {
        if (err instanceof TicketCapExceededError) {
          logger.warn("builder-shell: concurrent-ticket cap exceeded", {
            uid: err.uid,
            gatewayId,
            cap: err.cap,
          });
          res.status(429).json({
            error: "Too many in-flight shell tickets — wait for one to expire (30s) before requesting another",
          });
          return;
        }
        if (err instanceof HourlyMintQuotaExceededError) {
          logger.warn("builder-shell: hourly mint quota exceeded", {
            uid: err.uid,
            gatewayId,
            quota: err.quota,
            windowMs: err.windowMs,
          });
          // Retry-After in seconds — conservative: tell the client
          // to back off ~5 min before retrying, even though the
          // earliest entry rolls out of the window at some point in
          // the past hour. 5 min is short enough to feel responsive
          // and long enough to drain a hot loop.
          res.set("Retry-After", "300");
          res.status(429).json({
            error: `Hourly shell-mint quota exceeded for this user (${err.quota}/hour). Try again later.`,
          });
          return;
        }
        throw err;
      }
      // Single host (api.octogee.com), fleet-pinned: the builder-shell WS
      // lands on the user's home gateway pod via /api/g/<gw>/ — that's
      // where the PTY spawns (POST-BENDER-CLEANUP-SPEC §2.7).
      const base = process.env.API_PUBLIC_URL || "";
      if (!base) {
        logger.warn("builder-shell: API_PUBLIC_URL not set — returning ticket without wsUrl");
      }
      const wsUrl = base
        ? `${base.replace(/^http/, "ws").replace(/\/$/, "")}/api/g/${gatewayId}${BUILDER_SHELL_WS_PATH_PREFIX}/${ticket.ticket}`
        : null;

      const body: BuilderShellTicketMintResponse = {
        ticket: ticket.ticket,
        wsUrl,
        gatewayId,
        via,
        expiresAt: ticket.expiresAt,
      };
      res.json(body);
    } catch (err) {
      next(err);
    }
  },
);

export default router;
