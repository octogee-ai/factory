import type { NextFunction, Request, Response } from "express";
import type { Firestore } from "firebase-admin/firestore";
import {
  hasRunningInboundMigrationForSlug,
  readAssignedSlugsForGateway,
} from "../../../scripts/lib/assigned-roster.js";
import { db as defaultDb } from "../../../gateway-edge/src/lib/db.js";

type GatewayBinding = Extract<Express.Request["boundTenant"], { kind: "gateway" }>;

export interface TenantEnforcementOptions {
  db?: Pick<Firestore, "collection">;
}

const FORBIDDEN = { error: "forbidden" } as const;

// The only internal routes a platform tenant (the octogee-cron KSA) may reach.
// Must stay in lockstep with the routes guarded by requireInternalPlatformAuth.
const PLATFORM_INTERNAL_ROUTES = new Set([
  "/internal/billing/check-trial-expiry",
  "/internal/notifications/digest",
]);

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(stringValue).filter((v): v is string => !!v) : [];
}

function body(req: Request): Record<string, unknown> {
  return req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
}

function requestedGatewayIds(req: Request): string[] {
  const b = body(req);
  return [
    stringValue(b.gatewayId),
    stringValue(req.params?.gatewayId),
    stringValue(req.query?.gatewayId),
  ].filter((v): v is string => !!v);
}

function requestedFlowId(req: Request): string | null {
  return stringValue(body(req).flowId);
}

function requestedUids(req: Request): string[] {
  const b = body(req);
  return [
    stringValue(b.uid),
    stringValue(b.ownerUid),
    stringValue(b.actorUid),
    stringValue(req.params?.uid),
    ...stringArray(b.targetUserIds),
  ].filter((v): v is string => !!v);
}

function requestedSlugs(req: Request): string[] {
  const b = body(req);
  return [
    stringValue(b.slug),
    stringValue(b.workspaceSlug),
    stringValue(b.org),
    stringValue(req.params?.slug),
    stringValue(req.query?.slug),
    stringValue(req.query?.org),
  ].filter((v): v is string => !!v);
}

async function uidBelongsToGateway(
  db: Pick<Firestore, "collection">,
  uid: string,
  gatewayId: string,
): Promise<boolean> {
  const snap = await db.collection("users").doc(uid).get();
  if (!snap.exists) return false;
  const data = snap.data() as Record<string, unknown> | undefined;
  const provisioning = data?.provisioning as Record<string, unknown> | undefined;
  const openclaw = provisioning?.openclaw as Record<string, unknown> | undefined;
  return openclaw?.gatewayId === gatewayId;
}

async function flowBelongsToGateway(
  db: Pick<Firestore, "collection">,
  flowId: string,
  gatewayId: string,
): Promise<boolean> {
  const snap = await db.collection("byosubFlows").doc(flowId).get();
  if (!snap.exists) return false;
  const data = snap.data() as Record<string, unknown> | undefined;
  return data?.gatewayId === gatewayId;
}

async function slugBelongsToGateway(
  db: Pick<Firestore, "collection">,
  slug: string,
  gatewayId: string,
): Promise<boolean> {
  const slugs = await readAssignedSlugsForGateway(db, gatewayId);
  return slugs.includes(slug);
}

function routeAllowsInboundMigrationSlug(req: Request): boolean {
  return req.path === "/internal/gitea" || req.path.startsWith("/internal/gitea/");
}

async function slugAllowedForRequest(
  db: Pick<Firestore, "collection">,
  slug: string,
  gatewayId: string,
  req: Request,
): Promise<boolean> {
  if (await slugBelongsToGateway(db, slug, gatewayId)) return true;
  return (
    routeAllowsInboundMigrationSlug(req) &&
    hasRunningInboundMigrationForSlug(db, gatewayId, slug)
  );
}

async function gatewayBindingAuthorized(
  db: Pick<Firestore, "collection">,
  bound: GatewayBinding,
  req: Request,
): Promise<boolean> {
  const gatewayIds = requestedGatewayIds(req);
  if (gatewayIds.length > 0 && gatewayIds.some((gatewayId) => gatewayId !== bound.gatewayId)) {
    return false;
  }
  if (req.path === "/internal/connectors/access-token") {
    return true;
  }
  // The byok brokers carry only { agentId } / { id } and do their own scoping
  // (byosub-cred → glmGateways/{gatewayId}.byosub; api-key → the gateway's
  // assigned roster; agent-model-token → findAssignedUserByAgentId) — same shape
  // as the connector broker.
  if (
    req.path === "/internal/byok/byosub-cred" ||
    req.path === "/internal/byok/api-key" ||
    req.path === "/internal/byok/agent-model-token"
  ) {
    return true;
  }
  if (gatewayIds.length > 0) return true;

  const flowId = requestedFlowId(req);
  if (flowId) {
    return flowBelongsToGateway(db, flowId, bound.gatewayId);
  }

  const uids = requestedUids(req);
  if (uids.length > 0) {
    for (const uid of uids) {
      if (!(await uidBelongsToGateway(db, uid, bound.gatewayId))) return false;
    }
    return true;
  }

  const slugs = requestedSlugs(req);
  if (slugs.length > 0) {
    for (const slug of slugs) {
      if (!(await slugAllowedForRequest(db, slug, bound.gatewayId, req))) return false;
    }
    return true;
  }

  return false;
}

export function createTenantEnforcementMiddleware(
  opts: TenantEnforcementOptions = {},
): (req: Request, res: Response, next: NextFunction) => void {
  const db = opts.db ?? defaultDb;
  return (req, res, next) => {
    const bound = req.boundTenant;
    if (bound?.kind === "platform") {
      if (PLATFORM_INTERNAL_ROUTES.has(req.path)) {
        next();
      } else {
        res.status(403).json(FORBIDDEN);
      }
      return;
    }
    if (!bound || bound.kind !== "gateway") {
      res.status(403).json(FORBIDDEN);
      return;
    }

    gatewayBindingAuthorized(db, bound, req)
      .then((allowed) => {
        if (!allowed) {
          res.status(403).json(FORBIDDEN);
          return;
        }
        next();
      })
      .catch(() => {
        res.status(403).json(FORBIDDEN);
      });
  };
}
