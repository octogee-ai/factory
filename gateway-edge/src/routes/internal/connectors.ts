import { Router, type Request, type Response } from "express";

import { isConnectorAgentRuntimeTokenMaterializable } from "../../lib/connectors/index.js";
import {
  ConnectorTokenReadError,
  readConnectorAccessToken,
} from "../../lib/connector-tokens.js";
import { db } from "../../lib/db.js";
import { logger } from "../../middleware/logging.js";
import { requireBuilderShellInternalAuth } from "../../middleware/builder-shell-auth.js";

const router = Router();
const GATEWAY_OWNER_UNAVAILABLE = "gateway owner unavailable";
const GATEWAY_OWNER_UNCONFIGURED = "gateway_owner_unconfigured";

function nonBlank(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function isOwnerRuntimeGateway(): boolean {
  const gatewayClass = nonBlank(process.env.GATEWAY_CLASS);
  if (gatewayClass) return gatewayClass === "builder" || gatewayClass === "operator";
  return nonBlank(process.env.GATEWAY_PROFILE) === "operator";
}

function stringField(data: Record<string, unknown> | undefined, key: string): string | null {
  const value = data?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isOwnerRuntimeReleasePayload(data: Record<string, unknown> | undefined): boolean {
  return data?.gatewayClass === "builder" || data?.gatewayClass === "operator";
}

function recordField(
  data: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  const value = data?.[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function paramString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

async function readDoc(path: string): Promise<Record<string, unknown> | undefined> {
  const snap = await db.doc(path).get();
  return snap.exists ? (snap.data() as Record<string, unknown> | undefined) : undefined;
}

async function readRuntimeReleasePayload(
  gatewayId: string,
  revisionId: string,
): Promise<{ payload: Record<string, unknown> | undefined; release: number } | null> {
  const revision = await readDoc(`glmGateways/${revisionId}`);
  const release = revision?.release;
  if (
    revision?.docKind !== "revision" ||
    stringField(revision, "revisionId") !== revisionId ||
    stringField(revision, "gateway") !== gatewayId ||
    typeof release !== "number" ||
    !Number.isInteger(release) ||
    release < 1
  ) {
    return null;
  }
  const releaseDoc = await readDoc(`gateways/${gatewayId}/releases/${release}`);
  return { payload: recordField(releaseDoc, "payload"), release };
}

async function resolveOwnerRuntimeOwnerUid(
  res: Response,
): Promise<string | null> {
  if (!isOwnerRuntimeGateway()) {
    res.status(403).json({ error: "forbidden", code: "owner_runtime_gateway_required" });
    return null;
  }

  const gatewayId = nonBlank(process.env.GATEWAY_ID);
  const revisionId = nonBlank(process.env.GATEWAY_REVISION_ID);
  const builderSlug = nonBlank(process.env.GATEWAY_BUILDER_SLUG);
  if (!gatewayId || !revisionId || !builderSlug) {
    logger.error("[connectors/materialize] runtime gateway owner env is incomplete", {
      gatewayId: Boolean(gatewayId),
      revisionId: Boolean(revisionId),
      builderSlug: Boolean(builderSlug),
    });
    res
      .status(503)
      .json({ error: GATEWAY_OWNER_UNAVAILABLE, code: GATEWAY_OWNER_UNCONFIGURED });
    return null;
  }

  const workspace = await readDoc(`workspaces/${builderSlug}`);
  const ownerUid = stringField(workspace, "ownerUid");
  if (!ownerUid) {
    logger.error("[connectors/materialize] mounted builder workspace has no ownerUid", {
      gatewayId,
      builderSlug,
    });
    res
      .status(503)
      .json({ error: GATEWAY_OWNER_UNAVAILABLE, code: GATEWAY_OWNER_UNCONFIGURED });
    return null;
  }

  const runtimeRelease = await readRuntimeReleasePayload(gatewayId, revisionId);
  if (!runtimeRelease) {
    logger.error("[connectors/materialize] runtime revision identity is invalid", {
      gatewayId,
      revisionId,
    });
    res
      .status(503)
      .json({ error: GATEWAY_OWNER_UNAVAILABLE, code: GATEWAY_OWNER_UNCONFIGURED });
    return null;
  }

  const { payload, release: revisionRelease } = runtimeRelease;
  if (!payload) {
    logger.error("[connectors/materialize] runtime release payload is missing", {
      gatewayId,
      revisionId,
      revisionRelease,
    });
    res
      .status(503)
      .json({ error: GATEWAY_OWNER_UNAVAILABLE, code: GATEWAY_OWNER_UNCONFIGURED });
    return null;
  }
  if (!isOwnerRuntimeReleasePayload(payload)) {
    res.status(403).json({ error: "forbidden", code: "owner_runtime_gateway_required" });
    return null;
  }

  const releaseOwnerUid = stringField(payload, "ownerUid");
  if (!releaseOwnerUid) {
    logger.error("[connectors/materialize] runtime gateway release has no ownerUid", {
      gatewayId,
      revisionId,
      revisionRelease,
      builderSlug,
      ownerUid,
    });
    res
      .status(503)
      .json({ error: GATEWAY_OWNER_UNAVAILABLE, code: GATEWAY_OWNER_UNCONFIGURED });
    return null;
  }
  if (releaseOwnerUid !== ownerUid) {
    logger.warn("[connectors/materialize] runtime gateway owner mismatch", {
      gatewayId,
      revisionId,
      builderSlug,
      ownerUid,
      releaseOwnerUid,
    });
    res.status(403).json({ error: "forbidden", code: "gateway_owner_mismatch" });
    return null;
  }

  return ownerUid;
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
    if (!connectorId || !isConnectorAgentRuntimeTokenMaterializable(connectorId)) {
      res.status(403).json({ error: "forbidden", code: "connector_not_materializable" });
      return;
    }

    const ownerUid = await resolveOwnerRuntimeOwnerUid(res);
    if (!ownerUid) return;

    try {
      const accessToken = await readConnectorAccessToken(ownerUid, connectorId, {
        kind: "owner-runtime",
      });
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
          ownerUid,
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
        ownerUid,
        err: err instanceof Error ? err.message : String(err),
      });
      res.status(502).json({ error: "connector materialization failed" });
    }
  },
);

export default router;
