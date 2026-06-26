import { Router, Request, Response, NextFunction } from "express";
import { logger } from "../../middleware/logging.js";
import { db, FieldValue } from "../../lib/db.js";
import {
  validateProviderKey,
  isSupportedProvider,
  SUPPORTED,
  type Provider,
} from "../../billing/provider-key-format.js";
import { probeProviderKey } from "../../billing/provider-probe.js";
import { writeSecret, archiveSecret } from "@octogee/core/secret-manager";
import { byotSecretName, keyFingerprintFor, keyHashFor } from "./helpers.js";
import { triggerGatewayModelCredentialSync } from "../../lib/byot-sync-trigger.js";
import { modelCredentialApiKeyState } from "@octogee/shared/types/model-credentials";

const router = Router();

function gatewayIdFromRequest(req: Request): string | null {
  const gatewayId = (req.user as { provisioning?: { openclaw?: { gatewayId?: unknown } } } | undefined)
    ?.provisioning?.openclaw?.gatewayId;
  return typeof gatewayId === "string" && gatewayId.length > 0 ? gatewayId : null;
}

function tierFieldsFromRequest(req: Request): Record<string, unknown> {
  const user = req.user ?? {};
  return {
    ...(typeof user.tier === "string" ? { tier: user.tier } : {}),
    ...(typeof user.selectedTier === "string" ? { selectedTier: user.selectedTier } : {}),
    ...(typeof user.trialExpired === "boolean" ? { trialExpired: user.trialExpired } : {}),
  };
}

function triggerByotSync(args: {
  req: Request;
  slug: string;
  byotActive: boolean;
  byot?: { provider: Provider; baseUrl?: string; model?: string };
}): void {
  const gatewayId = gatewayIdFromRequest(args.req);
  if (!gatewayId) {
    logger.warn(`[billing] BYOT sync trigger skipped for ${args.slug}: missing gatewayId`);
    return;
  }
  triggerGatewayModelCredentialSync({
    gatewayId,
    userData: {
      byotActive: args.byotActive,
      username: args.slug,
      provisioning: { openclaw: { status: "complete" } },
      ...tierFieldsFromRequest(args.req),
      ...(args.byot ? { systemConfig: { byot: args.byot } } : {}),
    },
  });
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function staticCredentialProviderFromConfig(
  config: Record<string, unknown> | undefined,
): Provider | undefined {
  const modelCredential = objectRecord(config?.modelCredential);
  if (modelCredential) {
    const provider = modelCredential.active === true ? modelCredential.provider : undefined;
    return isSupportedProvider(provider) ? provider : undefined;
  }

  const byot = objectRecord(config?.byot);
  return isSupportedProvider(byot?.provider) ? byot.provider : undefined;
}

// eslint-disable-next-line complexity, sonarjs/cognitive-complexity -- key submission flow: validates provider, dedupes against existing, probes the upstream, persists secret + Firestore state in one atomic-feeling sequence. Splitting it would scatter the flow across files.
export async function saveModelCredentialKey(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const uid = req.uid!;
    const body = (req.body || {}) as {
      apiKey?: string;
      provider?: string;
      baseUrl?: string;
      model?: string;
    };

let provider: Provider;
    if (body.provider === undefined || body.provider === null) {
      provider = "anthropic";
    } else if (isSupportedProvider(body.provider)) {
      provider = body.provider;
    } else {
      res.status(400).json({
        error: `Unsupported provider: ${String(body.provider)}`,
        supportedProviders: SUPPORTED,
      });
      return;
    }

const fmt = validateProviderKey(provider, body.apiKey);
    if (!fmt.valid || !fmt.normalized) {
      res.status(400).json({ error: fmt.reason || "Invalid API key format" });
      return;
    }
    const key = fmt.normalized;

if (body.baseUrl) {
      try {
        const u = new URL(body.baseUrl);
        if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("scheme");
        if (u.search || u.hash) throw new Error("query/fragment");
      } catch {
        res.status(400).json({ error: `Invalid baseUrl: ${JSON.stringify(body.baseUrl)} — must be http(s) without query/fragment` });
        return;
      }
    }
    if (body.model) {
      const ok = /^[A-Za-z0-9._/-]+$/.test(body.model)
        && !body.model.startsWith("/") && !body.model.endsWith("/")
        && !body.model.includes("//")
        && !body.model.split("/").includes("..");
      if (!ok) {
        res.status(400).json({ error: `Invalid model: ${JSON.stringify(body.model)}` });
        return;
      }
    }

const probe = await probeProviderKey({ provider, apiKey: key, baseUrl: body.baseUrl });
    if (!probe.ok) {
      const transient = probe.classification === "transient";
      const status = transient ? 503 : 400;
      const error = transient
        ? `Couldn't validate your key right now (${provider} is unavailable). Please try again in a minute.`
        : "API key validation failed";
      logger.warn(`[billing] BYOT probe ${transient ? "deferred" : "rejected"} for ${uid} provider=${provider}: ${probe.error} (HTTP ${probe.httpStatus})`);
      res.status(status).json({
        error,
        detail: probe.error,
        httpStatus: probe.httpStatus,
      });
      return;
    }

    const slug = req.workspaceSlug;
    if (!slug) {
      res.status(400).json({ error: "Customer has no provisioned workspace — cannot register BYOT" });
      return;
    }

    const secretName = byotSecretName(slug, provider);
    const fingerprint = keyFingerprintFor(key);
    const keyHash = keyHashFor(key);

const cfgSnap = await db.collection("users").doc(uid).collection("system").doc("config").get();
    const previousProvider = staticCredentialProviderFromConfig(cfgSnap.data());
    if (previousProvider && previousProvider !== provider) {
      const oldSecretName = byotSecretName(slug, previousProvider);
      try {
        const { disabledCount } = await archiveSecret(oldSecretName);
        logger.info(`[billing] model credential provider switch — archived old ${previousProvider} secret ${oldSecretName} (${disabledCount} version(s))`);
      } catch (err) {

logger.warn(`[billing] model credential provider switch — failed to archive old ${oldSecretName}: ${err}`);
      }
    }

const { versionName } = await writeSecret({
      name: secretName,
      value: key,
      labels: { slug, provider, uid: uid.toLowerCase().slice(0, 63) },
    });

const addedAt = FieldValue.serverTimestamp();
    const byotMetadata: Record<string, unknown> = {
      provider,
      secretName,
      fingerprint,
      keyHash,
      status: "active",
      addedAt,
      lastUsedAt: null,
      baseUrl: body.baseUrl ? body.baseUrl : FieldValue.delete(),
      model: body.model ? body.model : FieldValue.delete(),
    };
    const modelCredential: Record<string, unknown> = {
      ...modelCredentialApiKeyState({
        provider,
        secretName,
        fingerprint,
        keyHash,
        ...(body.baseUrl ? { baseUrl: body.baseUrl } : {}),
        ...(body.model ? { model: body.model } : {}),
        addedAt,
      }),
      baseUrl: body.baseUrl ? body.baseUrl : FieldValue.delete(),
      model: body.model ? body.model : FieldValue.delete(),
    };

    await db.collection("users").doc(uid).collection("system").doc("config").set(
      { byot: byotMetadata, modelCredential },
      { merge: true },
    );

await db.collection("users").doc(uid).update({
      byotActive: true,
      updatedAt: FieldValue.serverTimestamp(),
    });

    logger.info(`[billing] model credential key saved for ${uid} provider=${provider} (${fingerprint}) version=${versionName}`);
    triggerByotSync({
      req,
      slug,
      byotActive: true,
      byot: {
        provider,
        ...(body.baseUrl ? { baseUrl: body.baseUrl } : {}),
        ...(body.model ? { model: body.model } : {}),
      },
    });
    res.json({
      success: true,
      provider,
      fingerprint,
      status: "active",
      message: "Model credential validated and stored.",
    });
  } catch (e) { next(e); }
}

export async function deleteModelCredentialKey(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const uid = req.uid!;
    const slug = req.workspaceSlug;
    if (!slug) {
      res.status(400).json({ error: "No model credential to remove" });
      return;
    }

const cfgSnap = await db.collection("users").doc(uid).collection("system").doc("config").get();
    const provider = staticCredentialProviderFromConfig(cfgSnap.data()) ?? "anthropic";
    const secretName = byotSecretName(slug, provider);

const { disabledCount } = await archiveSecret(secretName);

await db.collection("users").doc(uid).collection("system").doc("config").set(
      {
        byot: FieldValue.delete(),
        modelCredential: FieldValue.delete(),
      },
      { merge: true },
    );
    await db.collection("users").doc(uid).update({
      byotActive: false,
      updatedAt: FieldValue.serverTimestamp(),
    });

    logger.info(`[billing] model credential key removed for ${uid} provider=${provider} (disabled ${disabledCount} SM version(s))`);
    triggerByotSync({ req, slug, byotActive: false });
    res.json({
      success: true,
      message: "Model credential removed. Reverting to platform billing.",
    });
  } catch (e) { next(e); }
}

export default router;
