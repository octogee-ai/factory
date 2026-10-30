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
import {
  createCentralReleaseAuthority,
  listGatewayBuilds,
} from "@octogee/core/artifact-registry";
import { addAdminFleetRoutes } from "@octogee/core/admin-fleet-router";
import { addAdminCustomerRoutes } from "@octogee/core/admin-customer-router";
import { customerDeletionDeps } from "../lib/customer-deletion-deps.js";
import { MODEL_CATALOG } from "@octogee/shared/types/model-catalog";
import { modelRefForCatalogEntry } from "@octogee/shared/types/agent-models";
import { BUILDER_TIERS, TIERS } from "@octogee/shared/types/billing-tiers";
import {
  DEFAULT_BUILDER_AGENT_FALLBACK_MODEL_REF,
  DEFAULT_BUILDER_AGENT_MODEL_REF,
  DEFAULT_FREE_TIER_MODEL_REF,
  DEFAULT_OPS_AGENT_MODEL_REF,
  DEFAULT_PLATFORM_FREE_CONFIG,
  PLATFORM_CONFIG_COLLECTION,
  PLATFORM_FREE_CONFIG_DOC,
  PLATFORM_MODEL_CONFIG_DOC,
  PLATFORM_TRIAL_CONFIG_DOC,
  parsePlatformConnectConfig,
  parsePlatformFreeConfig,
  parsePlatformModelConfig,
  parsePlatformTrialConfig,
  resolveFreeTierModel,
  resolveOpsAgentModel,
} from "@octogee/shared/types/platform-config";
import {
  MalformedPlatformConnectConfigError,
  platformConnectDoc,
  readPlatformConnectConfig,
} from "../lib/platform-connect-config.js";

const router = Router();
router.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
router.use(requireAdmin);

export function centralReleaseRouteDeps(
  targetId = process.env.DEPLOYMENT_TARGET_ID,
): {
  releaseEnvironment: "test" | "prod" | null;
  releaseAuthority?: ReturnType<typeof createCentralReleaseAuthority>;
} {
  if (targetId === "test-central") {
    return {
      releaseEnvironment: "test",
      releaseAuthority: createCentralReleaseAuthority({
        project: "octogee",
        location: "us-central1",
        repository: "octogee",
      }),
    };
  }
  if (targetId === "prod-central") {
    return {
      releaseEnvironment: "prod",
      releaseAuthority: createCentralReleaseAuthority({
        project: "octogee",
        location: "us-central1",
        repository: "octogee",
      }),
    };
  }
  return { releaseEnvironment: null };
}

const centralRelease = centralReleaseRouteDeps();

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
    computerReplacementEnabled: true,
  db,
  logger,
  workspaceSlugsForUser,
  provisionGatewayAuthSecret,
  listGatewayBuilds,
  ...centralRelease,
  suspendAuthUser: customerDeletionDeps.suspendAuthUser,
  revokeConnectorGrantsForUser: customerDeletionDeps.revokeConnectorGrantsForUser,
});

const platformModelDoc = () =>
  db.collection(PLATFORM_CONFIG_COLLECTION).doc(PLATFORM_MODEL_CONFIG_DOC);
const platformFreeDoc = () =>
  db.collection(PLATFORM_CONFIG_COLLECTION).doc(PLATFORM_FREE_CONFIG_DOC);

const platformCatalog = MODEL_CATALOG.map((entry) => ({
  ref: modelRefForCatalogEntry(entry),
  label: entry.label,
  provider: entry.provider,
}));

function validCatalogRef(value: unknown): value is string {
  return typeof value === "string" && resolveFreeTierModel(value) !== null;
}

function resolvedFallbackDial(value: unknown): string | null {
  if (value === null) return null;
  return validCatalogRef(value) ? value : DEFAULT_BUILDER_AGENT_FALLBACK_MODEL_REF;
}

function postHogProjectUrl(value: string | undefined): string | null {
  const normalized = value?.trim();
  if (!normalized) return null;
  try {
    const url = new URL(normalized);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

// Field-tolerant read of the stored dial doc: each invalid field defaults
// independently so one bad ref never blanks the whole Admin panel.
function resolvePlatformModelDials(data: Record<string, unknown> | undefined): {
  freeTierModelRef: string;
  opsAgentModelRef: string;
  builderAgentModelRef: string;
  builderAgentFallbackModelRef: string | null;
  invalidFields: boolean;
} {
  const freeTierModelRef = validCatalogRef(data?.freeTierModelRef)
    ? data.freeTierModelRef
    : DEFAULT_FREE_TIER_MODEL_REF;
  const opsAgentModelRef = typeof data?.opsAgentModelRef === "string" &&
    resolveOpsAgentModel(data.opsAgentModelRef)
    ? data.opsAgentModelRef
    : DEFAULT_OPS_AGENT_MODEL_REF;
  const builderAgentModelRef = validCatalogRef(data?.builderAgentModelRef)
    ? data.builderAgentModelRef
    : DEFAULT_BUILDER_AGENT_MODEL_REF;
  const builderAgentFallbackModelRef = resolvedFallbackDial(data?.builderAgentFallbackModelRef);
  const invalidFields = [
    ["freeTierModelRef", freeTierModelRef],
    ["opsAgentModelRef", opsAgentModelRef],
    ["builderAgentModelRef", builderAgentModelRef],
    ["builderAgentFallbackModelRef", builderAgentFallbackModelRef],
  ].some(([field, resolved]) =>
    data?.[field as string] !== undefined && resolved !== data[field as string],
  );
  return {
    freeTierModelRef,
    opsAgentModelRef,
    builderAgentModelRef,
    builderAgentFallbackModelRef,
    invalidFields,
  };
}

router.get("/platform-config", async (_req, res) => {
  try {
    const snap = await platformModelDoc().get();
    const data = snap.data() as Record<string, unknown> | undefined;
    const dials = resolvePlatformModelDials(data);
    if (dials.invalidFields) {
      logger.warn("[admin] platformConfig/models carries an invalid model ref — defaulting invalid fields", {
        freeTierModelRef: data?.freeTierModelRef,
        opsAgentModelRef: data?.opsAgentModelRef,
        builderAgentModelRef: data?.builderAgentModelRef,
        builderAgentFallbackModelRef: data?.builderAgentFallbackModelRef,
      });
    }
    res.json({
      freeTierModelRef: dials.freeTierModelRef,
      defaultFreeTierModelRef: DEFAULT_FREE_TIER_MODEL_REF,
      opsAgentModelRef: dials.opsAgentModelRef,
      defaultOpsAgentModelRef: DEFAULT_OPS_AGENT_MODEL_REF,
      builderAgentModelRef: dials.builderAgentModelRef,
      defaultBuilderAgentModelRef: DEFAULT_BUILDER_AGENT_MODEL_REF,
      builderAgentFallbackModelRef: dials.builderAgentFallbackModelRef,
      defaultBuilderAgentFallbackModelRef: DEFAULT_BUILDER_AGENT_FALLBACK_MODEL_REF,
      catalog: platformCatalog,
      opsCatalog: platformCatalog.filter((entry) => entry.provider === "openrouter"),
      posthogProjectUrl: postHogProjectUrl(process.env.POSTHOG_PROJECT_URL),
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
        builderAgentModelRef: parsed.builderAgentModelRef,
        builderAgentFallbackModelRef: parsed.builderAgentFallbackModelRef,
        updatedAt: FieldValue.serverTimestamp(),
        updatedBy: req.uid ?? null,
      },
      { merge: true },
    );
    logger.info("[admin] platform model dials set", {
      freeTierModelRef: parsed.freeTierModelRef,
      opsAgentModelRef: parsed.opsAgentModelRef,
      builderAgentModelRef: parsed.builderAgentModelRef,
      builderAgentFallbackModelRef: parsed.builderAgentFallbackModelRef,
      updatedBy: req.uid,
    });
    res.json({
      ok: true,
      freeTierModelRef: parsed.freeTierModelRef,
      opsAgentModelRef: parsed.opsAgentModelRef,
      builderAgentModelRef: parsed.builderAgentModelRef,
      builderAgentFallbackModelRef: parsed.builderAgentFallbackModelRef,
    });
  } catch (err) {
    logger.error("[admin] platform-config write failed", { err });
    res.status(500).json({ error: "platform_config_write_failed" });
  }
});

router.get("/platform-free-config", async (_req, res) => {
  try {
    const snap = await platformFreeDoc().get();
    const config = parsePlatformFreeConfig(snap.data()) ?? DEFAULT_PLATFORM_FREE_CONFIG;
    res.json(config);
  } catch (err) {
    logger.error("[admin] platform-free-config read failed", { err });
    res.status(500).json({ error: "free_config_read_failed" });
  }
});

router.put("/platform-free-config", async (req, res) => {
  const config = parsePlatformFreeConfig(req.body);
  if (!config) {
    res.status(400).json({ error: "invalid_free_config" });
    return;
  }
  try {
    await platformFreeDoc().set({
      schemaVersion: config.schemaVersion,
      workspaceStorageGb: config.workspaceStorageGb,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: req.uid ?? null,
    });
    logger.info("[admin] Free defaults set", {
      workspaceStorageGb: config.workspaceStorageGb,
      updatedBy: req.uid,
    });
    res.json({ ok: true, ...config });
  } catch (err) {
    logger.error("[admin] platform-free-config write failed", { err });
    res.status(500).json({ error: "free_config_write_failed" });
  }
});

router.get("/platform-connect-config", async (_req, res) => {
  try {
    res.json(await readPlatformConnectConfig());
  } catch (err) {
    if (err instanceof MalformedPlatformConnectConfigError) {
      res.status(409).json({ error: "connect_config_invalid" });
      return;
    }
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
    let googleAllowlistUids = parsed.googleAllowlistUids;
    if (!bodyHasUids) {
      try {
        googleAllowlistUids = (await readPlatformConnectConfig()).googleAllowlistUids;
      } catch (err) {
        if (!(err instanceof MalformedPlatformConnectConfigError)) throw err;
        res.status(409).json({
          error: "connect_config_invalid",
          message: "stored doc is malformed; send googleAllowlistUids to replace it",
        });
        return;
      }
    }
    await platformConnectDoc().set({
      googleStages: parsed.googleStages,
      googleAllowlistUids,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: req.uid ?? null,
    });
    logger.info("[admin] google connect dial set", {
      googleStages: parsed.googleStages,
      allowlistCount: googleAllowlistUids.length,
      updatedBy: req.uid,
    });
    res.json({ ok: true, googleStages: parsed.googleStages, googleAllowlistUids });
  } catch (err) {
    logger.error("[admin] platform-connect-config write failed", { err });
    res.status(500).json({ error: "platform_config_write_failed" });
  }
});

const platformTrialDoc = () =>
  db.collection(PLATFORM_CONFIG_COLLECTION).doc(PLATFORM_TRIAL_CONFIG_DOC);

router.get("/platform-trial-config", async (_req, res) => {
  try {
    const configSnap = await platformTrialDoc().get();
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
      builderPlans: [
        { name: null, displayName: "No", sizingTier: null },
        ...["hobby", "pro", "team"].map((name) => ({
          name,
          displayName: BUILDER_TIERS[name as keyof typeof BUILDER_TIERS].displayName,
          sizingTier: BUILDER_TIERS[name as keyof typeof BUILDER_TIERS].instance,
        })),
      ],
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
    await platformTrialDoc().set({
      schemaVersion: config.schemaVersion,
      offerId: config.offerId,
      offerVersion: config.offerVersion,
      durationDays: config.durationDays,
      defaultPersonalTier: config.defaultPersonalTier,
      defaultBuilderTier: config.defaultBuilderTier,
      budgetPolicy: config.budgetPolicy,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: req.uid ?? null,
    });
    logger.info("[admin] trial defaults set", {
      offerId: config.offerId,
      offerVersion: config.offerVersion,
      durationDays: config.durationDays,
      defaultPersonalTier: config.defaultPersonalTier,
      defaultBuilderTier: config.defaultBuilderTier,
      budgetPolicy: config.budgetPolicy,
      updatedBy: req.uid,
    });
    res.json({ ok: true });
  } catch (err) {
    logger.error("[admin] platform-trial-config write failed", { err });
    res.status(500).json({ error: "trial_config_write_failed" });
  }
});

router.get("/email/preflight", async (_req, res) => {
  try {
    const result = await runEmailPreflight({
      env: process.env,
      sendTestEmail: async (message) => {
        const { data, error } = await getResend().emails.send(message);
        return { data: data ? { id: data.id } : null, error };
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
