import { Router, Request, Response, NextFunction } from "express";
import * as fs from "fs";
import * as os from "os";
import { FieldValue } from "firebase-admin/firestore";
import { requireAuth, requireInternalServiceAuth } from "../middleware/auth.js";
import { db } from "../lib/db.js";
import {
  writeSecret,
  addSecretVersionIfExists,
} from "@octogee/core/secret-manager";
import {
  byosubSecretName,
  validateCodexCredential,
  validateClaudeCliCredential,
  validateClaudeCliToken,
  coachAgentId,
  byosubConnectionView,
  isSafeGatewayId,
  type ByosubProvider,
} from "../lib/byosub.js";
import { resolveUserGateway } from "../lib/user-gateway.js";
import {
  claudeCliNativeCredentialsPath,
  codexAgentDir,
  codexAuthJsonPath,
  isSafeAgentId,
} from "@octogee/core/byosub-restore";
import {
  deleteAuthProfileStore,
  readAuthProfileStore,
  writeAuthProfileStore,
} from "@octogee/core/auth-profile-sqlite";
import {
  CLAUDE_CLI_DEFAULT_PROFILE_ID,
  OPENAI_CODEX_DEFAULT_PROFILE_ID,
} from "@octogee/core/model-credential-materializer";
import { triggerGatewayModelCredentialSync } from "../lib/byot-sync-trigger.js";
import { logger } from "../middleware/logging.js";
import {
  modelCredentialOAuthState,
  modelCredentialOAuthEntryByProviderId,
  modelCredentialOAuthEntryBySubscriptionProvider,
  resolveUserByosubCredentialRefs,
  type ModelCredentialOAuthCatalogEntry,
  type ModelCredentialOAuthProviderId,
} from "@octogee/shared/types/model-credentials";

const router = Router();
const BYOSUB_PROVIDER_ORDER: ByosubProvider[] = ["openai", "anthropic"];

function providerEntryFromSubscriptionProvider(provider: unknown): ModelCredentialOAuthCatalogEntry | null {
  return typeof provider === "string"
    ? modelCredentialOAuthEntryBySubscriptionProvider(provider)
    : null;
}

function providerSetFromUserIntegration(data: unknown): Record<string, unknown> | null {
  const providers = (data as { providers?: unknown } | null | undefined)?.providers;
  return providers && typeof providers === "object" ? (providers as Record<string, unknown>) : null;
}

function isConnectedProvider(
  providers: Record<string, unknown>,
  provider: ByosubProvider,
): boolean {
  const raw = providers[provider];
  if (!raw || typeof raw !== "object") return false;
  const ref = raw as Record<string, unknown>;
  return ref.provider === provider && ref.connected === true && ref.status === "connected";
}

function firstRemainingConnectedProvider(
  providers: Record<string, unknown> | null,
  removedProvider: ByosubProvider,
): {
  provider: ByosubProvider;
  entry: ModelCredentialOAuthCatalogEntry;
} | null {
  if (!providers) return null;
  for (const provider of BYOSUB_PROVIDER_ORDER) {
    if (provider === removedProvider) continue;
    if (!isConnectedProvider(providers, provider)) continue;
    const entry = modelCredentialOAuthEntryBySubscriptionProvider(provider);
    if (!entry) continue;
    return { provider, entry };
  }
  return null;
}

function userIntegrationConnectionView(data: unknown) {
  const providers = providerSetFromUserIntegration(data);
  if (!providers) return byosubConnectionView(undefined);
  const visible: Record<string, unknown> = {};
  for (const provider of BYOSUB_PROVIDER_ORDER) {
    const raw = providers[provider];
    if (!raw || typeof raw !== "object") continue;
    const ref = raw as Record<string, unknown>;
    if (ref.provider !== provider) continue;
    if (ref.status === "needs_reauth" || (ref.status === "connected" && ref.connected === true)) {
      visible[provider] = ref;
    }
  }
  return byosubConnectionView({ providers: visible });
}

interface FlowDoc {
  uid: string;
  gatewayId: string;
  agentId: string;
  provider: string;
  modelCredentialProvider?: string;
  consumedAt?: number;
  expireAt?: number;
}

async function readFlow(flowId: string): Promise<FlowDoc | null> {
  const snap = await db.collection("byosubFlows").doc(flowId).get();
  if (!snap.exists) return null;
  return (snap.data() || null) as FlowDoc | null;
}

function agentBelongsToUser(data: Record<string, unknown>, agentId: string): boolean {
  const provisioning =
    data.provisioning && typeof data.provisioning === "object"
      ? (data.provisioning as Record<string, unknown>)
      : null;
  const openclaw =
    provisioning?.openclaw && typeof provisioning.openclaw === "object"
      ? (provisioning.openclaw as Record<string, unknown>)
      : null;
  if (!openclaw) return false;
  if (openclaw.agentId === agentId) return true;
  if (Array.isArray(openclaw.agentIds) && openclaw.agentIds.includes(agentId)) return true;
  return typeof openclaw.slug === "string" && coachAgentId(openclaw.slug) === agentId;
}

async function findGatewayUserByAgentId(
  gatewayId: string,
  agentId: string,
): Promise<{ uid: string; data: Record<string, unknown> } | null> {
  const snap = await db
    .collection("users")
    .where("provisioning.openclaw.gatewayId", "==", gatewayId)
    .get();
  for (const doc of snap.docs) {
    const data = doc.data() as Record<string, unknown> | undefined;
    if (data && agentBelongsToUser(data, agentId)) return { uid: doc.id, data };
  }
  return null;
}

function requestGatewayMatchesBinding(req: Request, gatewayId: string): boolean {
  const bound = (req as Request & { boundTenant?: { kind?: unknown; gatewayId?: unknown } }).boundTenant;
  return bound?.kind === "gateway" && bound.gatewayId === gatewayId;
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

router.get(
  "/connection",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const resolved = await resolveUserGateway(req.uid!);
      if (!resolved) {
        res.json({ connected: false, providers: {} });
        return;
      }
      const snap = await db
        .collection("users")
        .doc(req.uid!)
        .collection("integrations")
        .doc("byosub")
        .get();

      // gatewayId lets the client target the sidecar locality seam
      // (/api/g/<gatewayId>/byosub/*) for the connect/status/submit flow.
      res.json({ ...userIntegrationConnectionView(snap.data()), gatewayId: resolved.gatewayId });
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
    ...(user.subscription ? { subscription: user.subscription } : {}),
    ...(user.trialStartedAt !== undefined ? { trialStartedAt: user.trialStartedAt } : {}),
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

async function writeByosubIntegration(args: {
  uid: string;
  provider: ByosubProvider;
  modelCredentialProvider: ModelCredentialOAuthProviderId;
  status: string;
  connected: boolean;
  summaryConnected?: boolean;
  gatewayId?: string;
  flowId?: string;
  reason?: string;
}): Promise<void> {
  const providerLeaf = {
    provider: args.provider,
    modelCredentialProvider: args.modelCredentialProvider,
    status: args.status,
    connected: args.connected,
    ...(args.gatewayId ? { gatewayId: args.gatewayId } : { gatewayId: FieldValue.delete() }),
    ...(args.flowId ? { flowId: args.flowId } : { flowId: FieldValue.delete() }),
    ...(args.reason ? { reason: args.reason } : { reason: FieldValue.delete() }),
  };
  await db
    .collection("users")
    .doc(args.uid)
    .collection("integrations")
    .doc("byosub")
    .set(
      {
        connected: args.summaryConnected ?? args.connected,
        ...(args.gatewayId ? { gatewayId: args.gatewayId } : {}),
        providers: { [args.provider]: providerLeaf },
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
}

interface ResolvedUserGateway {
  gatewayId: string;
  slug: string;
}

interface RemainingByosubProvider {
  provider: ByosubProvider;
  entry: ModelCredentialOAuthCatalogEntry;
}

async function disconnectProviderFromUserIntegration(
  uid: string,
  provider: ByosubProvider,
): Promise<{ clearUserSignal: boolean; remainingProvider: RemainingByosubProvider | null }> {
  const snap = await db
    .collection("users")
    .doc(uid)
    .collection("integrations")
    .doc("byosub")
    .get();
  const remaining = firstRemainingConnectedProvider(providerSetFromUserIntegration(snap.data()), provider);
  return {
    clearUserSignal: !remaining,
    remainingProvider: remaining ? { provider: remaining.provider, entry: remaining.entry } : null,
  };
}

async function clearUserByosubSignal(uid: string): Promise<void> {
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
}

async function applyRemainingByosubSignal(
  uid: string,
  resolved: ResolvedUserGateway,
  remainingProvider: RemainingByosubProvider,
): Promise<void> {
  await flipUnifiedByosSignal(
    uid,
    remainingProvider.entry.id,
    byosubSecretName(uid, remainingProvider.provider),
  );
  triggerUnifiedByosSync({
    gatewayId: resolved.gatewayId,
    slug: resolved.slug,
    provider: remainingProvider.entry.id,
  });
}

function localOpenclawDir(): string {
  return process.env.OPENCLAW_DIR || "/home/node/.openclaw";
}

function removeAuthProfile(agentDir: string, profileId: string): void {
  const store = readAuthProfileStore(agentDir);
  const profiles = (store as { profiles?: unknown } | null)?.profiles;
  if (!profiles || typeof profiles !== "object" || Array.isArray(profiles)) return;
  if (!Object.prototype.hasOwnProperty.call(profiles, profileId)) return;
  const nextProfiles = { ...(profiles as Record<string, unknown>) };
  delete nextProfiles[profileId];
  if (Object.keys(nextProfiles).length === 0) {
    deleteAuthProfileStore(agentDir);
    return;
  }
  writeAuthProfileStore(agentDir, { ...(store as Record<string, unknown>), profiles: nextProfiles });
}

function cleanupGeneratedByosubCredentials(provider: ByosubProvider, agentId: string): void {
  const ocDir = localOpenclawDir();
  const agentDir = codexAgentDir(ocDir, agentId);
  if (provider === "openai") {
    fs.rmSync(codexAuthJsonPath(ocDir, agentId), { force: true });
    removeAuthProfile(agentDir, OPENAI_CODEX_DEFAULT_PROFILE_ID);
    return;
  }
  removeAuthProfile(agentDir, CLAUDE_CLI_DEFAULT_PROFILE_ID);
  fs.rmSync(claudeCliNativeCredentialsPath(os.homedir()), { force: true });
}

function cleanupGeneratedByosubCredentialsBestEffort(
  provider: ByosubProvider,
  agentId: string,
): void {
  try {
    cleanupGeneratedByosubCredentials(provider, agentId);
  } catch (err) {
    logger.warn(
      `[byosub] generated credential cleanup failed provider=${provider} agentId=${agentId}: ${(err as Error).message}`,
    );
  }
}

// #1141 — let the Builder clear a connected BYOS credential. The inverse
// of /capture's unified-signal flip + user integration write. The
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
      const b = (req.body || {}) as { provider?: unknown };
      const entry = providerEntryFromSubscriptionProvider(b.provider);
      if (!entry) {
        res.status(400).json({ error: "supported provider required" });
        return;
      }
      const provider = entry.oauth.secretProvider as ByosubProvider;
      const resolved = await resolveUserGateway(uid);
      const { clearUserSignal, remainingProvider } = await disconnectProviderFromUserIntegration(uid, provider);
      if (resolved) {
        cleanupGeneratedByosubCredentialsBestEffort(provider, coachAgentId(resolved.slug));
      }
      if (resolved && clearUserSignal) triggerUnifiedByosOffSync(req, resolved);

      if (clearUserSignal) {
        await clearUserByosubSignal(uid);
      } else if (remainingProvider && resolved) {
        await applyRemainingByosubSignal(uid, resolved, remainingProvider);
      }
      await writeByosubIntegration({
        uid,
        provider,
        modelCredentialProvider: entry.id,
        status: "disconnected",
        connected: false,
        summaryConnected: !clearUserSignal,
        ...(resolved ? { gatewayId: resolved.gatewayId } : {}),
      });

      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  },
);

// Claude SUBSCRIPTION capture — paste-token, no device-auth ceremony. The Builder
// runs `claude setup-token` themselves and pastes the bearer here; we validate,
// store it owner-scoped in Secret Manager, write the user integration, and flip the
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
      const secretName = byosubSecretName(uid, entry.oauth.secretProvider);
      await writeSecret({
        name: secretName,
        value: b.token.trim(),
        labels: { byosub: "true", provider: entry.oauth.secretProvider },
      });
      await flipUnifiedByosSignal(uid, entry.id, secretName);
      await writeByosubIntegration({
        uid,
        provider: entry.oauth.subscriptionProvider,
        modelCredentialProvider: entry.id,
        status: "connected",
        connected: true,
        gatewayId: resolved.gatewayId,
      });
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
        await writeByosubIntegration({
          uid: flow.uid,
          provider: secretProvider,
          modelCredentialProvider: signalProvider,
          status: "connected",
          connected: true,
          gatewayId: flow.gatewayId,
          flowId: b.flowId,
        });
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
      await flipUnifiedByosSignal(flow.uid, signalProvider, secretName);
      await writeByosubIntegration({
        uid: flow.uid,
        provider: secretProvider,
        modelCredentialProvider: signalProvider,
        status: "connected",
        connected: true,
        gatewayId: flow.gatewayId,
        flowId: b.flowId,
      });
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
        provider?: string;
        state?: string;
      };
      const entry = providerEntryFromSubscriptionProvider(b.provider);
      if (
        !isSafeGatewayId(b.gatewayId) ||
        !b.agentId ||
        !isSafeAgentId(b.agentId) ||
        !entry ||
        b.state !== "needs_reauth"
      ) {
        res.status(400).json({
          error:
            "path-safe gatewayId, path-safe agentId, supported provider, state:'needs_reauth' required",
        });
        return;
      }
      if (!requestGatewayMatchesBinding(req, b.gatewayId)) {
        res.status(403).json({ error: "forbidden" });
        return;
      }
      const provider = entry.oauth.secretProvider as ByosubProvider;
      const assigned = await findGatewayUserByAgentId(b.gatewayId, b.agentId);
      if (!assigned) {
        res.json({ ok: true, noop: true });
        return;
      }
      const integrationSnap = await db
        .collection("users")
        .doc(assigned.uid)
        .collection("integrations")
        .doc("byosub")
        .get();
      const providers = providerSetFromUserIntegration(integrationSnap.data());
      if (!providers || !isConnectedProvider(providers, provider)) {
        res.json({ ok: true, noop: true });
        return;
      }
      const updatedProviders = {
        ...providers,
        [provider]: { ...(providers[provider] as Record<string, unknown>), status: "needs_reauth", connected: false },
      };
      await writeByosubIntegration({
        uid: assigned.uid,
        provider,
        modelCredentialProvider: entry.id,
        status: "needs_reauth",
        connected: false,
        summaryConnected: userIntegrationConnectionView({ providers: updatedProviders }).connected,
        gatewayId: b.gatewayId,
      });
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
        provider?: string;
        credential?: string;
      };
      if (
        !isSafeGatewayId(b.gatewayId) ||
        !b.agentId ||
        !isSafeAgentId(b.agentId) ||
        b.provider !== "openai" ||
        typeof b.credential !== "string"
      ) {
        res.status(400).json({
          error:
            "path-safe gatewayId, path-safe agentId, provider:'openai', credential string required",
        });
        return;
      }
      const v = validateCodexCredential(b.credential);
      if (!v.ok) {
        res.status(400).json({ error: `invalid credential: ${v.reason}` });
        return;
      }
      if (!requestGatewayMatchesBinding(req, b.gatewayId)) {
        res.status(403).json({ error: "forbidden" });
        return;
      }
      const assigned = await findGatewayUserByAgentId(b.gatewayId, b.agentId);
      if (!assigned) {
        res.json({ ok: true, noop: true });
        return;
      }
      const integrationSnap = await db
        .collection("users")
        .doc(assigned.uid)
        .collection("integrations")
        .doc("byosub")
        .get();
      const ref = resolveUserByosubCredentialRefs(assigned.uid, integrationSnap.data()).refs.find(
        (candidate) => candidate.provider === "openai",
      );
      if (!ref) {
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
