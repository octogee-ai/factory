import type { NextFunction, Request, Response } from "express";
import type { Firestore } from "firebase-admin/firestore";
import {
  hasRunningInboundMigrationForSlug,
  readAssignedSlugsForGateway,
} from "@octogee/core/assigned-roster";
import {
  configuredBuilderBootstrapAllowed,
} from "@octogee/core/gateway-live-release";
import { db as defaultDb } from "../../../gateway-edge/src/lib/db.js";
import { normalizeTenantPolicyPath } from "../lib/tenant-route-policy.js";

type GatewayBinding = Extract<Express.Request["boundTenant"], { kind: "gateway" }>;
type PlatformBinding = Extract<Express.Request["boundTenant"], { kind: "platform" }>;

export interface TenantEnforcementOptions {
  db?: Pick<Firestore, "collection">;
}

const FORBIDDEN = { error: "forbidden" } as const;

// The only internal routes a platform tenant (the octogee-cron KSA) may reach.
// Must stay in lockstep with the routes guarded by requireInternalPlatformAuth.
const PLATFORM_INTERNAL_ROUTES = new Set([
  "/internal/billing/check-trial-expiry",
  "/internal/billing/run-auto-top-ups",
  "/internal/notifications/digest",
  "/internal/activity-pairs/report",
]);

function platformBindingAuthorized(bound: PlatformBinding, path: string): boolean {
  if (bound.actor === "artifact-worker") {
    return path === "/internal/chat-artifacts" || path.startsWith("/internal/chat-artifacts/");
  }
  return PLATFORM_INTERNAL_ROUTES.has(path);
}

const SELF_SCOPED_INTERNAL_BROKER_ROUTES = new Set([
  "/internal/connectors/access-token",
  "/internal/byok/byosub-cred",
  "/internal/byok/api-key",
  "/internal/byok/agent-model-token",
  "/internal/byok/platform-embedding-key",
  "/internal/byok/byosub-flow",
  "/internal/byok/byosub-user",
  "/internal/byok/byosub-flow-read",
  "/internal/fleet/configured-builder-bootstrap",
  "/internal/openclaw-control/redeem",
  "/internal/openclaw-control/authorize",
  "/internal/openclaw-control/audit",
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

function routeRequiresTargetUserOwnership(req: Request): boolean {
  const path = normalizeTenantPolicyPath(req.path);
  return path === "/api/notifications/ingest" || path === "/internal/notifications/ingest";
}

async function slugAllowedForRequest(
  db: Pick<Firestore, "collection">,
  slug: string,
  bound: GatewayBinding,
  req: Request,
): Promise<boolean> {
  if (await slugBelongsToGateway(db, slug, bound.gatewayId)) return true;
  if (!routeAllowsInboundMigrationSlug(req)) return false;
  if (await hasRunningInboundMigrationForSlug(db, bound.gatewayId, slug)) return true;
  const gatewaySnap = await db.collection("gateways").doc(bound.gatewayId).get();
  const gateway = gatewaySnap.exists ? gatewaySnap.data() : undefined;
  return configuredBuilderBootstrapAllowed(gateway, {
    gatewayId: bound.gatewayId,
    podName: bound.podName,
    slug,
  });
}

async function allUidsBelongToGateway(
  db: Pick<Firestore, "collection">,
  uids: string[],
  gatewayId: string,
): Promise<boolean> {
  for (const uid of uids) {
    if (!(await uidBelongsToGateway(db, uid, gatewayId))) return false;
  }
  return true;
}

async function allSlugsAllowedForRequest(
  db: Pick<Firestore, "collection">,
  slugs: string[],
  bound: GatewayBinding,
  req: Request,
): Promise<boolean> {
  for (const slug of slugs) {
    if (!(await slugAllowedForRequest(db, slug, bound, req))) return false;
  }
  return true;
}

async function targetUsersAuthorizedForRequest(
  db: Pick<Firestore, "collection">,
  gatewayId: string,
  req: Request,
): Promise<boolean> {
  const uids = requestedUids(req);
  return uids.length > 0 && allUidsBelongToGateway(db, uids, gatewayId);
}

async function gatewayBindingAuthorized(
  db: Pick<Firestore, "collection">,
  bound: GatewayBinding,
  req: Request,
): Promise<boolean> {
  const gatewayIds = requestedGatewayIds(req);
  const requestTargetsDifferentGateway = gatewayIds.some((gatewayId) => gatewayId !== bound.gatewayId);
  if (gatewayIds.length > 0 && requestTargetsDifferentGateway) {
    return false;
  }
  if (routeRequiresTargetUserOwnership(req)) {
    return targetUsersAuthorizedForRequest(db, bound.gatewayId, req);
  }

  // These brokers perform route-specific authorization from their own body
  // shape. Keeping this as an explicit route allowlist avoids turning
  // gatewayId into a generic skeleton key for future internal routes.
  if (SELF_SCOPED_INTERNAL_BROKER_ROUTES.has(req.path)) {
    return true;
  }

  const uids = requestedUids(req);
  if (uids.length > 0 && !(await allUidsBelongToGateway(db, uids, bound.gatewayId))) {
    return false;
  }

  const slugs = requestedSlugs(req);
  if (slugs.length > 0 && !(await allSlugsAllowedForRequest(db, slugs, bound, req))) {
    return false;
  }

  if (uids.length > 0 || slugs.length > 0) {
    return true;
  }

  if (gatewayIds.length > 0) return true;

  const flowId = requestedFlowId(req);
  if (flowId) {
    return flowBelongsToGateway(db, flowId, bound.gatewayId);
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
      if (platformBindingAuthorized(bound, req.path)) {
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
