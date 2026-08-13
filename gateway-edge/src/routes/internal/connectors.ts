import { Router, type Request, type Response } from "express";

import { isConnectorAgentRuntimeTokenMaterializable } from "../../lib/connectors/index.js";
import {
  ConnectorTokenReadError,
  readOwnerRuntimeConnectorAccessToken,
} from "../../lib/connector-tokens.js";
import { logger } from "../../middleware/logging.js";
import { requireBuilderShellInternalAuth } from "../../middleware/builder-shell-auth.js";

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

router.get(
  "/:connector/materialize",
  requireBuilderShellInternalAuth,
  async (req: Request, res: Response) => {
    const connectorId = paramString(req.params.connector);
    if (
      !connectorId
      || connectorId === "github"
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

export default router;
