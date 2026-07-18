import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import { logger } from "../middleware/logging.js";
import { db, FieldValue } from "../lib/db.js";
import { liftSuppression } from "../lib/email-suppression.js";
import { runEmailPreflight } from "../lib/email-preflight.js";
import { getResend } from "../lib/resend.js";
import { getWorkspaceMmContext } from "../lib/mattermost-context.js";
import { workspaceSlugsForUser } from "@octogee/core/workspace-slugs";
import { provisionGatewayAuthSecret } from "@octogee/core/secret-manager";
import { listGatewayBuilds } from "@octogee/core/artifact-registry";
import { addAdminFleetRoutes } from "@octogee/core/admin-fleet-router";
import { addAdminCustomerRoutes } from "@octogee/core/admin-customer-router";
import { deleteAuthUserTolerantOfMissing as deleteAuthUserLib } from "@octogee/core/firebase-auth-helpers";
import { MODEL_CATALOG } from "@octogee/shared/types/model-catalog";
import { modelRefForCatalogEntry } from "@octogee/shared/types/agent-models";
import {
  DEFAULT_FREE_TIER_MODEL_REF,
  PLATFORM_CONFIG_COLLECTION,
  PLATFORM_MODEL_CONFIG_DOC,
  parsePlatformConnectConfig,
  parsePlatformModelConfig,
} from "@octogee/shared/types/platform-config";
import {
  platformConnectDoc,
  readPlatformConnectConfig,
} from "../lib/platform-connect-config.js";

const router = Router();
router.use(requireAdmin);

addAdminCustomerRoutes(router, {
  db,
  FieldValue,
  logger,
  workspaceSlugsForUser,
  getWorkspaceMmContext: async (uid, hint) => {
    const ctx = await getWorkspaceMmContext(uid, undefined, hint);
    return ctx ? { coachDmChannelId: ctx.coachDmChannelId } : null;
  },
});

addAdminFleetRoutes(router, {
  db,
  logger,
  workspaceSlugsForUser,
  provisionGatewayAuthSecret,
  listGatewayBuilds,
  deleteAuthUserTolerantOfMissing: async (uid: string) => {
    const { getAuth } = await import("firebase-admin/auth");
    await deleteAuthUserLib(uid, getAuth());
  },
});

// The operator's platform model dials (platformConfig/models). Today one dial:
// the free-tier house model — the broker's free-degrade target and the pod-side
// house pin both follow it. GET always reports the EFFECTIVE value (a stored
// ref that left the catalog reads as the compiled default, same as the broker
// resolves it).
const platformModelDoc = () =>
  db.collection(PLATFORM_CONFIG_COLLECTION).doc(PLATFORM_MODEL_CONFIG_DOC);

router.get("/platform-config", async (_req, res) => {
  try {
    const snap = await platformModelDoc().get();
    const parsed = parsePlatformModelConfig(snap.data());
    if (snap.data() !== undefined && !parsed) {
      logger.warn("[admin] platformConfig/models carries a non-catalog freeTierModelRef — serving the compiled default", {
        freeTierModelRef: (snap.data() as { freeTierModelRef?: unknown })?.freeTierModelRef,
      });
    }
    res.json({
      freeTierModelRef: parsed?.freeTierModelRef ?? DEFAULT_FREE_TIER_MODEL_REF,
      defaultFreeTierModelRef: DEFAULT_FREE_TIER_MODEL_REF,
      catalog: MODEL_CATALOG.map((entry) => ({
        ref: modelRefForCatalogEntry(entry),
        label: entry.label,
        provider: entry.provider,
      })),
    });
  } catch (err) {
    logger.error("[admin] platform-config read failed", { err });
    res.status(500).json({ error: "platform_config_read_failed" });
  }
});

router.put("/platform-config", async (req, res) => {
  const parsed = parsePlatformModelConfig(req.body);
  if (!parsed) {
    res.status(400).json({ error: "invalid_model_ref" });
    return;
  }
  try {
    await platformModelDoc().set(
      {
        freeTierModelRef: parsed.freeTierModelRef,
        updatedAt: FieldValue.serverTimestamp(),
        updatedBy: req.uid ?? null,
      },
      { merge: true },
    );
    logger.info("[admin] free-tier model dial set", {
      freeTierModelRef: parsed.freeTierModelRef,
      updatedBy: req.uid,
    });
    res.json({ ok: true, freeTierModelRef: parsed.freeTierModelRef });
  } catch (err) {
    logger.error("[admin] platform-config write failed", { err });
    res.status(500).json({ error: "platform_config_write_failed" });
  }
});

// Google connect-stage dial: 'allowlist' exists to protect the project's
// lifetime unverified-consent budget at Google, so a stage-only PUT must never
// clobber the curated uid list.
router.get("/platform-connect-config", async (_req, res) => {
  try {
    res.json(await readPlatformConnectConfig());
  } catch (err) {
    logger.error("[admin] platform-connect-config read failed", { err });
    res.status(500).json({ error: "platform_config_read_failed" });
  }
});

router.put("/platform-connect-config", async (req, res) => {
  const parsed = parsePlatformConnectConfig(req.body);
  if (!parsed) {
    res.status(400).json({ error: "invalid_connect_config" });
    return;
  }
  try {
    const bodyHasUids =
      !!req.body && typeof req.body === "object" && "googleAllowlistUids" in (req.body as object);
    const googleAllowlistUids = bodyHasUids
      ? parsed.googleAllowlistUids
      : (await readPlatformConnectConfig()).googleAllowlistUids;
    await platformConnectDoc().set(
      {
        googleStage: parsed.googleStage,
        googleAllowlistUids,
        updatedAt: FieldValue.serverTimestamp(),
        updatedBy: req.uid ?? null,
      },
      { merge: true },
    );
    logger.info("[admin] google connect dial set", {
      googleStage: parsed.googleStage,
      allowlistCount: googleAllowlistUids.length,
      updatedBy: req.uid,
    });
    res.json({ ok: true, googleStage: parsed.googleStage, googleAllowlistUids });
  } catch (err) {
    logger.error("[admin] platform-connect-config write failed", { err });
    res.status(500).json({ error: "platform_config_write_failed" });
  }
});

// One-shot config check: Resend API key real, webhook secret real, sender
// domain verified in Resend. Used after a deploy or rotate-secret to confirm
// the full delivery path is wired before relying on email.
router.get("/email/preflight", async (_req, res) => {
  try {
    const result = await runEmailPreflight({
      env: process.env,
      listDomains: async () => {
        const resend = getResend();
        const r = await (resend.domains.list() as Promise<{
          data?: { data?: Array<{ name?: string; status?: string }> };
        }>);
        return (r.data?.data ?? [])
          .filter((d): d is { name: string; status: string } => !!d.name && !!d.status)
          .map((d) => ({ name: d.name, status: d.status }));
      },
    });
    res.json(result);
  } catch (err) {
    logger.error("[admin] email preflight failed", { err });
    res.status(500).json({ error: "preflight failed" });
  }
});

// Operator override to lift a suppression — the support case where someone
// fixed their inbox after a hard bounce / mis-marked complaint. Address is
// :addr (Express decodes the %40); normalised lowercased by liftSuppression.
router.delete("/email-suppressions/:addr", async (req, res) => {
  const addr = String(req.params.addr || "").trim();
  if (!addr.includes("@")) {
    res.status(400).json({ error: "address must contain @" });
    return;
  }
  try {
    await liftSuppression(addr);
    logger.info("[admin] suppression lifted", { addr: addr.toLowerCase() });
    res.json({ ok: true });
  } catch (err) {
    logger.error("[admin] suppression lift failed", { err, addr });
    res.status(500).json({ error: "lift failed" });
  }
});

export default router;
