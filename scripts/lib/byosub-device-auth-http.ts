/**
 * Gateway internal device-auth HTTP endpoints (Chunk C1b). Mounted on the
 * fleet-http Express app (port 3003); the only caller is workspace-api's
 * `gatewayDeviceAuthClient`, addressed by K8s Service name and
 * authenticated with `X-Internal-Service-Key` (same shape site-build-api
 * uses). Handlers are thin: all flow logic lives in the unit-tested
 * `DeviceAuthManager`. Design: BYO-SUBSCRIPTION-OAUTH-SPEC §13.
 */
import { timingSafeEqual } from "crypto";
import type { Express, Request, RequestHandler, Response } from "express";
import type { DeviceAuthManager } from "./byosub-device-auth.js";
import { isSafeAgentId } from "./byosub-restore.js";

export interface DeviceAuthHttpDeps {
  manager: DeviceAuthManager;
  internalServiceKey: string;
  log?: (m: string) => void;
}

/** Length-checked constant-time compare — mirrors workspace-api's
 * `requireInternalServiceAuth`; the key is a shared bearer secret and
 * fleet-http binds 0.0.0.0, so the compare must not be byte-timeable. */
function internalKeyEquals(presented: string, key: string): boolean {
  if (presented.length !== key.length) return false;
  try {
    return timingSafeEqual(
      Buffer.from(presented, "utf8"),
      Buffer.from(key, "utf8"),
    );
  } catch {
    return false;
  }
}

function denied(
  req: Request,
  res: Response,
  key: string,
  log: (m: string) => void,
): boolean {
  // Unset key fails *closed* and indistinguishable from a bad key — the
  // misconfig is logged server-side, never echoed (no env-var-name leak,
  // no conflation with the start path's transient 503).
  if (!key) {
    log(
      "byosub device-auth: refusing request — internal service key not configured",
    );
    res.status(401).json({ error: "unauthorized" });
    return true;
  }
  const presented = req.header("X-Internal-Service-Key") ?? "";
  if (!internalKeyEquals(presented, key)) {
    res.status(401).json({ error: "unauthorized" });
    return true;
  }
  return false;
}

export function createDeviceAuthStartHandler(
  deps: DeviceAuthHttpDeps,
): RequestHandler {
  const log = deps.log ?? (() => {});
  return async (req, res) => {
    if (denied(req, res, deps.internalServiceKey, log)) return;
    const agentId = (req.body as { agentId?: unknown } | undefined)?.agentId;
    if (typeof agentId !== "string" || !agentId) {
      res.status(400).json({ error: "agentId required" });
      return;
    }
    if (!isSafeAgentId(agentId)) {
      res.status(400).json({ error: "agentId is not path-safe" });
      return;
    }
    try {
      res.json(await deps.manager.start(agentId));
    } catch (e) {
      const message = (e as Error).message;
      log(`byosub device-auth: start failed for ${agentId} — ${message}`);
      res.status(503).json({ error: `device-auth unavailable: ${message}` });
    }
  };
}

export function createDeviceAuthStatusHandler(
  deps: DeviceAuthHttpDeps,
): RequestHandler {
  const log = deps.log ?? (() => {});
  return (req, res) => {
    if (denied(req, res, deps.internalServiceKey, log)) return;
    const out = deps.manager.status(req.params.flowId as string);
    if (!out) {
      res.status(404).json({ error: "flow not found" });
      return;
    }
    res.json(out);
  };
}

export function mountByosubDeviceAuth(
  app: Express,
  deps: DeviceAuthHttpDeps,
): void {
  app.post(
    "/internal/byosub/device-auth/start",
    createDeviceAuthStartHandler(deps),
  );
  app.get(
    "/internal/byosub/device-auth/status/:flowId",
    createDeviceAuthStatusHandler(deps),
  );
}
