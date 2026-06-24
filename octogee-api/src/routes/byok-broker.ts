import { Router, type Request, type Response } from "express";
import type { Firestore } from "firebase-admin/firestore";

import { readSecret } from "../../../scripts/lib/secret-manager.js";
import { isSafeAgentId } from "../../../scripts/lib/byosub-restore.js";
import { readAssignedSlugsForGateway } from "../../../scripts/lib/assigned-roster.js";

type GatewayBinding = Extract<Express.Request["boundTenant"], { kind: "gateway" }>;

const FORBIDDEN = { error: "forbidden" } as const;
// This broker materializes ONLY byosub OAuth credentials. A byosub secret id is
// `byosub-<uid>-<provider>` (gateway-edge/src/lib/byosub.ts byosubSecretName) —
// the raw mixed-case Firebase uid plus exactly the two OAuth-sub providers.
// Pinning that shape, and matching the stored provider suffix below, stops a
// corrupted glmGateways.byosub ref from steering readSecret onto an unrelated
// Secret Manager secret (e.g. gateway-auth-token-*) and leaking it to the pod.
const BYOSUB_SECRET_RE = /^byosub-[A-Za-z0-9_-]+-(?:openai|anthropic)$/;
// byok API-key ref: byok-<slug>-<provider>[/version], slug-keyed (the customer
// username). Provider enum mirrors scripts/secret-resolver.mjs BYOK_ID_RE + the
// api_key catalog. Pins the shape before the secret read; the slug is then
// roster-checked so a corrupted ref can't reach another tenant's / an unrelated
// secret.
const BYOK_API_KEY_RE =
  /^byok-(?<slug>[a-z0-9][a-z0-9-]{0,62})-(?<provider>anthropic|openai|openai-compatible|grok|openrouter|minimax)(?:\/(?<version>[a-zA-Z0-9-]{1,32}))?$/;

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
    const m = id.match(BYOK_API_KEY_RE);
    if (!m?.groups) {
      res.status(400).json({ error: "malformed byok id" });
      return;
    }
    const { slug, provider, version } = m.groups;

    const roster = await readAssignedSlugsForGateway(db, bound.gatewayId);
    if (!roster.includes(slug)) {
      res.status(403).json(FORBIDDEN);
      return;
    }

    const value = await readSecret(`byok-${slug}-${provider}`, version ?? "latest");
    res.json({ value });
  });

  return router;
}
