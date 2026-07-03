import { Router, type Request, type Response } from "express";
import type { Firestore } from "firebase-admin/firestore";
import {
  MODEL_CREDENTIAL_STATIC_PROVIDER_IDS,
  modelCredentialOAuthEntryBySubscriptionProvider,
} from "@octogee/shared/types/model-credentials";

import { readSecret } from "@octogee/core/secret-manager";
import { isSafeAgentId } from "@octogee/core/byosub-restore";
import { readAssignedSlugsForGateway } from "@octogee/core/assigned-roster";
import {
  FREE_DAILY_HOUSE_TOKENS,
  houseAllowanceState,
  resolveEffectivePlan,
  spendDegradeState,
  spendWindowPercentUsed,
} from "@octogee/shared/types/billing";
import {
  MODEL_BROKER_CREDITS_COLLECTION,
  MODEL_BROKER_HOUSE_DAY_WINDOWS_COLLECTION,
  MODEL_BROKER_USAGE_WINDOW_MS,
  MODEL_BROKER_USAGE_WINDOWS_COLLECTION,
  houseDayStartMs,
  modelBrokerWindowDocId,
  usageWindowStartMs,
} from "@octogee/shared/types/model-broker-usage";
import { createFirestoreModelBrokerTokenStore } from "../lib/model-broker-tokens.js";
import type { ModelBrokerProvider } from "../lib/model-broker-tokens.js";
import {
  envDefaultModelBrokerLimits,
  resolveOwnerModelBrokerGrant,
} from "../lib/model-broker-limits.js";
import {
  findAssignedOrInboundMigratingUserByAgentId,
  findAssignedUserByAgentId,
} from "./fleet-broker.js";

type GatewayBinding = Extract<Express.Request["boundTenant"], { kind: "gateway" }>;

const FORBIDDEN = { error: "forbidden" } as const;
// This broker materializes ONLY byosub OAuth credentials. A byosub secret id is
// `byosub-<uid>-<provider>` (gateway-edge/src/lib/byosub.ts byosubSecretName) —
// the raw mixed-case Firebase uid plus exactly the two OAuth-sub providers.
// Pinning that shape, and matching the stored provider suffix below, stops a
// corrupted glmGateways.byosub ref from steering readSecret onto an unrelated
// Secret Manager secret (e.g. gateway-auth-token-*) and leaking it to the pod.
const BYOSUB_SECRET_RE = /^byosub-[A-Za-z0-9_-]+-(?:openai|anthropic)$/;
export const BYOK_API_KEY_PROVIDER_IDS = [...MODEL_CREDENTIAL_STATIC_PROVIDER_IDS];
const BYOK_API_KEY_RE = /^byok-(?<body>[a-z0-9][a-z0-9-]{0,128})(?:\/(?<version>[a-zA-Z0-9-]{1,32}))?$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const BYOK_API_KEY_PROVIDER_SUFFIXES = BYOK_API_KEY_PROVIDER_IDS
  .map((provider) => ({ provider, suffix: `-${provider}` }))
  .sort((a, b) => b.suffix.length - a.suffix.length);

function parseByokApiKeyId(id: string): { slug: string; provider: string; version?: string } | null {
  const m = id.match(BYOK_API_KEY_RE);
  const body = m?.groups?.body;
  if (!body) return null;
  const match = BYOK_API_KEY_PROVIDER_SUFFIXES.find(({ suffix }) => body.endsWith(suffix));
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
  if (typeof claimed === "string" && claimed.length > 0 && claimed !== bound.gatewayId) {
    res.status(403).json(FORBIDDEN);
    return null;
  }
  return bound;
}

interface ByosubRef {
  providers?: unknown;
}

type ByosubProvider = "openai" | "anthropic";
const BYOSUB_PROVIDERS: ByosubProvider[] = ["openai", "anthropic"];
const BYOSUB_PROVIDER_SET = new Set<string>(BYOSUB_PROVIDERS);

function providerRefs(ref: ByosubRef | undefined): {
  malformed: boolean;
  refs: { provider: ByosubProvider; secretName: string }[];
  skipped: string[];
} {
  if (!ref) return { malformed: false, refs: [], skipped: [] };
  if (!ref.providers || typeof ref.providers !== "object") {
    return { malformed: true, refs: [], skipped: ["providers: malformed provider set"] };
  }
  const providers = ref.providers as Record<string, unknown>;
  const skipped: string[] = [];
  for (const provider of Object.keys(providers)) {
    if (!BYOSUB_PROVIDER_SET.has(provider)) skipped.push(`${provider}: unknown provider`);
  }
  const refs = BYOSUB_PROVIDERS.flatMap((provider) => {
    const raw = providers[provider];
    if (raw === undefined) return [];
    if (
      !raw ||
      typeof raw !== "object" ||
      (raw as { provider?: unknown }).provider !== provider ||
      typeof (raw as { secretName?: unknown }).secretName !== "string" ||
      !(raw as { secretName?: string }).secretName
    ) {
      skipped.push(`${provider}: malformed provider leaf`);
      return [];
    }
    return [{ provider, secretName: (raw as { secretName: string }).secretName }];
  });
  return { malformed: refs.length === 0 && skipped.length > 0, refs, skipped };
}

function warnSkippedByosubRefs(input: {
  gatewayId: string;
  agentId: string;
  skipped: string[];
}): void {
  if (input.skipped.length === 0) return;
  console.warn("[byok-broker] skipped malformed byosub provider ref", input);
}

function assignedOwnerSlug(data: Record<string, unknown>): string | null {
  const provisioning =
    data.provisioning && typeof data.provisioning === "object" && !Array.isArray(data.provisioning)
      ? data.provisioning as Record<string, unknown>
      : {};
  const openclaw =
    provisioning.openclaw && typeof provisioning.openclaw === "object" && !Array.isArray(provisioning.openclaw)
      ? provisioning.openclaw as Record<string, unknown>
      : {};
  const slug = openclaw.slug ?? data.username;
  return typeof slug === "string" && SLUG_RE.test(slug) ? slug : null;
}


function requestedModelProvider(value: unknown): ModelBrokerProvider | null {
  if (value === undefined || value === null || value === "") return "anthropic";
  return value === "anthropic" || value === "openrouter" ? value : null;
}

function financeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export type AgentCredentialPath =
  | "platform_broker"
  | "byok_api_key"
  | "byosub"
  | "byosub_suppressed_shared";

// Mirrors the Phase D gate (core byot-sync gateSharedByosub): an OAuth model
// credential is honored on builder/operator pods and suppressed on shared.
function credentialPathFor(
  userData: Record<string, unknown>,
  configData: Record<string, unknown>,
  gatewayClass: string,
): { path: AgentCredentialPath; provider: string | null } {
  const credential =
    configData.modelCredential && typeof configData.modelCredential === "object"
      ? (configData.modelCredential as Record<string, unknown>)
      : null;
  const legacyByot =
    userData.byotActive === true && configData.byot && typeof configData.byot === "object"
      ? (configData.byot as Record<string, unknown>)
      : null;
  const active = credential?.active === true ? credential : legacyByot;
  if (!active) return { path: "platform_broker", provider: null };
  const provider = stringOrNull(active.provider);
  // legacy byot records predate the mode field and were always API keys
  const isOauth = active !== legacyByot && active.mode === "oauth";
  if (!isOauth) return { path: "byok_api_key", provider };
  return gatewayClass === "shared"
    ? { path: "byosub_suppressed_shared", provider }
    : { path: "byosub", provider };
}

async function agentUsageStatusPayload(
  db: Firestore,
  gatewayId: string,
  assigned: { uid: string; data: Record<string, unknown> },
  nowMs: number,
): Promise<Record<string, unknown>> {
  const windowStartMs = usageWindowStartMs(nowMs);
  const [gatewaySnap, configSnap, windowSnap, houseDaySnap, creditSnap] = await Promise.all([
    db.collection("glmGateways").doc(gatewayId).get(),
    db.collection("users").doc(assigned.uid).collection("system").doc("config").get(),
    db
      .collection(MODEL_BROKER_USAGE_WINDOWS_COLLECTION)
      .doc(modelBrokerWindowDocId(assigned.uid, windowStartMs))
      .get(),
    db
      .collection(MODEL_BROKER_HOUSE_DAY_WINDOWS_COLLECTION)
      .doc(modelBrokerWindowDocId(assigned.uid, houseDayStartMs(nowMs)))
      .get(),
    db.collection(MODEL_BROKER_CREDITS_COLLECTION).doc(assigned.uid).get(),
  ]);

  const userData = assigned.data;
  const plan = resolveEffectivePlan(userData, new Date(nowMs));
  const gatewayClass = stringOrNull(gatewaySnap.data()?.gatewayClass) ?? "unknown";
  const credential = credentialPathFor(
    userData,
    (configSnap.data() ?? {}) as Record<string, unknown>,
    gatewayClass,
  );
  const windowCostUsd = financeNumber(windowSnap.data()?.costUsd);
  const houseDayTokens = financeNumber(houseDaySnap.data()?.totalTokens);
  const onOwnerCredential = credential.path === "byosub" || credential.path === "byok_api_key";
  const throttle = spendDegradeState({
    modelAccess: plan.modelAccess,
    windowCostUsd,
    windowBudgetUsd: plan.windowBudgetUsd,
    onOwnerCredential,
  });

  return {
    gatewayClass,
    tier: plan.tier,
    effectiveTier: plan.effectiveTier,
    trialDaysRemaining: plan.trialDaysRemaining,
    window: {
      percentUsed: onOwnerCredential
        ? 0
        : spendWindowPercentUsed(windowCostUsd, plan.windowBudgetUsd),
      nextRefillAt: new Date(windowStartMs + MODEL_BROKER_USAGE_WINDOW_MS).toISOString(),
      degraded: throttle.degraded,
      reason: throttle.reason,
    },
    houseAllowance: onOwnerCredential
      ? null
      : houseAllowanceState({
          usedTokens: houseDayTokens,
          limitTokens: FREE_DAILY_HOUSE_TOKENS,
        }),
    // Builders ride the prepaid rail — their platform-model gate is the balance.
    credits:
      plan.tier === "builder"
        ? { balanceUsd: financeNumber(creditSnap.data()?.balanceUsd) }
        : null,
    credential,
  };
}

function agentModelTokenSecretName(input: {
  gatewayId: string;
  ownerUid: string;
  provider: ModelBrokerProvider;
}): string {
  const prefix = input.provider === "openrouter"
    ? "agent-model-token-openrouter"
    : "agent-model-token";
  return `${prefix}-${input.gatewayId}-${input.ownerUid}`;
}

async function handleByosubCred(
  db: Firestore,
  gatewayId: string,
  agentId: string,
  res: Response,
): Promise<void> {
  const snap = await db.collection("glmGateways").doc(gatewayId).get();
  const byosub = (snap.data() as { byosub?: Record<string, ByosubRef> } | undefined)?.byosub;
  const ref = byosub?.[agentId];
  const parsed = providerRefs(ref);
  if (parsed.malformed) {
    warnSkippedByosubRefs({ gatewayId, agentId, skipped: parsed.skipped });
    res.status(500).json({ error: "malformed byosub ref" });
    return;
  }
  if (parsed.refs.length === 0) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const credentials = [];
  const skipped = [...parsed.skipped];
  for (const { provider, secretName } of parsed.refs) {
    if (!BYOSUB_SECRET_RE.test(secretName) || !secretName.endsWith(`-${provider}`)) {
      skipped.push(`${provider}: malformed secret ref`);
      continue;
    }
    credentials.push({ provider, secretName, credential: await readSecret(secretName) });
  }
  if (credentials.length === 0) {
    warnSkippedByosubRefs({ gatewayId, agentId, skipped });
    res.status(500).json({ error: skipped.length > 0 ? "malformed secret ref" : "not_found" });
    return;
  }
  warnSkippedByosubRefs({ gatewayId, agentId, skipped });

  res.json({ credentials, ...(skipped.length > 0 ? { skipped } : {}) });
}

export function createByokBrokerRoutes(opts: { db: Firestore; now?: () => number }): Router {
  const router = Router();
  const { db } = opts;
  const now = opts.now ?? Date.now;

  // Materialize a byosub OAuth credential (ChatGPT/codex or Claude/claude-cli)
  // for a gateway that cannot reach Secret Manager directly (cattle pods are
  // egress-blocked from the GCP metadata server). Scoped to
  // glmGateways/{gatewayId}.byosub: a gateway only gets credentials referenced
  // on its OWN doc — no cross-gateway or cross-tenant read. KSA-authed via the
  // tenant-binding middleware (boundTenant.kind === "gateway").
  router.post("/byosub-cred", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;

    const agentId = (req.body as { agentId?: unknown } | undefined)?.agentId;
    if (typeof agentId !== "string" || !isSafeAgentId(agentId)) {
      res.status(400).json({ error: "valid agentId required" });
      return;
    }

    await handleByosubCred(db, bound.gatewayId, agentId, res);
  });

  // Materialize a byok API-key credential (anthropic/openai key, Grok,
  // OpenRouter, MiniMax, …) for a cattle gateway that cannot reach Secret
  // Manager directly. scripts/secret-resolver.mjs calls this with the gateway's
  // projected KSA token. Roster-scoped: a gateway only materializes byok keys for
  // slugs in its OWN assigned roster (readAssignedSlugsForGateway) — no
  // cross-tenant read.
  router.post("/api-key", async (req, res) => {
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
    if (!roster.includes(slug)) {
      res.status(403).json(FORBIDDEN);
      return;
    }

    const value = await readSecret(`byok-${slug}-${provider}`, version ?? "latest");
    res.json({ value });
  });

  // Mint an owner-scoped broker token for one customer-agent on a shared
  // (multi-tenant) gateway. The agent resolves anthropic through the broker with
  // its OWN token, so the broker resolves per-owner (platform key, or the owner's
  // byok-<slug>-anthropic), meters per ownerUid, and enforces the owner's tier
  // spend cap (degrade to the house model when exhausted). Roster-scoped via
  // assigned roster, or a running inbound migration targeting this gateway.
  router.post("/agent-model-token", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;

    const agentId = (req.body as { agentId?: unknown } | undefined)?.agentId;
    if (typeof agentId !== "string" || !isSafeAgentId(agentId)) {
      res.status(400).json({ error: "valid agentId required" });
      return;
    }
    const provider = requestedModelProvider(
      (req.body as { provider?: unknown } | undefined)?.provider,
    );
    if (!provider) {
      res.status(400).json({ error: "unsupported provider" });
      return;
    }

    const assigned = await findAssignedOrInboundMigratingUserByAgentId(
      db,
      bound.gatewayId,
      agentId,
    );
    if (!assigned) {
      res.status(403).json(FORBIDDEN);
      return;
    }
    const grant = await resolveOwnerModelBrokerGrant({
      db,
      gatewayId: bound.gatewayId,
      ownerUid: assigned.uid,
      now: Date.now(),
      defaults: envDefaultModelBrokerLimits(),
    });
    const issued = await createFirestoreModelBrokerTokenStore(db).issueToken({
      gatewayId: bound.gatewayId,
      ownerUid: assigned.uid,
      provider,
      // a descriptive label, NOT a readable Secret Manager secret — the broker
      // resolves the provider key per ownerUid, never via this name.
      secretName: agentModelTokenSecretName({
        gatewayId: bound.gatewayId,
        ownerUid: assigned.uid,
        provider,
      }),
      // standalone + TTL-bounded: no revoke-on-reissue, so a re-mint can't yank a
      // still-in-flight token (the prior one expires by TTL instead).
      skipPointer: true,
      ttlSeconds: AGENT_MODEL_TOKEN_TTL_SECONDS,
      limits: grant.limits,
      policy: grant.policy,
      trace: {
        source: "shared_agent_model_token",
        ownerSlug: assignedOwnerSlug(assigned.data),
        agentId,
      },
    });
    res.json({ value: issued.token, provider });
  });

  // The `/status` capability's data source: an agent asks (via its projected
  // KSA token) for its OWNER's live billing/budget state. Roster-scoped like
  // /agent-model-token — a gateway can only ask about its own customers. This
  // is the operator's proof that class-gated credentials and budgets behave.
  router.post("/agent-usage-status", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;

    const agentId = (req.body as { agentId?: unknown } | undefined)?.agentId;
    if (typeof agentId !== "string" || !isSafeAgentId(agentId)) {
      res.status(400).json({ error: "valid agentId required" });
      return;
    }
    const assigned = await findAssignedOrInboundMigratingUserByAgentId(
      db,
      bound.gatewayId,
      agentId,
    );
    if (!assigned) {
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
      res.status(400).json({ error: "valid agentId required" });
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
      res.status(400).json({ error: `unsupported subscription provider: ${String(body.provider)}` });
      return;
    }

    const assigned = await findAssignedUserByAgentId(db, bound.gatewayId, body.agentId);
    if (!assigned) {
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
        .set({
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
        }, { merge: true }),
    ]);
    res.json({ ok: true });
  });

  return router;
}
