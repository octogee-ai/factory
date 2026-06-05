import { Router, Request, Response, NextFunction } from "express";
import { FieldValue } from "firebase-admin/firestore";
import { requireAuth, requireInternalServiceAuth } from "../middleware/auth.js";
import { db } from "../lib/db.js";
import {
  writeSecret,
  addSecretVersionIfExists,
} from "../../../scripts/lib/secret-manager.js";
import { primaryWorkspaceSlug } from "../../../scripts/lib/workspace-slugs.js";
import {
  byosubSecretName,
  validateCodexCredential,
  coachAgentId,
  gatewayDeviceAuthClient,
  byosubConnectionView,
  isSafeGatewayId,
} from "../lib/byosub.js";
import { isSafeAgentId } from "../../../scripts/lib/byosub-restore.js";

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

interface FlowDoc {
  uid: string;
  gatewayId: string;
  agentId: string;
  provider: string;

consumedAt?: number;
  
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
      const agentId = coachAgentId(resolved.slug);
      try {
        const out = await gatewayDeviceAuthClient().start({
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
      const flow = await readFlow(req.params.flowId as string);

if (!flow || flow.uid !== req.uid!) {
        res.status(404).json({ error: "flow not found" });
        return;
      }
      try {
        const out = await gatewayDeviceAuthClient().status({
          gatewayId: flow.gatewayId,
          flowId: req.params.flowId as string,
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

async function flipUnifiedByosSignal(uid: string): Promise<void> {
  await db
    .collection("users")
    .doc(uid)
    .collection("system")
    .doc("config")
    .set({ byot: { provider: "openai-codex" } }, { merge: true });
  await db.collection("users").doc(uid).set({ byotActive: true }, { merge: true });
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
        .set({ byot: null }, { merge: true });

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
      }

      res.json({ ok: true });
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
      if (flow.provider !== "openai") {
        res
          .status(400)
          .json({ error: `Unsupported provider: ${flow.provider}` });
        return;
      }
      const secretName = byosubSecretName(flow.uid, flow.provider);

if (flow.consumedAt) {

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
                
                status: "connected",
              },
            },
          },
          { merge: true },
        );

await flipUnifiedByosSignal(flow.uid);

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
