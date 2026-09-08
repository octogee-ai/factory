import { Router, type Request, type Response } from "express";
import type { Firestore } from "firebase-admin/firestore";
import {
  MODEL_CREDENTIAL_STATIC_PROVIDER_IDS,
  modelCredentialOAuthEntryBySubscriptionProvider,
  resolveUserByosubCredentialRefs,
} from "@octogee/shared/types/model-credentials";
import { accountAllowsInteractiveAccess } from "@octogee/shared/types/account-lifecycle";
import { parseAgentId } from "@octogee/shared/types/identity";

import { readSecret } from "@octogee/core/secret-manager";
import { isSafeAgentId } from "@octogee/core/byosub-restore";
import { readAssignedSlugsForGateway } from "@octogee/core/assigned-roster";
import { readGatewayAuthorization } from "@octogee/core/gateway-live-release";
import {
  resolveBillingProfile,
  spendDegradeState,
  spendWindowPercentUsed,
  type BillingProfile,
} from "@octogee/shared/types/billing";
import {
  MODEL_BROKER_CREDITS_COLLECTION,
  MODEL_BROKER_USAGE_WINDOW_MS,
  MODEL_BROKER_USAGE_WINDOWS_COLLECTION,
  MODEL_BROKER_WEEK_WINDOW_MS,
  MODEL_BROKER_WEEK_WINDOWS_COLLECTION,
  modelBrokerWindowDocId,
  usageWindowStartMs,
  weekWindowStartMs,
} from "@octogee/shared/types/model-broker-usage";
import { createFirestoreModelBrokerTokenStore } from "../lib/model-broker-tokens.js";
import type {
  ModelBrokerProvider,
  ModelBrokerTokenPurpose,
} from "../lib/model-broker-tokens.js";
import {
  envDefaultModelBrokerLimits,
  resolveOwnerModelBrokerGrant,
} from "../lib/model-broker-limits.js";
import {
  agentModelTokenIssueKey,
  createAgentModelTokenIssueCoordinator,
} from "../lib/agent-model-token-issue-coordinator.js";
import { findRunningOutboundMigrationUserByAgentId } from "../lib/agent-model-token-migration-admission.js";
import {
  configuredBuilderSlugCredentialBootstrapAllowed,
  findAssignedOrInboundMigratingOrConfiguredUserByAgentId,
  findAssignedUserByAgentId,
} from "./fleet-broker.js";
import {
  createOwnerWorkspaceTurnVerifier,
  type OwnerWorkspaceTurnVerifier,
} from "../lib/openclaw-owner-turn.js";
import { logger } from "../../../gateway-edge/src/middleware/logging.js";

type GatewayBinding = Extract<
  Express.Request["boundTenant"],
  { kind: "gateway" }
>;

const FORBIDDEN = { error: "forbidden" } as const;
const VALID_AGENT_ID_REQUIRED = { error: "valid agentId required" } as const;
const UNSUPPORTED_PROVIDER = { error: "unsupported provider" } as const;
const UNSUPPORTED_PURPOSE = { error: "unsupported token purpose" } as const;
export const BYOK_API_KEY_PROVIDER_IDS = [
  ...MODEL_CREDENTIAL_STATIC_PROVIDER_IDS,
];
const BYOK_API_KEY_RE =
  /^byok-(?<body>[a-z0-9][a-z0-9-]{0,128})(?:\/(?<version>[a-zA-Z0-9-]{1,32}))?$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const BYOK_API_KEY_PROVIDER_SUFFIXES = BYOK_API_KEY_PROVIDER_IDS.map(
  (provider) => ({ provider, suffix: `-${provider}` }),
).sort((a, b) => b.suffix.length - a.suffix.length);

function parseByokApiKeyId(
  id: string,
): { slug: string; provider: string; version?: string } | null {
  const m = id.match(BYOK_API_KEY_RE);
  const body = m?.groups?.body;
  if (!body) return null;
  const match = BYOK_API_KEY_PROVIDER_SUFFIXES.find(({ suffix }) =>
    body.endsWith(suffix),
  );
  if (!match) return null;
  const slug = body.slice(0, -match.suffix.length);
  if (!SLUG_RE.test(slug)) return null;
  return {
    slug,
    provider: match.provider,
    ...(m.groups?.version ? { version: m.groups.version } : {}),
  };
}

// Per-customer broker tokens are re-minted whenever the resolver re-resolves the
// keyRef; a generous TTL spans a normal agent session (so it is not re-minted
// mid-session) while still bounding how long stale tokens linger before TTL cleanup.
const AGENT_MODEL_TOKEN_TTL_SECONDS = 24 * 60 * 60;
const AGENT_EMBEDDING_REQUESTS_PER_MINUTE = 60;

// Mirrors gateway-edge/src/routes/byosub.ts: a byosub OAuth flow is short-lived.
const BYOSUB_FLOW_TTL_MS = 60 * 60 * 1000;
// flowId is a crypto.randomUUID() minted in-pod (claude-sso/device-auth managers);
// pin a path-safe shape so it cannot steer the byosubFlows doc id elsewhere.
const SAFE_FLOW_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

function boundGateway(req: Request, res: Response): GatewayBinding | null {
  const bound = req.boundTenant;
  if (!bound || bound.kind !== "gateway") {
    res.status(403).json(FORBIDDEN);
    return null;
  }
  const claimed = (req.body as { gatewayId?: unknown } | undefined)?.gatewayId;
  if (
    typeof claimed === "string" &&
    claimed.length > 0 &&
    claimed !== bound.gatewayId
  ) {
    res.status(403).json(FORBIDDEN);
    return null;
  }
  return bound;
}

function warnSkippedUserByosubProviders(input: {
  gatewayId: string;
  agentId: string;
  uid: string;
  skipped: string[];
}): void {
  if (input.skipped.length === 0) return;
  console.warn("[byok-broker] skipped malformed user byosub provider", input);
}


function assignedOwnerSlug(data: Record<string, unknown>): string | null {
  const provisioning =
    data.provisioning &&
    typeof data.provisioning === "object" &&
    !Array.isArray(data.provisioning)
      ? (data.provisioning as Record<string, unknown>)
      : {};
  const openclaw =
    provisioning.openclaw &&
    typeof provisioning.openclaw === "object" &&
    !Array.isArray(provisioning.openclaw)
      ? (provisioning.openclaw as Record<string, unknown>)
      : {};
  const slug = openclaw.slug ?? data.username;
  return typeof slug === "string" && SLUG_RE.test(slug) ? slug : null;
}

function assignedGatewayId(data: Record<string, unknown>): string | null {
  const provisioning =
    data.provisioning &&
    typeof data.provisioning === "object" &&
    !Array.isArray(data.provisioning)
      ? (data.provisioning as Record<string, unknown>)
      : {};
  const openclaw =
    provisioning.openclaw &&
    typeof provisioning.openclaw === "object" &&
    !Array.isArray(provisioning.openclaw)
      ? (provisioning.openclaw as Record<string, unknown>)
      : {};
  return stringOrNull(openclaw.gatewayId);
}

function requestedModelProvider(value: unknown): ModelBrokerProvider | null {
  if (value === undefined || value === null || value === "") return "anthropic";
  return value === "anthropic" || value === "openrouter" || value === "openai"
    ? value
    : null;
}

function requestedTokenPurpose(value: unknown): ModelBrokerTokenPurpose | null {
  if (value === undefined || value === null || value === "") return "model";
  return value === "model" || value === "embeddings" ? value : null;
}

function financeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export type AgentCredentialPath =
  "platform_broker" | "byok_api_key" | "byosub" | "byosub_suppressed_customer";

function credentialPathFor(
  configData: Record<string, unknown>,
  gatewayClass: string,
): { path: AgentCredentialPath; provider: string | null } {
  const credential =
    configData.modelCredential && typeof configData.modelCredential === "object"
      ? (configData.modelCredential as Record<string, unknown>)
      : null;
  if (credential?.active !== true) return { path: "platform_broker", provider: null };
  const provider = stringOrNull(credential.provider);
  if (credential.mode !== "oauth") return { path: "byok_api_key", provider };
  return gatewayClass === "builder"
    ? { path: "byosub", provider }
    : { path: "byosub_suppressed_customer", provider };
}

function deriveSpendStatus(input: {
  plan: BillingProfile;
  credentialPath: string;
  windowData: Record<string, unknown> | undefined;
  weekData: Record<string, unknown> | undefined;
  creditData: Record<string, unknown> | undefined;
}) {
  const { plan } = input;
  const windowCostUsd = financeNumber(
    input.windowData?.chargeUsd ?? input.windowData?.costUsd,
  );
  const weekCostUsd = financeNumber(
    input.weekData?.chargeUsd ?? input.weekData?.costUsd,
  );
  const onOwnerCredential =
    input.credentialPath === "byok_api_key" || input.credentialPath === "byosub";
  const creditBalanceUsd = financeNumber(input.creditData?.balanceUsd);
  const throttle = spendDegradeState({
    modelAccess: plan.modelAccess,
    windowCostUsd,
    windowBudgetUsd: plan.windowBudgetUsd,
    weekCostUsd,
    weekBudgetUsd: plan.weeklyBudgetUsd,
    onOwnerCredential,
    houseFallback: plan.houseFallback,
    creditBalanceUsd,
  });
  const subscriptionUsingCredits =
    plan.rail === "subscription" &&
    !plan.houseFallback &&
    !onOwnerCredential &&
    (weekCostUsd >= plan.weeklyBudgetUsd || windowCostUsd >= plan.windowBudgetUsd);
  return {
    windowCostUsd,
    weekCostUsd,
    onOwnerCredential,
    creditBalanceUsd,
    throttle,
    subscriptionUsingCredits,
  };
}

async function agentUsageStatusPayload(
  db: Firestore,
  gatewayId: string,
  assigned: { uid: string; data: Record<string, unknown> },
  nowMs: number,
): Promise<Record<string, unknown>> {
  const windowStartMs = usageWindowStartMs(nowMs);
  const weekStartMs = weekWindowStartMs(nowMs);
  const [authorization, configSnap, windowSnap, weekSnap, creditSnap] =
    await Promise.all([
      readGatewayAuthorization(db, gatewayId),
      db
        .collection("users")
        .doc(assigned.uid)
        .collection("system")
        .doc("config")
        .get(),
      db
        .collection(MODEL_BROKER_USAGE_WINDOWS_COLLECTION)
        .doc(modelBrokerWindowDocId(assigned.uid, windowStartMs))
        .get(),
      db
        .collection(MODEL_BROKER_WEEK_WINDOWS_COLLECTION)
        .doc(modelBrokerWindowDocId(assigned.uid, weekStartMs))
        .get(),
      db.collection(MODEL_BROKER_CREDITS_COLLECTION).doc(assigned.uid).get(),
    ]);

  const userData = assigned.data;
  const plan = resolveBillingProfile(userData, new Date(nowMs));
  if (!authorization) {
    throw new Error(
      `durable root config unavailable for gateways/${gatewayId}`,
    );
  }
  const credential = credentialPathFor(
    (configSnap.data() ?? {}) as Record<string, unknown>,
    authorization.config.gatewayClass,
  );
  const spend = deriveSpendStatus({
    plan,
    credentialPath: credential.path,
    windowData: windowSnap.data(),
    weekData: weekSnap.data(),
    creditData: creditSnap.data(),
  });

  return {
    gatewayClass: authorization.config.gatewayClass,
    tier: plan.tier,
    effectiveTier: plan.effectiveTier,
    trialDaysRemaining: plan.trialDaysRemaining,
    week: {
      percentUsed: spend.onOwnerCredential
        ? 0
        : spendWindowPercentUsed(spend.weekCostUsd, plan.weeklyBudgetUsd),
      resetAt: new Date(
        weekStartMs + MODEL_BROKER_WEEK_WINDOW_MS,
      ).toISOString(),
    },
    window: {
      percentUsed: spend.onOwnerCredential
        ? 0
        : spendWindowPercentUsed(spend.windowCostUsd, plan.windowBudgetUsd),
      nextRefillAt: new Date(
        windowStartMs + MODEL_BROKER_USAGE_WINDOW_MS,
      ).toISOString(),
      degraded: spend.throttle.degraded,
      blocked: spend.throttle.blocked,
      reason: spend.throttle.reason,
    },
    credits:
      plan.rail === "prepaid_credits" || spend.subscriptionUsingCredits
        ? { balanceUsd: spend.creditBalanceUsd }
        : null,
    credential,
  };
}

function agentModelTokenSecretName(input: {
  gatewayId: string;
  ownerUid: string;
  provider: ModelBrokerProvider;
  purpose: ModelBrokerTokenPurpose;
}): string {
  if (input.purpose === "embeddings") {
    return `agent-embedding-token-openai-${input.gatewayId}-${input.ownerUid}`;
  }
  const prefix =
    input.provider === "anthropic"
      ? "agent-model-token"
      : `agent-model-token-${input.provider}`;
  return `${prefix}-${input.gatewayId}-${input.ownerUid}`;
}

async function handleApiKeyCredential(
  db: Firestore,
  readCredentialSecret: (name: string, version?: string) => Promise<string>,
  req: Request,
  res: Response,
): Promise<void> {
  const bound = boundGateway(req, res);
  if (!bound) return;

  const id = (req.body as { id?: unknown } | undefined)?.id;
  if (typeof id !== "string") {
    res.status(400).json({ error: "valid id required" });
    return;
  }
  const parsed = parseByokApiKeyId(id);
  if (!parsed) {
    res.status(400).json({ error: "malformed byok id" });
    return;
  }
  const { slug, provider, version } = parsed;
  const roster = await readAssignedSlugsForGateway(db, bound.gatewayId);
  if (
    !roster.includes(slug) &&
    !(await configuredBuilderSlugCredentialBootstrapAllowed(
      db,
      bound.gatewayId,
      bound.podName,
      slug,
    ))
  ) {
    res.status(403).json(FORBIDDEN);
    return;
  }

  const value = await readCredentialSecret(
    `byok-${slug}-${provider}`,
    version ?? "latest",
  );
  res.json({ value });
}

async function handleByosubCred(input: {
  db: Firestore;
  readCredentialSecret: (name: string, version?: string) => Promise<string>;
  gatewayId: string;
  podName: string | undefined;
  agentId: string;
  res: Response;
}): Promise<void> {
  const { db, readCredentialSecret, gatewayId, podName, agentId, res } = input;
  const authorization = await readGatewayAuthorization(db, gatewayId);
  if (authorization?.config.gatewayClass !== "builder") {
    res.status(403).json(FORBIDDEN);
    return;
  }
  const assigned = await findAssignedOrInboundMigratingOrConfiguredUserByAgentId(
    db,
    gatewayId,
    podName,
    agentId,
  );
  if (!assigned) {
    res.status(403).json(FORBIDDEN);
    return;
  }
  const snap = await db.collection("users").doc(assigned.uid)
    .collection("integrations").doc("byosub").get();
  const parsed = resolveUserByosubCredentialRefs(assigned.uid, snap.data());
  if (parsed.refs.length === 0) {
    warnSkippedUserByosubProviders({ gatewayId, agentId, uid: assigned.uid, skipped: parsed.skipped });
    res.status(parsed.skipped.length > 0 ? 500 : 404).json({
      error: parsed.skipped.length > 0 ? "malformed user byosub integration" : "not_found",
    });
    return;
  }
  const credentials = [];
  for (const { provider, secretName } of parsed.refs) {
    credentials.push({ provider, secretName, credential: await readCredentialSecret(secretName) });
  }
  warnSkippedUserByosubProviders({ gatewayId, agentId, uid: assigned.uid, skipped: parsed.skipped });
  res.json({ credentials, ...(parsed.skipped.length > 0 ? { skipped: parsed.skipped } : {}) });
}

function registerCredentialMaterializationRoutes(
  router: Router,
  db: Firestore,
  readCredentialSecret: (name: string, version?: string) => Promise<string>,
) {
  router.post("/byosub-cred", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const agentId = (req.body as { agentId?: unknown } | undefined)?.agentId;
    if (typeof agentId !== "string" || !isSafeAgentId(agentId)) {
      res.status(400).json(VALID_AGENT_ID_REQUIRED);
      return;
    }
    await handleByosubCred({
      db,
      readCredentialSecret,
      gatewayId: bound.gatewayId,
      podName: bound.podName,
      agentId,
      res,
    });
  });
  router.post("/api-key", async (req, res) => {
    await handleApiKeyCredential(db, readCredentialSecret, req, res);
  });
}

function registerAgentUsageStatusRoute(
  router: Router,
  db: Firestore,
  now: () => number,
  verifyOwnerWorkspaceTurn: OwnerWorkspaceTurnVerifier,
) {
  router.post("/agent-usage-status", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const agentId = (req.body as { agentId?: unknown } | undefined)?.agentId;
    if (typeof agentId !== "string" || !isSafeAgentId(agentId)) {
      res.status(400).json(VALID_AGENT_ID_REQUIRED);
      return;
    }
    if (parseAgentId(agentId).kind !== "coach") {
      res.status(403).json(FORBIDDEN);
      return;
    }
    const assigned =
      await findAssignedOrInboundMigratingOrConfiguredUserByAgentId(
        db,
        bound.gatewayId,
        bound.podName,
        agentId,
      );
    if (!assigned) {
      res.status(403).json(FORBIDDEN);
      return;
    }
    try {
      if (!(await verifyOwnerWorkspaceTurn({
        req,
        gatewayId: bound.gatewayId,
        agentId,
        ownerUid: assigned.uid,
        assignedData: assigned.data as Record<string, unknown>,
      }))) {
        logger.warn("[byok-broker] rejected unverified owner status turn", {
          gatewayId: bound.gatewayId,
          agentId,
        });
        res.status(403).json(FORBIDDEN);
        return;
      }
    } catch (error) {
      logger.error("[byok-broker] owner status turn verification failed", {
        gatewayId: bound.gatewayId,
        agentId,
        error,
      });
      res.status(403).json(FORBIDDEN);
      return;
    }
    res.json(
      await agentUsageStatusPayload(
        db,
        bound.gatewayId,
        { uid: assigned.uid, data: assigned.data as Record<string, unknown> },
        now(),
      ),
    );
  });
}

function registerByosubUserRoute(router: Router, db: Firestore): void {
  router.post("/byosub-user", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const uid = (req.body as { uid?: unknown } | undefined)?.uid;
    if (typeof uid !== "string" || uid.length === 0 || uid.length > 128) {
      res.status(400).json({ error: "valid uid required" });
      return;
    }
    const user = await db.collection("users").doc(uid).get();
    const data = user.data() as Record<string, unknown> | undefined;
    const slug = data ? assignedOwnerSlug(data) : null;
    if (
      !data ||
      !accountAllowsInteractiveAccess(data) ||
      !slug ||
      assignedGatewayId(data) !== bound.gatewayId
    ) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const integration = await db
      .collection("users")
      .doc(uid)
      .collection("integrations")
      .doc("byosub")
      .get();
    const refs = resolveUserByosubCredentialRefs(uid, integration.data()).refs;
    let refProvider: "openai" | "anthropic" | null = null;
    if (refs.some((ref) => ref.provider === "openai")) refProvider = "openai";
    else if (refs.some((ref) => ref.provider === "anthropic")) refProvider = "anthropic";
    res.json({ user: { uid, slug, gatewayId: bound.gatewayId, refProvider } });
  });
}

class AgentModelTokenForbiddenError extends Error {}

function registerAgentModelTokenRoute(
  router: Router,
  db: Firestore,
  now: () => number,
): void {
  const coordinator = createAgentModelTokenIssueCoordinator({ now });
  const tokenStore = createFirestoreModelBrokerTokenStore(db);
  router.post("/agent-model-token", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;

    const agentId = (req.body as { agentId?: unknown } | undefined)?.agentId;
    if (typeof agentId !== "string" || !isSafeAgentId(agentId)) {
      res.status(400).json(VALID_AGENT_ID_REQUIRED);
      return;
    }
    const provider = requestedModelProvider(
      (req.body as { provider?: unknown } | undefined)?.provider,
    );
    if (!provider) {
      res.status(400).json(UNSUPPORTED_PROVIDER);
      return;
    }
    const purpose = requestedTokenPurpose(
      (req.body as { purpose?: unknown } | undefined)?.purpose,
    );
    if (!purpose || (purpose === "embeddings" && provider !== "openai")) {
      res.status(400).json(UNSUPPORTED_PURPOSE);
      return;
    }

    const issueKey = agentModelTokenIssueKey({
      gatewayId: bound.gatewayId,
      podName: bound.podName,
      agentId,
      provider,
      purpose,
    });
    try {
      const response = await coordinator.issue(issueKey, async () => {
        const assigned =
          (await findAssignedOrInboundMigratingOrConfiguredUserByAgentId(
            db,
            bound.gatewayId,
            bound.podName,
            agentId,
          )) ??
          (await findRunningOutboundMigrationUserByAgentId(
            db,
            bound.gatewayId,
            agentId,
          ));
        if (!assigned || !accountAllowsInteractiveAccess(assigned.data)) {
          throw new AgentModelTokenForbiddenError();
        }
        const grant =
          purpose === "embeddings"
            ? {
                limits: {
                  spendWindowUsd: null,
                  spendWeekUsd: null,
                  requestsPerMinute: AGENT_EMBEDDING_REQUESTS_PER_MINUTE,
                },
                policy: { freeTier: false, houseFallback: true },
              }
            : await resolveOwnerModelBrokerGrant({
                db,
                gatewayId: bound.gatewayId,
                ownerUid: assigned.uid,
                now: now(),
                defaults: envDefaultModelBrokerLimits(),
              });
        const issued = await tokenStore.issueToken({
          gatewayId: bound.gatewayId,
          ownerUid: assigned.uid,
          provider,
          purpose,
          secretName: agentModelTokenSecretName({
            gatewayId: bound.gatewayId,
            ownerUid: assigned.uid,
            provider,
            purpose,
          }),
          skipPointer: true,
          ttlSeconds: AGENT_MODEL_TOKEN_TTL_SECONDS,
          now: now(),
          limits: grant.limits,
          policy: grant.policy,
          trace: {
            source: "shared_agent_model_token",
            ownerSlug: assignedOwnerSlug(assigned.data),
            agentId,
          },
        });
        if (typeof issued.record.expiresAt !== "number") {
          throw new Error("agent model token was issued without an expiry");
        }
        return {
          value: issued.token,
          expiresAt: issued.record.expiresAt,
          provider,
          purpose,
        };
      });
      res.json(response);
    } catch (error) {
      if (error instanceof AgentModelTokenForbiddenError) {
        res.status(403).json(FORBIDDEN);
        return;
      }
      throw error;
    }
  });
}

export function createByokBrokerRoutes(opts: {
  db: Firestore;
  now?: () => number;
  readSecret?: (name: string, version?: string) => Promise<string>;
  verifyOwnerWorkspaceTurn?: OwnerWorkspaceTurnVerifier;
}): Router {
  const router = Router();
  const { db } = opts;
  const now = opts.now ?? Date.now;
  const readCredentialSecret = opts.readSecret ?? readSecret;

  registerCredentialMaterializationRoutes(router, db, readCredentialSecret);
  registerAgentModelTokenRoute(router, db, now);

  registerAgentUsageStatusRoute(
    router,
    db,
    now,
    opts.verifyOwnerWorkspaceTurn ?? createOwnerWorkspaceTurnVerifier(db),
  );

  // Record a byosub OAuth flow's owner mapping for a customer-agent assigned to
  // this gateway. The sidecar /connect handler starts the in-pod auth flow
  // locally (its OPENCLAW_GATEWAY_TOKEN matches the in-pod manager), then brokers
  // the flowId->owner mapping here because cattle pods have no Firestore. The
  // in-pod /capture callback later reads byosubFlows to persist the captured
  // credential. Roster-scoped via findAssignedUserByAgentId — a gateway can only
  // record flows for a customer assigned to it, and the owner uid is DERIVED from
  // the assignment, never trusted from the caller.
  router.post("/byosub-flow", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;

    const body = (req.body || {}) as {
      flowId?: unknown;
      agentId?: unknown;
      provider?: unknown;
    };
    if (typeof body.agentId !== "string" || !isSafeAgentId(body.agentId)) {
      res.status(400).json(VALID_AGENT_ID_REQUIRED);
      return;
    }
    if (typeof body.flowId !== "string" || !SAFE_FLOW_ID_RE.test(body.flowId)) {
      res.status(400).json({ error: "valid flowId required" });
      return;
    }
    const entry =
      typeof body.provider === "string"
        ? modelCredentialOAuthEntryBySubscriptionProvider(body.provider)
        : null;
    if (!entry) {
      res.status(400).json({
        error: `unsupported subscription provider: ${String(body.provider)}`,
      });
      return;
    }

    const assigned = await findAssignedUserByAgentId(
      db,
      bound.gatewayId,
      body.agentId,
    );
    if (!assigned || !accountAllowsInteractiveAccess(assigned.data)) {
      res.status(403).json(FORBIDDEN);
      return;
    }

    const now = Date.now();
    await Promise.all([
      db
        .collection("byosubFlows")
        .doc(body.flowId)
        .set({
          uid: assigned.uid,
          gatewayId: bound.gatewayId,
          agentId: body.agentId,
          provider: entry.oauth.subscriptionProvider,
          modelCredentialProvider: entry.id,
          createdAt: now,
          expireAt: now + BYOSUB_FLOW_TTL_MS,
        }),
      db
        .collection("users")
        .doc(assigned.uid)
        .collection("integrations")
        .doc("byosub")
        .set(
          {
            connected: false,
            gatewayId: bound.gatewayId,
            providers: {
              [entry.oauth.subscriptionProvider]: {
                provider: entry.oauth.subscriptionProvider,
                modelCredentialProvider: entry.id,
                status: "disconnected",
                connected: false,
                state: "pending",
                flowId: body.flowId,
                gatewayId: bound.gatewayId,
              },
            },
            updatedAt: now,
          },
          { merge: true },
        ),
    ]);
    res.json({ ok: true });
  });

  registerByosubUserRoute(router, db);

  router.post("/byosub-flow-read", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const flowId = (req.body as { flowId?: unknown } | undefined)?.flowId;
    if (typeof flowId !== "string" || !SAFE_FLOW_ID_RE.test(flowId)) {
      res.status(400).json({ error: "valid flowId required" });
      return;
    }
    const flow = await db.collection("byosubFlows").doc(flowId).get();
    if (!flow.exists) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const data = flow.data();
    if (
      !data ||
      data.gatewayId !== bound.gatewayId ||
      typeof data.uid !== "string" ||
      typeof data.agentId !== "string" ||
      typeof data.provider !== "string"
    ) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const user = await db.collection("users").doc(data.uid).get();
    if (!user.exists || !accountAllowsInteractiveAccess(user.data())) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({
      flow: {
        uid: data.uid,
        gatewayId: data.gatewayId,
        agentId: data.agentId,
        provider: data.provider,
        ...(typeof data.modelCredentialProvider === "string"
          ? { modelCredentialProvider: data.modelCredentialProvider }
          : {}),
      },
    });
  });

  return router;
}
