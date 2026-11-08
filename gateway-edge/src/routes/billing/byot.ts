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
import { byotSecretName, keyFingerprintFor, keyHashFor } from "../../billing/byot-key-identity.js";
import { triggerGatewayModelCredentialSync } from "../../lib/byot-sync-trigger.js";
import { modelCredentialApiKeyState } from "@octogee/shared/types/model-credentials";
import { pickPlanInputs } from "@octogee/shared/types/billing";

const router = Router();

interface CredentialBody {
  apiKey?: unknown;
  provider?: unknown;
  baseUrl?: unknown;
  model?: unknown;
}

interface ResolvedCredentialInput {
  provider: Provider;
  apiKey: unknown;
  baseUrl?: string;
  model?: string;
}

type InputResolution =
  | { ok: true; input: ResolvedCredentialInput }
  | { ok: false; body: Record<string, unknown> };

type ProviderResolution =
  | { ok: true; provider: Provider }
  | { ok: false; body: Record<string, unknown> };

interface CredentialRecordInput {
  provider: Provider;
  secretName: string;
  fingerprint: string;
  keyHash: string;
  addedAt: unknown;
  baseUrl?: string;
  model?: string;
}

function gatewayIdFromRequest(req: Request): string | null {
  const gatewayId = (req.user as { provisioning?: { openclaw?: { gatewayId?: unknown } } } | undefined)
    ?.provisioning?.openclaw?.gatewayId;
  return typeof gatewayId === "string" && gatewayId.length > 0 ? gatewayId : null;
}

function tierFieldsFromRequest(req: Request): Record<string, unknown> {
  const user = req.user ?? {};
  return {
    ...(typeof user.tier === "string" ? { tier: user.tier } : {}),
    ...pickPlanInputs(user as Record<string, unknown>),
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

function resolveProvider(input: unknown): ProviderResolution {
  if (input === undefined || input === null) {
    return { ok: true, provider: "anthropic" };
  }
  if (isSupportedProvider(input)) {
    return { ok: true, provider: input };
  }
  return {
    ok: false,
    body: {
      error: `Unsupported provider: ${String(input)}`,
      supportedProviders: SUPPORTED,
    },
  };
}

function optionalString(
  value: unknown,
  field: "baseUrl" | "model",
): { ok: true; value?: string } | { ok: false; error: string } {
  if (value === undefined || value === null || value === "") return { ok: true };
  if (typeof value !== "string") return { ok: false, error: `Invalid ${field}: ${JSON.stringify(value)}` };
  return { ok: true, value };
}

function validateBaseUrl(baseUrl: string | undefined): string | null {
  if (!baseUrl) return null;
  try {
    const u = new URL(baseUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("scheme");
    if (u.search || u.hash) throw new Error("query/fragment");
    return null;
  } catch {
    return `Invalid baseUrl: ${JSON.stringify(baseUrl)} — must be http(s) without query/fragment`;
  }
}

function validateModel(model: string | undefined): string | null {
  if (!model) return null;
  const ok = /^[A-Za-z0-9._/-]+$/.test(model)
    && !model.startsWith("/") && !model.endsWith("/")
    && !model.includes("//")
    && !model.split("/").includes("..");
  return ok ? null : `Invalid model: ${JSON.stringify(model)}`;
}

function resolveCredentialInput(rawBody: unknown): InputResolution {
  const body = (objectRecord(rawBody) ?? {}) as CredentialBody;
  const providerResolution = resolveProvider(body.provider);
  if (!providerResolution.ok) return providerResolution;

  const baseUrl = optionalString(body.baseUrl, "baseUrl");
  if (!baseUrl.ok) return { ok: false, body: { error: `${baseUrl.error} — must be http(s) without query/fragment` } };
  const baseUrlError = validateBaseUrl(baseUrl.value);
  if (baseUrlError) return { ok: false, body: { error: baseUrlError } };

  const model = optionalString(body.model, "model");
  if (!model.ok) return { ok: false, body: { error: model.error } };
  const modelError = validateModel(model.value);
  if (modelError) return { ok: false, body: { error: modelError } };

  return {
    ok: true,
    input: {
      provider: providerResolution.provider,
      apiKey: body.apiKey,
      ...(baseUrl.value ? { baseUrl: baseUrl.value } : {}),
      ...(model.value ? { model: model.value } : {}),
    },
  };
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

function sendProbeFailure(
  res: Response,
  uid: string,
  provider: Provider,
  probe: { classification?: "user" | "transient"; error?: string; httpStatus?: number },
): void {
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
}

async function archivePreviousProviderIfNeeded(
  slug: string,
  nextProvider: Provider,
  config: Record<string, unknown> | undefined,
): Promise<void> {
  const previousProvider = staticCredentialProviderFromConfig(config);
  if (!previousProvider || previousProvider === nextProvider) return;

  const oldSecretName = byotSecretName(slug, previousProvider);
  try {
    const { disabledCount } = await archiveSecret(oldSecretName);
    logger.info(`[billing] model credential provider switch — archived old ${previousProvider} secret ${oldSecretName} (${disabledCount} version(s))`);
  } catch (err) {
    logger.warn(`[billing] model credential provider switch — failed to archive old ${oldSecretName}: ${err}`);
  }
}

function credentialRecords(input: CredentialRecordInput): {
  byotMetadata: Record<string, unknown>;
  modelCredential: Record<string, unknown>;
} {
  const byotMetadata: Record<string, unknown> = {
    provider: input.provider,
    secretName: input.secretName,
    fingerprint: input.fingerprint,
    keyHash: input.keyHash,
    status: "active",
    addedAt: input.addedAt,
    lastUsedAt: null,
    baseUrl: input.baseUrl ? input.baseUrl : FieldValue.delete(),
    model: input.model ? input.model : FieldValue.delete(),
  };
  const modelCredential: Record<string, unknown> = {
    ...modelCredentialApiKeyState({
      provider: input.provider,
      secretName: input.secretName,
      fingerprint: input.fingerprint,
      keyHash: input.keyHash,
      ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
      ...(input.model ? { model: input.model } : {}),
      addedAt: input.addedAt,
    }),
    baseUrl: input.baseUrl ? input.baseUrl : FieldValue.delete(),
    model: input.model ? input.model : FieldValue.delete(),
  };

  return { byotMetadata, modelCredential };
}

export async function saveModelCredentialKey(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const uid = req.uid!;
    const resolved = resolveCredentialInput(req.body);
    if (!resolved.ok) {
      res.status(400).json(resolved.body);
      return;
    }
    const { provider, apiKey, baseUrl, model } = resolved.input;

    const fmt = validateProviderKey(provider, apiKey);
    if (!fmt.valid || !fmt.normalized) {
      res.status(400).json({ error: fmt.reason || "Invalid API key format" });
      return;
    }
    const key = fmt.normalized;

    const probe = await probeProviderKey({ provider, apiKey: key, baseUrl });
    if (!probe.ok) {
      sendProbeFailure(res, uid, provider, probe);
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
    await archivePreviousProviderIfNeeded(slug, provider, cfgSnap.data());

    const { versionName } = await writeSecret({
      name: secretName,
      value: key,
      labels: { slug, provider, uid: uid.toLowerCase().slice(0, 63) },
    });

    const addedAt = FieldValue.serverTimestamp();
    const { byotMetadata, modelCredential } = credentialRecords({
      provider,
      secretName,
      fingerprint,
      keyHash,
      addedAt,
      ...(baseUrl ? { baseUrl } : {}),
      ...(model ? { model } : {}),
    });

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
        ...(baseUrl ? { baseUrl } : {}),
        ...(model ? { model } : {}),
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
