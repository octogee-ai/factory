import { Router, type Request, type Response } from "express";
import type { Firestore } from "firebase-admin/firestore";
import { gatewayAuthorizationFromRootDocument } from "@octogee/core/gateway-live-release";
import { slugFromAssignedUser, userAssignmentMatchesGateway } from "@octogee/core/assigned-roster";
import { resolveGatewayClass } from "@octogee/shared/types/glm";
import { parseAgentId, mattermostAccountIdForAgentId } from "@octogee/shared/types/identity";
import { isSafeAgentId } from "@octogee/core/byosub-restore";
import { findAssignedUserByAgentId } from "./fleet-broker.js";

const FORBIDDEN = { error: "forbidden" } as const;
interface AgentOwnerContext {
  gatewayId: string;
  ownerUid: string;
  workspaceSlug: string;
  agentId: string;
  assignedData: Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function value(req: Request, key: string): unknown {
  return record(req.body)?.[key] ?? req.query[key];
}

function agentRequestContext(
  req: Request,
  res: Response,
): { gatewayId: string; agentId: string } | null {
  const bound = req.boundTenant;
  if (!bound || bound.kind !== "gateway") {
    res.status(403).json(FORBIDDEN);
    return null;
  }
  const agentId = value(req, "agentId");
  if (typeof agentId !== "string" || !isSafeAgentId(agentId)) {
    res.status(400).json({ error: "valid agentId required" });
    return null;
  }
  if (parseAgentId(agentId).kind !== "coach") {
    res.status(403).json(FORBIDDEN);
    return null;
  }
  return { gatewayId: bound.gatewayId, agentId };
}

async function assignedAgentOwnerContext(
  db: Firestore,
  gatewayId: string,
  agentId: string,
): Promise<AgentOwnerContext | null> {
  const assigned = await findAssignedUserByAgentId(db, gatewayId, agentId);
  if (!assigned) {
    return null;
  }
  const root = await db.doc(`gateways/${gatewayId}`).get();
  const authorization = root.exists
    ? gatewayAuthorizationFromRootDocument(root.data(), gatewayId)
    : null;
  const workspaceSlug = slugFromAssignedUser(assigned.data);
  if (!authorization || !workspaceSlug) {
    return null;
  }
  const gatewayClass = resolveGatewayClass({
    gatewayClass: authorization.config.gatewayClass,
    profile: authorization.config.profile ?? undefined,
    imageProfile: authorization.config.imageProfile,
  });
  const assignedScope = userAssignmentMatchesGateway(
    assigned.data,
    gatewayId,
    workspaceSlug,
  );
  if (!assignedScope) return null;
  if (gatewayClass === "shared") {
    const workspace = await db.doc(`workspaces/${workspaceSlug}`).get();
    if (!workspace.exists || workspace.data()?.ownerUid !== assigned.uid) return null;
  } else if (authorization.config.ownerUid !== assigned.uid ||
    authorization.config.builderSlug !== workspaceSlug) {
    return null;
  }
  return {
    gatewayId,
    ownerUid: assigned.uid,
    workspaceSlug,
    agentId,
    assignedData: assigned.data as Record<string, unknown>,
  };
}

function runningPodInstanceId(live: Record<string, unknown>, podUid: string | undefined): string | null {
  if (!podUid || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(podUid)) return null;
  const observed = record(live.kubernetes);
  if (!observed || observed.status !== "ready" || observed.totalPods !== 1 || observed.readyPods !== 1) return null;
  const pods = observed.pods;
  if (!Array.isArray(pods) || pods.length !== 1 || record(pods[0])?.uid !== podUid) return null;
  return `cluster:${podUid}`;
}

function runningComputerInstanceId(live: Record<string, unknown> | undefined, podUid: string | undefined): string | null {
  if (live?.runtime === "cluster") return runningPodInstanceId(live, podUid);
  const vm = record(live?.vm);
  if (live?.runtime !== "gce-vm" || vm?.status !== "RUNNING" ||
    typeof vm.instanceId !== "string" || !/^\d+$/u.test(vm.instanceId)) return null;
  return `gce-vm:${vm.instanceId}`;
}

export function createAgentComputerContextRoutes(args: { db: Firestore }): Router {
  const router = Router();
  router.post("/agent-context", async (req, res) => {
    const request = agentRequestContext(req, res);
    if (!request) return;
    const context = await assignedAgentOwnerContext(args.db, request.gatewayId, request.agentId);
    if (!context) { res.status(403).json(FORBIDDEN); return; }
    const [root, fleet] = await Promise.all([
      args.db.doc(`gateways/${context.gatewayId}`).get(),
      args.db.doc(`glmGateways/${context.gatewayId}`).get(),
    ]);
    const authorization = root.exists ? gatewayAuthorizationFromRootDocument(root.data(), context.gatewayId) : null;
    const agentAccountId = mattermostAccountIdForAgentId(context.agentId);
    if (!authorization || authorization.config.ownerUid !== context.ownerUid || !agentAccountId) {
      res.status(403).json(FORBIDDEN); return;
    }
    const bound = req.boundTenant;
    const computerInstanceId = runningComputerInstanceId(fleet.data(), bound?.kind === "gateway" ? bound.podUid : undefined);
    if (authorization.gateway.desiredStatus !== "running" || !computerInstanceId) {
      res.status(409).json({ error: "computer-unavailable" }); return;
    }
    const ownerMattermostUserId = record(context.assignedData.mattermost)?.userId;
    res.json({
      gatewayId: context.gatewayId, ownerUid: context.ownerUid, computerInstanceId, agentAccountId,
      ...(computerInstanceId.startsWith("gce-vm:") ? { vmInstanceId: computerInstanceId.slice("gce-vm:".length) } : {}),
      ownerMattermostUserId: typeof ownerMattermostUserId === "string" && /^[a-z0-9]{26}$/u.test(ownerMattermostUserId)
        ? ownerMattermostUserId : null,
    });
  });

  return router;
}
