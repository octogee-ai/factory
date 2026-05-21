import { Router, Request, Response, NextFunction } from "express";
import { requireAuth } from "../../middleware/auth";
import { logger } from "../../middleware/logging";
import { db, FieldValue } from "../../lib/db";
import {
  validateProviderKey,
  isSupportedProvider,
  type Provider,
} from "../../billing/provider-key-format";
import { probeProviderKey } from "../../billing/provider-probe";
import { writeSecret, archiveSecret } from "../../../../scripts/lib/secret-manager";
import { primaryWorkspaceSlug } from "../../../../scripts/lib/workspace-slugs";
import { byotSecretName, keyFingerprintFor, keyHashFor } from "./helpers";

const router = Router();

// eslint-disable-next-line complexity, sonarjs/cognitive-complexity -- BYOT-key submission flow: validates provider, dedupes against existing, probes the upstream, persists secret + Firestore state in one atomic-feeling sequence. Splitting it would scatter the flow across files.
router.post("/byot-key", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const uid = req.uid!;
    const body = (req.body || {}) as {
      apiKey?: string;
      provider?: string;
      baseUrl?: string;
      model?: string;
    };
    // Default to anthropic only when `provider` is omitted entirely
    // (Phase 1 client contract). If the field is present but unknown,
    // 400 with explicit reason — no silent fallback that misclassifies
    // a typo'd "groq" as anthropic and rejects the key for the wrong
    // format reason.
    let provider: Provider;
    if (body.provider === undefined || body.provider === null) {
      provider = "anthropic";
    } else if (isSupportedProvider(body.provider)) {
      provider = body.provider;
    } else {
      res.status(400).json({
        error: `Unsupported provider: ${String(body.provider)}`,
        supportedProviders: ["anthropic", "openai", "openai-compatible"],
      });
      return;
    }

    // (1) Format check — fast-reject without spending an upstream call.
    const fmt = validateProviderKey(provider, body.apiKey);
    if (!fmt.valid || !fmt.normalized) {
      res.status(400).json({ error: fmt.reason || "Invalid API key format" });
      return;
    }
    const key = fmt.normalized;

    // (1b) Validate baseUrl + model BEFORE the probe. Bad input must
    // never reach the network call or Secret Manager. Same grammar as
    // scripts/lib/byot-multi-provider-config.ts — keep them in sync.
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

    // (2) Provider probe — confirms the key is alive. Distinguishes
    // user-fault (401/403/4xx → 400) from upstream-transient
    // (429/5xx/network → 503) so we never tell a customer their key is
    // bad because the upstream is unavailable.
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

    // Resolve the customer's slug so we can name the Secret Manager entry
    // consistently with what the provisioner will reference.
    const userDoc = await db.collection("users").doc(uid).get();
    const userData = userDoc.data() || {};
    const slug = primaryWorkspaceSlug(userData);
    if (!slug) {
      res.status(400).json({ error: "Customer has no provisioned workspace — cannot register BYOT" });
      return;
    }

    const secretName = byotSecretName(slug, provider);
    const fingerprint = keyFingerprintFor(key);
    const keyHash = keyHashFor(key);

    // (2.5) If the customer is SWITCHING providers, archive the old
    // provider's Secret Manager secret first. Otherwise it'd orphan in
    // SM with an active version forever (we'd lose the ability to
    // archive it later because Firestore's byot.provider is about to
    // be overwritten).
    const cfgSnap = await db.collection("users").doc(uid).collection("system").doc("config").get();
    const previousProvider = cfgSnap.data()?.byot?.provider;
    if (
      isSupportedProvider(previousProvider) &&
      previousProvider !== provider
    ) {
      const oldSecretName = byotSecretName(slug, previousProvider);
      try {
        const { disabledCount } = await archiveSecret(oldSecretName);
        logger.info(`[billing] BYOT provider switch — archived old ${previousProvider} secret ${oldSecretName} (${disabledCount} version(s))`);
      } catch (err) {
        // Don't block the new write if the old archive fails — the
        // customer's intent is to set the new key. Operator can clean up
        // the orphan via gcloud later. Surface in logs so we know.
        logger.warn(`[billing] BYOT provider switch — failed to archive old ${oldSecretName}: ${err}`);
      }
    }

    // (3) Write to Secret Manager. Handles create-if-not-exists + new version.
    // GCP label values must match [\p{Ll}\p{Lo}\p{N}_-]{0,63} — lowercase
    // only. Firebase UIDs are mixed-case, so lowercase before stamping.
    const { versionName } = await writeSecret({
      name: secretName,
      value: key,
      labels: { slug, provider, uid: uid.toLowerCase().slice(0, 63) },
    });

    // (4) Firestore metadata only. NEVER plaintext apiKey.
    // Phase 2: provider, optional baseUrl + model also persisted so the
    // provisioner can render the right per-agent config.
    const byotMetadata: Record<string, unknown> = {
      provider,
      secretName,
      fingerprint,
      keyHash,
      status: "active",
      addedAt: FieldValue.serverTimestamp(),
      lastUsedAt: null,
    };
    if (body.baseUrl) byotMetadata.baseUrl = body.baseUrl;
    if (body.model)   byotMetadata.model   = body.model;

    await db.collection("users").doc(uid).collection("system").doc("config").set(
      { byot: byotMetadata },
      { merge: true },
    );

    // (5) Flip the flag the provisioner polls for.
    await db.collection("users").doc(uid).update({
      byotActive: true,
      updatedAt: FieldValue.serverTimestamp(),
    });

    logger.info(`[billing] BYOT key saved for ${uid} provider=${provider} (${fingerprint}) version=${versionName}`);
    res.json({
      success: true,
      provider,
      fingerprint,
      status: "active",
      message: "Key validated and stored. It takes effect within 30 seconds.",
    });
  } catch (e) { next(e); }
});

router.delete("/byot-key", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const uid = req.uid!;
    const userDoc = await db.collection("users").doc(uid).get();
    const userData = userDoc.data() || {};
    const slug = primaryWorkspaceSlug(userData);
    if (!slug) {
      res.status(400).json({ error: "No BYOT key to remove" });
      return;
    }

    // Phase 2: read the active provider from Firestore metadata so we
    // archive the right Secret Manager entry. Falls back to anthropic
    // for pre-Phase-2 customers whose metadata pre-dated the field.
    const cfgSnap = await db.collection("users").doc(uid).collection("system").doc("config").get();
    const cfgProvider = cfgSnap.data()?.byot?.provider;
    const provider: Provider = isSupportedProvider(cfgProvider) ? cfgProvider : "anthropic";
    const secretName = byotSecretName(slug, provider);

    // Disable all Secret Manager versions. Not destructive — Cloud Audit
    // Logs retain full history for incident response.
    const { disabledCount } = await archiveSecret(secretName);

    // Clear Firestore metadata and flip byotActive off.
    await db.collection("users").doc(uid).collection("system").doc("config").set(
      {
        byot: FieldValue.delete(),
      },
      { merge: true },
    );
    await db.collection("users").doc(uid).update({
      byotActive: false,
      updatedAt: FieldValue.serverTimestamp(),
    });

    logger.info(`[billing] BYOT key removed for ${uid} provider=${provider} (disabled ${disabledCount} SM version(s))`);
    res.json({
      success: true,
      message: "BYOT key removed. Reverting to platform billing within 30 seconds.",
    });
  } catch (e) { next(e); }
});

export default router;
