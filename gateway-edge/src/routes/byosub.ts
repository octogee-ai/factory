import { Router, Request, Response, NextFunction } from "express";
import { FieldValue } from "firebase-admin/firestore";
import { requireAuth, requireInternalServiceAuth } from "../middleware/auth.js";
import { db } from "../lib/db.js";
import {
  writeSecret,
  addSecretVersionIfExists,
} from "../../../scripts/lib/secret-manager.js";
import {
  byosubSecretName,
  validateCodexCredential,
  validateClaudeCliCredential,
  validateClaudeCliToken,
  coachAgentId,
  gatewayDeviceAuthClient,
  gatewayClaudeSsoClient,
  byosubConnectionView,
  isSafeGatewayId,
} from "../lib/byosub.js";
import { resolveUserGateway } from "../lib/user-gateway.js";
import { isSafeAgentId } from "../../../scripts/lib/byosub-restore.js";
import { triggerGatewayModelCredentialSync } from "../lib/byot-sync-trigger.js";
import { logger } from "../middleware/logging.js";
import {
  MODEL_CREDENTIAL_SUBSCRIPTION_PROVIDER_IDS,
  modelCredentialOAuthState,
  modelCredentialOAuthEntryByProviderId,
  modelCredentialOAuthEntryBySubscriptionProvider,
  type ModelCredentialOAuthCatalogEntry,
  type ModelCredentialOAuthProviderId,
  type ModelCredentialSubscriptionProviderId,
} from "@shared/types/model-credentials.js";

const router = Router();

interface FlowDoc {
  uid: string;
  gatewayId: string;
  agentId: string;
  provider: string;
  modelCredentialProvider?: string;
  consumedAt?: number;
  expireAt?: number;
}

const FLOW_TTL_MS = 60 * 60 * 1000;

async function readFlow(flowId: string): Promise<FlowDoc | null> {
  const snap = await db.collection("byosubFlows").doc(flowId).get();
  if (!snap.exists) return null;
  return (snap.data() || null) as FlowDoc | null;
}

function subscriptionProviderIds(): ModelCredentialSubscriptionProviderId[] {
  return [...MODEL_CREDENTIAL_SUBSCRIPTION_PROVIDER_IDS];
}

function oauthEntryFromFlow(flow: FlowDoc): ModelCredentialOAuthCatalogEntry | null {
  if (flow.modelCredentialProvider) {
    try {
      return modelCredentialOAuthEntryByProviderId(
        flow.modelCredentialProvider as ModelCredentialOAuthProviderId,
      );
    } catch {
      return null;
    }
  }
  return modelCredentialOAuthEntryBySubscriptionProvider(flow.provider);
}

function validateCredentialForEntry(
  entry: ModelCredentialOAuthCatalogEntry,
  credential: string,
): { ok: true } | { ok: false; reason: string } {
  return entry.id === "claude-cli"
    ? validateClaudeCliCredential(credential)
    : validateCodexCredential(credential);
}

router.post(
  "/connect",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const uid = req.uid!;
      const provider = String((req.body || {}).provider ?? "openai");
      const entry = modelCredentialOAuthEntryBySubscriptionProvider(provider);
      if (!entry) {
        res.status(400).json({
          error: `Unsupported provider: ${provider}`,
          supported: subscriptionProviderIds(),
        });
        return;
      }
      const resolved = await resolveUserGateway(uid);
      if (!resolved) {
        res
          .status(400)
          .json({ error: "No provisioned workspace/gateway for this user" });
        return;
      }
      const agentId = coachAgentId(resolved.slug);
      try {
        const out = entry.oauth.gatewayFlow === "claude-sso"
          ? await gatewayClaudeSsoClient().start({
              gatewayId: resolved.gatewayId,
              agentId,
            })
          : await gatewayDeviceAuthClient().start({
              gatewayId: resolved.gatewayId,
              agentId,
            });

        await db
          .collection("byosubFlows")
          .doc(out.flowId)
          .set({
            uid,
            gatewayId: resolved.gatewayId,
            agentId,
            provider: entry.oauth.subscriptionProvider,
            modelCredentialProvider: entry.id,
            createdAt: Date.now(),
            expireAt: Date.now() + FLOW_TTL_MS,
          });
        res.json(out);
      } catch (e) {
        res.status(503).json({
          error: `Gateway auth flow unavailable: ${(e as Error).message}`,
        });
      }
    } catch (e) {
      next(e);
    }
  },
);

router.get(
  "/status/:flowId",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const flow = await readFlow(req.params.flowId as string);

      if (!flow || flow.uid !== req.uid!) {
        res.status(404).json({ error: "flow not found" });
        return;
      }
      try {
        const flowId = req.params.flowId as string;
        const entry = oauthEntryFromFlow(flow);
        if (!entry) {
          res.status(400).json({ error: `Unsupported provider: ${flow.provider}` });
          return;
        }
        const out = entry.oauth.gatewayFlow === "claude-sso"
          ? await gatewayClaudeSsoClient().status({
              gatewayId: flow.gatewayId,
              flowId,
            })
          : await gatewayDeviceAuthClient().status({
              gatewayId: flow.gatewayId,
              flowId,
            });
        res.json(out);
      } catch (e) {
        res
          .status(503)
          .json({ error: `Gateway status unavailable: ${(e as Error).message}` });
      }
    } catch (e) {
      next(e);
    }
  },
);

router.post(
  "/sso/submit",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const b = (req.body || {}) as { flowId?: string; code?: string };
      if (!b.flowId || typeof b.code !== "string" || !b.code) {
        res.status(400).json({ error: "flowId and code required" });
        return;
      }
      const flow = await readFlow(b.flowId);
      if (!flow || flow.uid !== req.uid!) {
        res.status(404).json({ error: "flow not found" });
        return;
      }
      const entry = oauthEntryFromFlow(flow);
      if (entry?.oauth.gatewayFlow !== "claude-sso") {
        res.status(400).json({ error: "flow is not an Anthropic SSO flow" });
        return;
      }
      try {
        res.json(
          await gatewayClaudeSsoClient().submit({
            gatewayId: flow.gatewayId,
            flowId: b.flowId,
            code: b.code,
          }),
        );
      } catch (e) {
        res
          .status(503)
          .json({ error: `Gateway Claude SSO unavailable: ${(e as Error).message}` });
      }
    } catch (e) {
      next(e);
    }
  },
);

router.get(
  "/connection",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const resolved = await resolveUserGateway(req.uid!);
      if (!resolved) {
        res.json({ connected: false });
        return;
      }
      const snap = await db
        .collection("glmGateways")
        .doc(resolved.gatewayId)
        .get();
      const data = (snap.data() || {}) as {
        byosub?: Record<
          string,
          { provider?: unknown; status?: unknown } | undefined
        >;
      };
      const ref = data.byosub?.[coachAgentId(resolved.slug)];

res.json(byosubConnectionView(ref));
    } catch (e) {
      next(e);
    }
  },
);

// signalProvider is the PROVIDERS-registry key byot-sync reads to drive
// materialization + the coach-model patch: "openai-codex" for ChatGPT Plus,
// "claude-cli" for a Claude subscription.
async function flipUnifiedByosSignal(
  uid: string,
  signalProvider: ModelCredentialOAuthProviderId,
  secretName: string,
): Promise<void> {
  const addedAt = FieldValue.serverTimestamp();
  await db
    .collection("users")
    .doc(uid)
    .collection("system")
    .doc("config")
    .set(
      {
        byot: {
          provider: signalProvider,
          secretName: FieldValue.delete(),
          fingerprint: FieldValue.delete(),
          keyHash: FieldValue.delete(),
          status: FieldValue.delete(),
          addedAt: FieldValue.delete(),
          lastUsedAt: FieldValue.delete(),
          baseUrl: FieldValue.delete(),
          model: FieldValue.delete(),
        },
        modelCredential: {
          ...modelCredentialOAuthState({
            provider: signalProvider,
            secretName,
            addedAt,
          }),
          fingerprint: FieldValue.delete(),
          keyHash: FieldValue.delete(),
          baseUrl: FieldValue.delete(),
          model: FieldValue.delete(),
        },
      },
      { merge: true },
    );
  await db.collection("users").doc(uid).set({ byotActive: true }, { merge: true });
}

function slugFromCoachAgentId(agentId: string): string | null {
  const prefix = "octogee-";
  const suffix = "-coach";
  if (!agentId.startsWith(prefix) || !agentId.endsWith(suffix)) return null;
  return agentId.slice(prefix.length, -suffix.length);
}

function triggerUnifiedByosSync(args: {
  gatewayId: string;
  slug: string;
  provider: ModelCredentialOAuthProviderId;
}): void {
  triggerGatewayModelCredentialSync({
    gatewayId: args.gatewayId,
    userData: {
      byotActive: true,
      username: args.slug,
      provisioning: { openclaw: { status: "complete" } },
      systemConfig: { byot: { provider: args.provider } },
    },
  });
}

function tierFieldsFromRequest(req: Request): Record<string, unknown> {
  const user = req.user ?? {};
  return {
    ...(typeof user.tier === "string" ? { tier: user.tier } : {}),
    ...(typeof user.selectedTier === "string" ? { selectedTier: user.selectedTier } : {}),
    ...(typeof user.trialExpired === "boolean" ? { trialExpired: user.trialExpired } : {}),
  };
}

function triggerUnifiedByosOffSync(req: Request, resolved: { gatewayId: string; slug: string }): void {
  triggerGatewayModelCredentialSync({
    gatewayId: resolved.gatewayId,
    userData: {
      byotActive: false,
      username: resolved.slug,
      provisioning: { openclaw: { status: "complete" } },
      ...tierFieldsFromRequest(req),
    },
  });
}

function triggerUnifiedByosSyncForFlow(
  flow: FlowDoc,
  provider: ModelCredentialOAuthProviderId,
): void {
  const slug = slugFromCoachAgentId(flow.agentId);
  if (!slug) {
    logger.warn(`BYOS sync trigger skipped for malformed agentId=${flow.agentId}`);
    return;
  }
  triggerUnifiedByosSync({ gatewayId: flow.gatewayId, slug, provider });
}

// #1141 — let the Builder clear a connected BYOS credential. The inverse
// of /capture's unified-signal flip + glmGateways.byosub ref-write. The
// Secret Manager secret is intentionally NOT destroyed (disconnect-only,
// not full-wipe); a future re-Connect rewrites a fresh version under the
// same owner-scoped name, so no orphan secret and no doubled-up cred.
// Idempotent end-state: clearing already-clear docs is a safe no-op.
router.post(
  "/disconnect",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const uid = req.uid!;
      const resolved = await resolveUserGateway(uid);

      await db.collection("users").doc(uid).set({ byotActive: false }, { merge: true });
      await db
        .collection("users")
        .doc(uid)
        .collection("system")
        .doc("config")
        .set(
          {
            byot: FieldValue.delete(),
            modelCredential: FieldValue.delete(),
          },
          { merge: true },
        );

      if (resolved) {
        const agentId = coachAgentId(resolved.slug);
        // Single update() — no pre-check. A get() + update() pair has a
        // TOCTOU window where the gateway doc can be deleted between read
        // and write, surfacing a 500 even though our intended end-state
        // (no ref) is already true. Swallow gRPC NOT_FOUND (code 5) and
        // treat as no-op — same pattern as secret-manager.ts:82.
        try {
          await db.collection("glmGateways").doc(resolved.gatewayId).update({
            [`byosub.${agentId}`]: FieldValue.delete(),
          });
        } catch (err) {
          if ((err as { code?: number } | null)?.code !== 5) throw err;
        }
        triggerUnifiedByosOffSync(req, resolved);
      }

      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  },
);

// Claude SUBSCRIPTION capture — paste-token, no device-auth ceremony. The Builder
// runs `claude setup-token` themselves and pastes the bearer here; we validate,
// store it owner-scoped in Secret Manager, write the glmGateways ref, and flip the
// unified BYOS signal to claude-cli. The pod's byot-sync watcher reacts to the
// signal: materializes the per-agent claude-cli store from SM and patches the
// coach model to Opus 4.8 on the customer's own subscription. User-authed (the
// token is provided directly), unlike codex's internal /capture callback.
router.post(
  "/token",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const uid = req.uid!;
      const b = (req.body || {}) as { provider?: string; token?: string };
      const provider = String(b.provider ?? "anthropic");
      const entry = modelCredentialOAuthEntryBySubscriptionProvider(provider);
      if (entry?.id !== "claude-cli") {
        res.status(400).json({
          error: `Unsupported subscription provider: ${provider}`,
          supported: ["anthropic"],
        });
        return;
      }
      if (typeof b.token !== "string") {
        res.status(400).json({ error: "token required" });
        return;
      }
      const v = validateClaudeCliToken(b.token);
      if (!v.ok) {
        res.status(400).json({ error: `invalid token: ${v.reason}` });
        return;
      }
      const resolved = await resolveUserGateway(uid);
      if (!resolved) {
        res.status(400).json({ error: "No provisioned workspace/gateway for this user" });
        return;
      }
      const agentId = coachAgentId(resolved.slug);
      const secretName = byosubSecretName(uid, entry.oauth.secretProvider);
      await writeSecret({
        name: secretName,
        value: b.token.trim(),
        labels: { byosub: "true", provider: entry.oauth.secretProvider },
      });
      await db
        .collection("glmGateways")
        .doc(resolved.gatewayId)
        .set(
          {
            byosub: {
              [agentId]: {
                provider: entry.oauth.secretProvider,
                secretName,
                status: "connected",
              },
            },
          },
          { merge: true },
        );
      await flipUnifiedByosSignal(uid, entry.id, secretName);
      triggerUnifiedByosSync({
        gatewayId: resolved.gatewayId,
        slug: resolved.slug,
        provider: entry.id,
      });
      res.json({ ok: true, secretName });
    } catch (e) {
      next(e);
    }
  },
);

router.post(
  "/capture",
  requireInternalServiceAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const b = (req.body || {}) as { flowId?: string; credential?: string };
      if (!b.flowId || typeof b.credential !== "string") {
        res.status(400).json({ error: "flowId and credential required" });
        return;
      }
      const flow = await readFlow(b.flowId);
      if (!flow) {
        res.status(400).json({ error: "unknown flow" });
        return;
      }
      const entry = oauthEntryFromFlow(flow);
      if (!entry) {
        res
          .status(400)
          .json({ error: `Unsupported provider: ${flow.provider}` });
        return;
      }
      const signalProvider = entry.id;
      const secretProvider = entry.oauth.secretProvider;
      const secretName = byosubSecretName(flow.uid, secretProvider);

      if (flow.consumedAt) {
        await flipUnifiedByosSignal(flow.uid, signalProvider, secretName);
        triggerUnifiedByosSyncForFlow(flow, signalProvider);
        res.json({ ok: true, secretName, alreadyConsumed: true });
        return;
      }
      const v = validateCredentialForEntry(entry, b.credential);
      if (!v.ok) {
        res.status(400).json({ error: `invalid credential: ${v.reason}` });
        return;
      }
      await writeSecret({
        name: secretName,
        value: b.credential,
        labels: { byosub: "true", provider: secretProvider },
      });
      await db
        .collection("glmGateways")
        .doc(flow.gatewayId)
        .set(
          {
            byosub: {
              [flow.agentId]: {
                provider: secretProvider,
                secretName,
                status: "connected",
              },
            },
          },
          { merge: true },
        );

      await flipUnifiedByosSignal(flow.uid, signalProvider, secretName);
      triggerUnifiedByosSyncForFlow(flow, signalProvider);

      await db
        .collection("byosubFlows")
        .doc(b.flowId)
        .set({ consumedAt: Date.now() }, { merge: true });
      res.json({ ok: true, secretName });
    } catch (e) {
      next(e);
    }
  },
);

router.post(
  "/auth-state",
  requireInternalServiceAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const b = (req.body || {}) as {
        gatewayId?: string;
        agentId?: string;
        state?: string;
      };
      if (
        !isSafeGatewayId(b.gatewayId) ||
        !b.agentId ||
        !isSafeAgentId(b.agentId) ||
        b.state !== "needs_reauth"
      ) {
        res.status(400).json({
          error: "path-safe gatewayId, path-safe agentId, state:'needs_reauth' required",
        });
        return;
      }
      const snap = await db.collection("glmGateways").doc(b.gatewayId).get();
      const byosub = ((snap.data() || {}) as { byosub?: Record<string, unknown> })
        .byosub;
      if (
        !byosub ||
        !Object.prototype.hasOwnProperty.call(byosub, b.agentId)
      ) {

res.json({ ok: true, noop: true });
        return;
      }
      await db
        .collection("glmGateways")
        .doc(b.gatewayId)
        .set(
          { byosub: { [b.agentId]: { status: "needs_reauth" } } },
          { merge: true },
        );
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  },
);

router.post(
  "/sync-back",
  requireInternalServiceAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const b = (req.body || {}) as {
        gatewayId?: string;
        agentId?: string;
        credential?: string;
      };
      if (
        !isSafeGatewayId(b.gatewayId) ||
        !b.agentId ||
        !isSafeAgentId(b.agentId) ||
        typeof b.credential !== "string"
      ) {
        res.status(400).json({
          error:
            "path-safe gatewayId, path-safe agentId, credential string required",
        });
        return;
      }
      const v = validateCodexCredential(b.credential);
      if (!v.ok) {
        res.status(400).json({ error: `invalid credential: ${v.reason}` });
        return;
      }
      const snap = await db.collection("glmGateways").doc(b.gatewayId).get();
      const byosub = (
        (snap.data() || {}) as {
          byosub?: Record<string, { secretName?: unknown } | undefined>;
        }
      ).byosub;
      const ref =
        byosub && Object.prototype.hasOwnProperty.call(byosub, b.agentId)
          ? byosub[b.agentId]
          : undefined;
      if (!ref || typeof ref.secretName !== "string" || !ref.secretName) {

res.json({ ok: true, noop: true });
        return;
      }

const w = await addSecretVersionIfExists(ref.secretName, b.credential);
      if (!w.ok) {
        res.json({ ok: true, noop: true });
        return;
      }
      res.json({ ok: true, secretName: ref.secretName });
    } catch (e) {
      next(e);
    }
  },
);

export default router;
