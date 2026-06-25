import { Router, type Request, type Response } from "express";
import type { Firestore } from "firebase-admin/firestore";
import { MODEL_CREDENTIAL_STATIC_PROVIDER_IDS } from "@shared/types/model-credentials.js";

import { readSecret } from "../../../scripts/lib/secret-manager.js";
import { isSafeAgentId } from "../../../scripts/lib/byosub-restore.js";
import { readAssignedSlugsForGateway } from "../../../scripts/lib/assigned-roster.js";
import { createFirestoreModelBrokerTokenStore } from "../lib/model-broker-tokens.js";
import { findAssignedUserByAgentId } from "./fleet-broker.js";

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
  provider?: unknown;
  secretName?: unknown;
}

export function createByokBrokerRoutes(opts: { db: Firestore }): Router {
  const router = Router();
  const { db } = opts;

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

    const snap = await db.collection("glmGateways").doc(bound.gatewayId).get();
    const byosub = (snap.data() as { byosub?: Record<string, ByosubRef> } | undefined)?.byosub;
    const ref = byosub?.[agentId];
    const provider = typeof ref?.provider === "string" ? ref.provider : "";
    const secretName = typeof ref?.secretName === "string" ? ref.secretName : "";
    if (!provider || !secretName) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (!BYOSUB_SECRET_RE.test(secretName) || !secretName.endsWith(`-${provider}`)) {
      res.status(500).json({ error: "malformed secret ref" });
      return;
    }

    const credential = await readSecret(secretName);
    res.json({ provider, secretName, credential });
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

  // Mint an owner-scoped, METER-ONLY broker token for one customer-agent on a
  // shared (multi-tenant) gateway. The agent resolves anthropic through the broker
  // with its OWN token, so the broker resolves per-owner (platform key, or the
  // owner's byok-<slug>-anthropic) and meters per ownerUid. Roster-scoped via
  // findAssignedUserByAgentId — a gateway can only mint for a customer assigned to
  // it. `limits: null` = meter-only; the per-builder cap stays on the in-pod L3
  // throttle (shared customers throttle exactly as before).
  router.post("/agent-model-token", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;

    const agentId = (req.body as { agentId?: unknown } | undefined)?.agentId;
    if (typeof agentId !== "string" || !isSafeAgentId(agentId)) {
      res.status(400).json({ error: "valid agentId required" });
      return;
    }

    const assigned = await findAssignedUserByAgentId(db, bound.gatewayId, agentId);
    if (!assigned) {
      res.status(403).json(FORBIDDEN);
      return;
    }

    const issued = await createFirestoreModelBrokerTokenStore(db).issueToken({
      gatewayId: bound.gatewayId,
      ownerUid: assigned.uid,
      provider: "anthropic",
      // a descriptive label, NOT a readable Secret Manager secret — the broker
      // resolves the provider key per ownerUid, never via this name.
      secretName: `agent-model-token-${bound.gatewayId}-${assigned.uid}`,
      // standalone + TTL-bounded: no revoke-on-reissue, so a re-mint can't yank a
      // still-in-flight token (the prior one expires by TTL instead).
      skipPointer: true,
      ttlSeconds: AGENT_MODEL_TOKEN_TTL_SECONDS,
      limits: null,
    });
    res.json({ value: issued.token });
  });

  return router;
}
