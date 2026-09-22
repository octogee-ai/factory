import { Router, type Request, type Response } from "express";

import { isConnectorAgentRuntimeTokenMaterializable } from "../../lib/connectors/index.js";
import {
  ConnectorTokenReadError,
  readOwnerGithubProjectCloneAccess,
  readOwnerRuntimeConnectorAccessToken,
} from "../../lib/connector-tokens.js";
import { cloneGithubProjectCheckout } from "../../lib/github-project-clone.js";
import { logger } from "../../middleware/logging.js";
import { requireGatewayInternalAuth } from "../../middleware/gateway-internal-auth.js";

const router = Router();

function nonBlank(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function isOwnerRuntimeGateway(): boolean {
  const gatewayClass = nonBlank(process.env.GATEWAY_CLASS);
  return gatewayClass === "builder";
}

function paramString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function tokenReadForbidden(err: unknown): boolean {
  return err instanceof ConnectorTokenReadError && err.status === 403;
}

function tokenReadReauthRequired(err: unknown): boolean {
  return err instanceof ConnectorTokenReadError && err.errorCode === "reauth_required";
}

function tokenReadUnavailable(err: unknown): err is ConnectorTokenReadError {
  return err instanceof ConnectorTokenReadError && (err.status === 403 || err.status === 503);
}

router.get(
  "/:connector/materialize",
  requireGatewayInternalAuth,
  async (req: Request, res: Response) => {
    const connectorId = paramString(req.params.connector);
    if (
      !connectorId
      || !isConnectorAgentRuntimeTokenMaterializable(connectorId)
    ) {
      res.status(403).json({ error: "forbidden", code: "connector_not_materializable" });
      return;
    }
    if (!isOwnerRuntimeGateway()) {
      res.status(403).json({ error: "forbidden", code: "owner_runtime_gateway_required" });
      return;
    }

    try {
      const accessToken = await readOwnerRuntimeConnectorAccessToken(connectorId);
      if (!accessToken) {
        res.status(404).json({
          status: "disconnected",
          connectorId,
          reason: "not_connected",
        });
        return;
      }

      res.json({ status: "connected", connectorId, accessToken });
    } catch (err) {
      if (tokenReadForbidden(err)) {
        logger.warn("[connectors/materialize] broker rejected owner-runtime token read", {
          connectorId,
        });
        res.status(403).json({ error: "forbidden" });
        return;
      }
      if (tokenReadReauthRequired(err)) {
        res.status(409).json({
          status: "disconnected",
          connectorId,
          reason: "reauth_required",
        });
        return;
      }
      logger.error("[connectors/materialize] materialization failed", {
        connectorId,
        err: err instanceof Error ? err.message : String(err),
      });
      res.status(502).json({ error: "connector materialization failed" });
    }
  },
);

router.post(
  "/github/clone",
  requireGatewayInternalAuth,
  async (req: Request, res: Response) => {
    const projectSlug = paramString(req.body?.projectSlug);
    const builderSlug = paramString(req.body?.builderSlug);
    const expectedBuilderSlug = nonBlank(process.env.GATEWAY_BUILDER_SLUG);
    if (
      !projectSlug ||
      !builderSlug ||
      builderSlug !== expectedBuilderSlug ||
      !isOwnerRuntimeGateway()
    ) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    try {
      const access = await readOwnerGithubProjectCloneAccess(projectSlug);
      if (!access) {
        res.status(422).json({ error: "GitHub project clone unavailable", code: "OWNER_GITHUB_NOT_CONNECTED" });
        return;
      }
      const status = await cloneGithubProjectCheckout({
        customersRoot: process.env.CUSTOMERS_DIR || "/home/node/.openclaw/customers",
        builderSlug,
        projectSlug,
        repository: access.repository,
        accessToken: access.accessToken,
      });
      res.status(status === "cloned" ? 201 : 200).json({ status });
    } catch (err) {
      if (tokenReadReauthRequired(err)) {
        res.status(409).json({ error: "reauth_required" });
        return;
      }
      if (tokenReadUnavailable(err)) {
        res.status(err.status).json({ error: err.errorCode });
        return;
      }
      logger.error("[connectors/github/clone] clone failed", {
        projectSlug,
        err: err instanceof Error ? err.message : String(err),
      });
      res.status(502).json({ error: "GitHub project clone failed" });
    }
  },
);

export default router;
