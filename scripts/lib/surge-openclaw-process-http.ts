import type { Request, RequestHandler, Response } from "express";

import { isValidUsername } from "../../shared/types/identity.js";
import { SIGNATURE_HEADER } from "../../shared/types/fleet-controller.js";
import { gatewayScopedJobId, verifyFleetRequest } from "./fleet-signature.js";
import { rejectMisaddressedGateway } from "./fleet-gateway-path.js";
import type {
  SurgeOpenClawProcessGateState,
  SurgeOpenClawProcessRequest,
  SurgeOpenClawProcessSupervisorClient,
} from "./surge-openclaw-process-gate.js";

type SurgeOpenClawProcessOperation = "hold" | "resume" | "unreserve";
type SurgeOpenClawProcessHandlerGate = Pick<
  SurgeOpenClawProcessSupervisorClient,
  SurgeOpenClawProcessOperation | "finalizeTargetCancellation"
>;

export interface SurgeOpenClawProcessHandlerDeps {
  publicKey: string;
  gatewayId: string;
  configuredBuilder: (slug: string) => boolean;
  processGate?: SurgeOpenClawProcessHandlerGate;
  unreserveConfiguredBuilderTarget?: (request: SurgeOpenClawProcessRequest) => Promise<SurgeOpenClawProcessGateState>;
  waitForActiveProvisioningDrain?: () => Promise<void>;
  log?: (message: string) => void;
}

function parseProcessRequestBody(rawBody: string): SurgeOpenClawProcessRequest | null {
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    body = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const { migrationId, slug, targetPodUid } = body;
  if (typeof migrationId !== "string" || !migrationId || migrationId.length > 512) return null;
  if (typeof slug !== "string" || !isValidUsername(slug)) return null;
  if (typeof targetPodUid !== "string" || !targetPodUid || targetPodUid.length > 512) return null;
  return { migrationId, slug, targetPodUid };
}

function parseAndVerify(
  req: Request,
  res: Response,
  deps: SurgeOpenClawProcessHandlerDeps,
): SurgeOpenClawProcessRequest | null {
  const rawBody = (req as Request & { rawBody?: string }).rawBody ?? "";
  const request = parseProcessRequestBody(rawBody);
  if (!request) {
    res.status(400).json({ error: "missing or invalid migrationId/slug/targetPodUid" });
    return null;
  }
  const signature = req.header(SIGNATURE_HEADER);
  if (!verifyFleetRequest(
    deps.publicKey,
    gatewayScopedJobId(request.migrationId, deps.gatewayId),
    rawBody,
    signature ?? undefined,
  )) {
    deps.log?.(`[surge-handoff] bad OpenClaw process control signature migrationId=${request.migrationId}`);
    res.status(401).json({ error: "invalid signature" });
    return null;
  }
  if (rejectMisaddressedGateway(req, res, deps.gatewayId, deps.log ?? (() => undefined))) {
    return null;
  }
  return request;
}

function requireConfiguredBuilder(
  request: SurgeOpenClawProcessRequest,
  res: Response,
  deps: SurgeOpenClawProcessHandlerDeps,
): SurgeOpenClawProcessHandlerGate | null {
  if (!deps.processGate || !deps.configuredBuilder(request.slug)) {
    res.status(409).json({ error: "configured Builder OpenClaw process control is unavailable" });
    return null;
  }
  return deps.processGate;
}

function createHandler(
  operation: SurgeOpenClawProcessOperation,
  deps: SurgeOpenClawProcessHandlerDeps,
): RequestHandler {
  return async (req, res) => {
    const request = parseAndVerify(req, res, deps);
    if (!request) return;
    const gate = requireConfiguredBuilder(request, res, deps);
    if (!gate) return;
    try {
      let state = operation === "unreserve" && deps.unreserveConfiguredBuilderTarget
        ? await deps.unreserveConfiguredBuilderTarget(request)
        : await gate[operation](request);
      if (operation === "hold") {
        await deps.waitForActiveProvisioningDrain?.();
        if (state.phase === "cancelling") state = await gate.finalizeTargetCancellation(request);
      }
      res.status(200).json({
        migrationId: request.migrationId,
        slug: request.slug,
        targetPodUid: request.targetPodUid,
        operation,
        role: state.role,
        mode: state.mode,
        phase: state.phase,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.log?.(`[surge-handoff] OpenClaw process ${operation} failed migrationId=${request.migrationId} slug=${request.slug}: ${message}`);
      res.status(409).json({ error: `OpenClaw process ${operation} failed`, message });
    }
  };
}

export function createHoldSurgeOpenClawHandler(
  deps: SurgeOpenClawProcessHandlerDeps,
): RequestHandler {
  return createHandler("hold", deps);
}

export function createResumeSurgeOpenClawHandler(
  deps: SurgeOpenClawProcessHandlerDeps,
): RequestHandler {
  return createHandler("resume", deps);
}

export function createUnreserveSurgeOpenClawHandler(
  deps: SurgeOpenClawProcessHandlerDeps,
): RequestHandler {
  return createHandler("unreserve", deps);
}
