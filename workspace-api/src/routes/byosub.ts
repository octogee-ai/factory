import { Router, Request, Response, NextFunction } from "express";
import { requireAuth, requireInternalServiceAuth } from "../middleware/auth";
import { db } from "../lib/db";
import {
  writeSecret,
  addSecretVersionIfExists,
} from "../../../scripts/lib/secret-manager";
import { primaryWorkspaceSlug } from "../../../scripts/lib/workspace-slugs";
import {
  byosubSecretName,
  validateCodexCredential,
  coachAgentId,
  gatewayDeviceAuthClient,
  byosubConnectionView,
  isSafeGatewayId,
} from "../lib/byosub";
import { isSafeAgentId } from "../../../scripts/lib/byosub-restore";

const router = Router();

interface ResolvedGateway {
  slug: string;
  gatewayId: string;
}

async function resolveUserGateway(uid: string): Promise<ResolvedGateway | null> {
  const snap = await db.collection("users").doc(uid).get();
  if (!snap.exists) return null;
  const data = (snap.data() || {}) as {
    username?: string | null;
    provisioning?: {
      openclaw?: { slug?: string | null; gatewayId?: unknown } | null;
    } | null;
  };
  const slug = primaryWorkspaceSlug(data);
  const gatewayId = data?.provisioning?.openclaw?.gatewayId;
  if (!slug || typeof gatewayId !== "string" || !gatewayId) return null;
  return { slug, gatewayId };
}

/** Helm Service name for a gateway — the same derivation glm-controller
 * uses (`octogee-gateway-<instanceName>`), never `gatewayId` munging. */
async function resolveInstanceName(gatewayId: string): Promise<string | null> {
  const snap = await db.collection("glmGateways").doc(gatewayId).get();
  if (!snap.exists) return null;
  const data = (snap.data() || {}) as { instanceName?: unknown };
  const instanceName = data?.instanceName;
  return typeof instanceName === "string" && instanceName ? instanceName : null;
}

interface FlowDoc {
  uid: string;
  gatewayId: string;
  agentId: string;
  provider: string;
  /** Set once on first successful capture — makes /capture single-write
   * (a replayed flowId never re-writes Secret Manager). */
  consumedAt?: number;
  /** Sweep/TTL horizon — a stale, never-completed flow is reapable. */
  expireAt?: number;
}

const FLOW_TTL_MS = 60 * 60 * 1000;

async function readFlow(flowId: string): Promise<FlowDoc | null> {
  const snap = await db.collection("byosubFlows").doc(flowId).get();
  if (!snap.exists) return null;
  return (snap.data() || null) as FlowDoc | null;
}

router.post(
  "/connect",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const uid = req.uid!;
      const provider = String((req.body || {}).provider ?? "openai");
      if (provider === "anthropic") {
        res
          .status(400)
          .json({ error: "Anthropic BYO-subscription is deferred to Chunk E" });
        return;
      }
      if (provider !== "openai") {
        res
          .status(400)
          .json({ error: `Unsupported provider: ${provider}`, supported: ["openai"] });
        return;
      }
      const resolved = await resolveUserGateway(uid);
      if (!resolved) {
        res
          .status(400)
          .json({ error: "No provisioned workspace/gateway for this user" });
        return;
      }
      const instanceName = await resolveInstanceName(resolved.gatewayId);
      if (!instanceName) {
        res
          .status(400)
          .json({ error: "Gateway is not registered with an instanceName" });
        return;
      }
      const agentId = coachAgentId(resolved.slug);
      try {
        const out = await gatewayDeviceAuthClient().start({
          instanceName,
          agentId,
        });
        // R2/ownership: the (uid, gateway, agent) tuple is minted here
        // from the authenticated caller and stored server-side. The
        // gateway never supplies it back — capture binds by flowId alone.
        await db
          .collection("byosubFlows")
          .doc(out.flowId)
          .set({
            uid,
            gatewayId: resolved.gatewayId,
            agentId,
            provider,
            createdAt: Date.now(),
            expireAt: Date.now() + FLOW_TTL_MS,
          });
        res.json(out);
      } catch (e) {
        res.status(503).json({
          error: `Gateway device-auth unavailable: ${(e as Error).message}`,
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
      const flow = await readFlow(req.params.flowId);
      // Owner-bound: a non-owner (or unknown flow) gets an indistinguishable
      // 404 — no cross-tenant flow-state leak on a shared gateway.
      if (!flow || flow.uid !== req.uid!) {
        res.status(404).json({ error: "flow not found" });
        return;
      }
      const instanceName = await resolveInstanceName(flow.gatewayId);
      if (!instanceName) {
        res
          .status(400)
          .json({ error: "Gateway is not registered with an instanceName" });
        return;
      }
      try {
        const out = await gatewayDeviceAuthClient().status({
          instanceName,
          flowId: req.params.flowId,
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

// C2: the user-facing "is my subscription connected?" read. Derived
// from the durable `glmGateways/{gatewayId}.byosub[coachAgentId]` ref —
// returns only {connected, provider}. Never the secretName or credential
// (those never cross to the customer surface).
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
      // Honest view: "connected" means working, not "a ref exists" — a
      // needs_reauth ref reports connected:false + status (R8).
      res.json(byosubConnectionView(ref));
    } catch (e) {
      next(e);
    }
  },
);

/**
 * Flip the unified per-customer credential signal so BYOS rides the SAME
 * watcher as BYOT. ORDER IS LOAD-BEARING: write system/config.byot FIRST,
 * users/{uid}.byotActive LAST. The watcher reacts to users/{uid} and
 * fetches system/config exactly once; byotActive-last guarantees the
 * config subdoc is already visible (else it falls back to anthropic and
 * never re-syncs). Matches BYOT ordering. Idempotent (merge) — safe to
 * re-assert, which also backfills already-consumed pre-unification flows.
 */
async function flipUnifiedByosSignal(uid: string): Promise<void> {
  await db
    .collection("users")
    .doc(uid)
    .collection("system")
    .doc("config")
    .set({ byot: { provider: "openai-codex" } }, { merge: true });
  await db.collection("users").doc(uid).set({ byotActive: true }, { merge: true });
}

// Internal: the gateway runner posts the captured credential here on
// completion. R2 — workspace-api owns the Secret Manager write; the
// gateway SA stays read-only. The gateway supplies only the opaque
// flowId it was handed at /connect plus the credential; uid/agent/
// gateway are derived from the server-side flow record so a coarse
// internal-key holder cannot bind a credential to another owner.
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
      if (flow.provider !== "openai") {
        res
          .status(400)
          .json({ error: `Unsupported provider: ${flow.provider}` });
        return;
      }
      const secretName = byosubSecretName(flow.uid, flow.provider);
      // Single-write, idempotent response: a replayed (or retried) flowId
      // never re-writes Secret Manager — and a replay carrying a *different*
      // credential body is ignored, not honoured. A legit gateway retry
      // still gets a sane ok.
      if (flow.consumedAt) {
        // Backfill / replay-safe: re-assert the unified signal
        // (idempotent) so flows captured *before* unification — and any
        // legit retry — still activate. The secret + glmGateways ref
        // already exist (both precede consumedAt); no secret re-write.
        await flipUnifiedByosSignal(flow.uid);
        res.json({ ok: true, secretName, alreadyConsumed: true });
        return;
      }
      const v = validateCodexCredential(b.credential);
      if (!v.ok) {
        res.status(400).json({ error: `invalid credential: ${v.reason}` });
        return;
      }
      await writeSecret({
        name: secretName,
        value: b.credential,
        labels: { byosub: "true", provider: flow.provider },
      });
      await db
        .collection("glmGateways")
        .doc(flow.gatewayId)
        .set(
          {
            byosub: {
              [flow.agentId]: {
                provider: flow.provider,
                secretName,
                // Re-Connect clears a prior needs_reauth (merge overwrites).
                status: "connected",
              },
            },
          },
          { merge: true },
        );
      // BYOS rides the SAME watcher as BYOT — flip the unified signal
      // (config-first/byotActive-last; see flipUnifiedByosSignal). The
      // glmGateways ref above is written first so the restore has it.
      await flipUnifiedByosSignal(flow.uid);
      // Consume only after the durable write + ref succeeded, so a failed
      // capture stays retryable.
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

// Internal: the gateway's periodic detection sweep posts here when openclaw's
// on-disk auth-state shows the codex profile permanently dead (R8). R2 — the
// gateway SA never writes glmGateways; workspace-api mediates. No credential
// crosses. Bounded: only flips an EXISTING ref's status (never creates one),
// so a coarse internal-key holder can at most surface a spurious Reconnect
// prompt — it cannot inject a credential (that still needs the flow-bound
// device-auth /capture).
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
        // Reject a path-unsafe gatewayId here so it never reaches
        // `.doc(gatewayId)` (Firestore would throw → 500 + wedge the sweep).
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
        // Nothing connected for this agent — cannot "need reauth"; no-op
        // (don't create a ref from an unauthenticated-tuple signal).
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

// Internal: the gateway's periodic sync-back sweep posts a rotated codex
// credential here (Chunk B). R2 — workspace-api owns the Secret Manager
// write; the gateway SA stays read-only. Bounded: only an EXISTING
// connected ref's own secret is overwritten (never creates one), and the
// blob must be a plausible codex auth.json (validateCodexCredential). It
// is a *token refresh* of an already-connected agent — NOT a connect: no
// status / byotActive / config flip (those belong to /capture). A coarse
// internal-key holder can at most overwrite a customer's own stored token
// (→ a failed restore → R8 → reconnect); no cross-tenant escalation, no
// credential exfiltration — same trust model as /capture.
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
        // Not connected for this agent — nothing to sync-back into; no-op
        // (never create a ref/secret from an unauthenticated-tuple signal).
        res.json({ ok: true, noop: true });
        return;
      }
      // Add a new version to the agent's OWN, already-existing secret —
      // version-only (never create, never relabel): a rotation is not a
      // (re)connect, and a secret a Disconnect/teardown destroyed must not
      // be resurrected by a stale lingering ref. Secret gone → no-op.
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
