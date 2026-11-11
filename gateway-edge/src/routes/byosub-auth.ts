import { Router, Request, Response, NextFunction } from "express";

import { requireAuthenticatedUid } from "../middleware/auth.js";
import {
  userDefaultAgentId,
  gatewayClaudeSsoClient,
  gatewayDeviceAuthClient,
  brokerByosubFlow,
} from "../lib/byosub.js";
import {
  readByosubFlow,
  resolveByosubUserGateway,
  type ByosubFlowRecord,
} from "../lib/byosub-broker.js";
import {
  MODEL_CREDENTIAL_SUBSCRIPTION_PROVIDER_IDS,
  modelCredentialOAuthEntryByProviderId,
  modelCredentialOAuthEntryBySubscriptionProvider,
  type ModelCredentialOAuthCatalogEntry,
  type ModelCredentialOAuthProviderId,
  type ModelCredentialSubscriptionProviderId,
} from "@octogee/shared/types/model-credentials";

function subscriptionProviderIds(): ModelCredentialSubscriptionProviderId[] {
  return [...MODEL_CREDENTIAL_SUBSCRIPTION_PROVIDER_IDS];
}

function oauthEntryFromFlow(flow: ByosubFlowRecord): ModelCredentialOAuthCatalogEntry | null {
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

function localGatewayId(): string | null {
  return process.env.GATEWAY_ID?.trim() || null;
}

function flowIsMountedHere(flow: ByosubFlowRecord): boolean {
  const local = localGatewayId();
  return !!local && flow.gatewayId === local;
}

function hasPrivateSubscriptionRuntime(): boolean {
  return process.env.GATEWAY_CLASS?.trim() === "builder";
}

export function createByosubAuthRouter(): Router {
  const router = Router({ mergeParams: true });

  router.post(
    "/connect",
    requireAuthenticatedUid,
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
        const resolved = await resolveByosubUserGateway(uid);
        if (!resolved) {
          res.status(400).json({ error: "No provisioned workspace/gateway for this user" });
          return;
        }
        const local = localGatewayId();
        if (!local || resolved.gatewayId !== local) {
          res.status(409).json({ error: "not_on_this_pod" });
          return;
        }
        if (!hasPrivateSubscriptionRuntime()) {
          res.status(409).json({
            code: "subscription-runtime-required",
            error: "A private isolated runtime is required before connecting a personal subscription",
          });
          return;
        }
        const agentId = userDefaultAgentId(resolved.slug);
        try {
          const out =
            entry.oauth.gatewayFlow === "claude-sso"
              ? await gatewayClaudeSsoClient().start({ gatewayId: resolved.gatewayId, agentId })
              : await gatewayDeviceAuthClient().start({ gatewayId: resolved.gatewayId, agentId });
          await brokerByosubFlow({
            flowId: out.flowId,
            agentId,
            provider: entry.oauth.subscriptionProvider,
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
    requireAuthenticatedUid,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const flowId = req.params.flowId as string;
        const flow = await readByosubFlow(flowId);
        if (!flow || flow.uid !== req.uid!) {
          res.status(404).json({ error: "flow not found" });
          return;
        }
        if (!flowIsMountedHere(flow)) {
          res.status(409).json({ error: "not_on_this_pod" });
          return;
        }
        const entry = oauthEntryFromFlow(flow);
        if (!entry) {
          res.status(400).json({ error: `Unsupported provider: ${flow.provider}` });
          return;
        }
        try {
          const out =
            entry.oauth.gatewayFlow === "claude-sso"
              ? await gatewayClaudeSsoClient().status({ gatewayId: flow.gatewayId, flowId })
              : await gatewayDeviceAuthClient().status({ gatewayId: flow.gatewayId, flowId });
          res.json(out);
        } catch (e) {
          res.status(503).json({ error: `Gateway status unavailable: ${(e as Error).message}` });
        }
      } catch (e) {
        next(e);
      }
    },
  );

  router.post(
    "/sso/submit",
    requireAuthenticatedUid,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const b = (req.body || {}) as { flowId?: string; code?: string };
        if (!b.flowId || typeof b.code !== "string" || !b.code) {
          res.status(400).json({ error: "flowId and code required" });
          return;
        }
        const flow = await readByosubFlow(b.flowId);
        if (!flow || flow.uid !== req.uid!) {
          res.status(404).json({ error: "flow not found" });
          return;
        }
        if (!flowIsMountedHere(flow)) {
          res.status(409).json({ error: "not_on_this_pod" });
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
          res.status(503).json({ error: `Gateway Claude SSO unavailable: ${(e as Error).message}` });
        }
      } catch (e) {
        next(e);
      }
    },
  );

  return router;
}
