import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import { logger } from "../middleware/logging.js";
import { db, FieldValue } from "../lib/db.js";
import { decryptSecret } from "../lib/kms.js";
import { revokeAllConnectorGrantsForUser } from "@octogee/core/connector-revocation";
import { liftSuppression } from "../lib/email-suppression.js";
import { runEmailPreflight } from "../lib/email-preflight.js";
import { getResend } from "../lib/resend.js";
import { getWorkspaceMmContext } from "../lib/mattermost-context.js";
import { workspaceSlugsForUser } from "@octogee/core/workspace-slugs";
import { provisionGatewayAuthSecret } from "@octogee/core/secret-manager";
import { listGatewayBuilds } from "@octogee/core/artifact-registry";
import { addAdminFleetRoutes } from "@octogee/core/admin-fleet-router";
import { addAdminCustomerRoutes } from "@octogee/core/admin-customer-router";
import { disableAuthUserAndRevokeSessions } from "@octogee/core/firebase-auth-helpers";
import { MODEL_CATALOG } from "@octogee/shared/types/model-catalog";
import { CONNECTOR_OAUTH_REVOCATION_TARGETS } from "@octogee/shared/types/connectors";
import { modelRefForCatalogEntry } from "@octogee/shared/types/agent-models";
import { BUILDER_TIERS, TIERS } from "@octogee/shared/types/billing-tiers";
import {
  GATEWAY_RELEASES_SUBCOLLECTION,
  isReleasePayload,
  projectGatewayDesiredRootForGateway,
} from "@octogee/shared/types/gateway-releases";
import {
  DEFAULT_FREE_TIER_MODEL_REF,
  DEFAULT_OPS_AGENT_MODEL_REF,
  PLATFORM_CONFIG_COLLECTION,
  PLATFORM_MODEL_CONFIG_DOC,
  PLATFORM_TRIAL_CONFIG_DOC,
  parsePlatformConnectConfig,
  parsePlatformModelConfig,
  parsePlatformTrialConfig,
  resolveFreeTierModel,
  resolveOpsAgentModel,
} from "@octogee/shared/types/platform-config";
import {
  TRIAL_GATEWAY_CLAIMS_COLLECTION,
  isTrialGatewayClaim,
  type TrialGatewayClaimError,
} from "@octogee/shared/types/trial-gateway";
import {
  platformConnectDoc,
  readPlatformConnectConfig,
} from "../lib/platform-connect-config.js";

const router = Router();
router.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
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
  suspendAuthUser: async (uid: string) => {
    const { getAuth } = await import("firebase-admin/auth");
    await disableAuthUserAndRevokeSessions(uid, getAuth());
  },
  revokeConnectorGrantsForUser: (uid: string) =>
    revokeAllConnectorGrantsForUser(uid, CONNECTOR_OAUTH_REVOCATION_TARGETS, {
      db,
      decryptSecret,
      logger,
    }),
});

const platformModelDoc = () =>
  db.collection(PLATFORM_CONFIG_COLLECTION).doc(PLATFORM_MODEL_CONFIG_DOC);

const platformCatalog = MODEL_CATALOG.map((entry) => ({
  ref: modelRefForCatalogEntry(entry),
  label: entry.label,
  provider: entry.provider,
}));

router.get("/platform-config", async (_req, res) => {
  try {
    const snap = await platformModelDoc().get();
    const data = snap.data() as Record<string, unknown> | undefined;
    const freeTierModelRef = typeof data?.freeTierModelRef === "string" &&
      resolveFreeTierModel(data.freeTierModelRef)
      ? data.freeTierModelRef
      : DEFAULT_FREE_TIER_MODEL_REF;
    const opsAgentModelRef = typeof data?.opsAgentModelRef === "string" &&
      resolveOpsAgentModel(data.opsAgentModelRef)
      ? data.opsAgentModelRef
      : DEFAULT_OPS_AGENT_MODEL_REF;
    const invalidFreeTierDial = data?.freeTierModelRef !== undefined &&
      freeTierModelRef !== data.freeTierModelRef;
    const invalidOpsDial = data?.opsAgentModelRef !== undefined &&
      opsAgentModelRef !== data.opsAgentModelRef;
    if (invalidFreeTierDial || invalidOpsDial) {
      logger.warn("[admin] platformConfig/models carries an invalid model ref — defaulting invalid fields", {
        freeTierModelRef: data.freeTierModelRef,
        opsAgentModelRef: data.opsAgentModelRef,
      });
    }
    res.json({
      freeTierModelRef,
      defaultFreeTierModelRef: DEFAULT_FREE_TIER_MODEL_REF,
      opsAgentModelRef,
      defaultOpsAgentModelRef: DEFAULT_OPS_AGENT_MODEL_REF,
      catalog: platformCatalog,
      opsCatalog: platformCatalog.filter((entry) => entry.provider === "openrouter"),
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
        opsAgentModelRef: parsed.opsAgentModelRef,
        updatedAt: FieldValue.serverTimestamp(),
        updatedBy: req.uid ?? null,
      },
      { merge: true },
    );
    logger.info("[admin] platform model dials set", {
      freeTierModelRef: parsed.freeTierModelRef,
      opsAgentModelRef: parsed.opsAgentModelRef,
      updatedBy: req.uid,
    });
    res.json({
      ok: true,
      freeTierModelRef: parsed.freeTierModelRef,
      opsAgentModelRef: parsed.opsAgentModelRef,
    });
  } catch (err) {
    logger.error("[admin] platform-config write failed", { err });
    res.status(500).json({ error: "platform_config_write_failed" });
  }
});

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

const platformTrialDoc = () =>
  db.collection(PLATFORM_CONFIG_COLLECTION).doc(PLATFORM_TRIAL_CONFIG_DOC);

function failedClaimHealth(
  doc: { id: string; data(): unknown } | undefined,
): { builderUid: string | null; lastError: TrialGatewayClaimError | null } {
  if (!doc) return { builderUid: null, lastError: null };
  const claim = doc.data();
  if (!isTrialGatewayClaim(claim) || claim.status !== "failed") {
    logger.error("[admin] oldest failed trial gateway claim is invalid", {
      builderUid: doc.id,
    });
    return {
      builderUid: doc.id,
      lastError: {
        at: Date.now(),
        code: "trial_claim_invalid",
        message: `trialGatewayClaims/${doc.id} is invalid`,
      },
    };
  }
  return { builderUid: doc.id, lastError: claim.lastError as TrialGatewayClaimError };
}

function queuedClaimError(
  doc: { id: string; data(): unknown } | undefined,
): TrialGatewayClaimError | null {
  if (!doc) return null;
  const claim = doc.data();
  if (!isTrialGatewayClaim(claim) || claim.status !== "waiting") {
    logger.error("[admin] oldest waiting trial gateway claim is invalid", {
      builderUid: doc.id,
    });
    return {
      at: Date.now(),
      code: "trial_claim_invalid",
      message: `trialGatewayClaims/${doc.id} is invalid`,
    };
  }
  return claim.lastError ?? null;
}

async function readTrialProvisioningHealth() {
  const claims = db.collection(TRIAL_GATEWAY_CLAIMS_COLLECTION);
  const [
    waitingCountSnap,
    claimedCountSnap,
    failedCountSnap,
    oldestWaitingSnap,
    oldestFailedSnap,
  ] = await Promise.all([
    claims.where("status", "==", "waiting").count().get(),
    claims.where("status", "==", "claimed").count().get(),
    claims.where("status", "==", "failed").count().get(),
    claims.where("status", "==", "waiting").orderBy("requestedAt", "asc").limit(1).get(),
    claims.where("status", "==", "failed").orderBy("requestedAt", "asc").limit(1).get(),
  ]);
  const failed = failedClaimHealth(oldestFailedSnap.docs[0]);
  return {
    waitingClaims: waitingCountSnap.data().count,
    provisionedCount: claimedCountSnap.data().count,
    failedClaims: failedCountSnap.data().count,
    oldestQueuedBuilderUid: oldestWaitingSnap.docs[0]?.id ?? null,
    oldestQueuedClaimError: queuedClaimError(oldestWaitingSnap.docs[0]),
    oldestFailedBuilderUid: failed.builderUid,
    oldestFailedClaimError: failed.lastError,
  };
}

router.get("/platform-trial-config", async (_req, res) => {
  try {
    const [configSnap, provisioning] = await Promise.all([
      platformTrialDoc().get(),
      readTrialProvisioningHealth(),
    ]);
    const config = parsePlatformTrialConfig(configSnap.data());
    if (!config) {
      logger.error("[admin] trial config is missing or invalid", {
        exists: configSnap.exists,
      });
      res.status(409).json({ error: "trial_config_invalid" });
      return;
    }
    res.json({
      config,
      personalPlans: ["personal_free", "personal", "personal_pro", "personal_pro_max"].map((name) => ({
        name,
        displayName: TIERS[name as keyof typeof TIERS].displayName,
      })),
      builderPlans: ["hobby", "pro", "team"].map((name) => ({
        name,
        displayName: BUILDER_TIERS[name as keyof typeof BUILDER_TIERS].displayName,
        sizingTier: BUILDER_TIERS[name as keyof typeof BUILDER_TIERS].instance,
      })),
      provisioning,
    });
  } catch (err) {
    logger.error("[admin] platform-trial-config read failed", { err });
    res.status(500).json({ error: "trial_config_read_failed" });
  }
});

router.put("/platform-trial-config", async (req, res) => {
  const config = parsePlatformTrialConfig(req.body);
  if (!config) {
    res.status(400).json({ error: "invalid_trial_config" });
    return;
  }
  try {
    const sourceRef = db.collection("gateways").doc(config.releaseSourceGatewayId);
    const sourceSnap = await sourceRef.get();
    const source = projectGatewayDesiredRootForGateway(
      sourceSnap.data(),
      config.releaseSourceGatewayId,
    );
    if (source === null || source.desiredStatus === "retired") {
      res.status(400).json({ error: "invalid_release_source" });
      return;
    }
    const releaseSnap = await sourceRef
      .collection(GATEWAY_RELEASES_SUBCOLLECTION)
      .doc(String(source.desiredRelease))
      .get();
    const release = releaseSnap.data();
    if (
      !releaseSnap.exists ||
      release?.gatewayId !== config.releaseSourceGatewayId ||
      release.release !== source.desiredRelease ||
      !isReleasePayload(release.payload)
    ) {
      res.status(400).json({ error: "invalid_release_source" });
      return;
    }
    await platformTrialDoc().set({
      schemaVersion: config.schemaVersion,
      defaultPersonalTier: config.defaultPersonalTier,
      defaultBuilderTier: config.defaultBuilderTier,
      releaseSourceGatewayId: config.releaseSourceGatewayId,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: req.uid ?? null,
    });
    logger.info("[admin] trial defaults set", {
      defaultPersonalTier: config.defaultPersonalTier,
      defaultBuilderTier: config.defaultBuilderTier,
      releaseSourceGatewayId: config.releaseSourceGatewayId,
      updatedBy: req.uid,
    });
    res.json({ ok: true });
  } catch (err) {
    logger.error("[admin] platform-trial-config write failed", { err });
    res.status(500).json({ error: "trial_config_write_failed" });
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
