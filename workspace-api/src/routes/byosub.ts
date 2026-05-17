import { Router, Request, Response, NextFunction } from "express";
import { requireAuth, requireInternalServiceAuth } from "../middleware/auth";
import { db } from "../lib/db";
import { writeSecret } from "../../../scripts/lib/secret-manager";
import { primaryWorkspaceSlug } from "../../../scripts/lib/workspace-slugs";
import {
  byosubSecretName,
  validateCodexCredential,
  coachAgentId,
  gatewayDeviceAuthClient,
} from "../lib/byosub";

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
}

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
      const v = validateCodexCredential(b.credential);
      if (!v.ok) {
        res.status(400).json({ error: `invalid credential: ${v.reason}` });
        return;
      }
      const secretName = byosubSecretName(flow.uid, flow.provider);
      await writeSecret({
        name: secretName,
        value: b.credential,
        labels: { byosub: "true", provider: flow.provider },
      });
      await db
        .collection("glmGateways")
        .doc(flow.gatewayId)
        .set(
          { byosub: { [flow.agentId]: { provider: flow.provider, secretName } } },
          { merge: true },
        );
      res.json({ ok: true, secretName });
    } catch (e) {
      next(e);
    }
  },
);

export default router;
