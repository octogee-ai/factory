import type { NextFunction, Request, Response } from "express";
import type { Firestore } from "firebase-admin/firestore";
import {
  hasRunningInboundMigrationForSlug,
  readAssignedSlugsForGateway,
} from "@octogee/core/assigned-roster";
import {
  configuredBuilderBootstrapAllowed,
} from "@octogee/core/gateway-live-release";
import { RETIRED_COMPUTER_BINDING_DENIAL_REASON } from "@octogee/shared/types/fleet-broker";
import { db as defaultDb } from "../../../gateway-edge/src/lib/db.js";
import { normalizeTenantPolicyPath } from "../lib/tenant-route-policy.js";
import { logger } from "../../../gateway-edge/src/middleware/logging.js";
import {
  createTenantDenialReporter,
  type TenantDenial,
  type TenantDenialCause,
  type TenantDenialReporter,
  type TenantDenialTenant,
} from "./tenant-denial.js";

type GatewayBinding = Extract<Express.Request["boundTenant"], { kind: "gateway" }>;
type PlatformBinding = Extract<Express.Request["boundTenant"], { kind: "platform" }>;

export interface TenantEnforcementOptions {
  db?: Pick<Firestore, "collection">;
  onDenied?: TenantDenialReporter;
}

// The only internal routes a platform tenant (the octogee-cron KSA) may reach.
// Must stay in lockstep with the routes guarded by requireInternalPlatformAuth.
const PLATFORM_INTERNAL_ROUTES = new Set([
  "/internal/billing/check-trial-expiry",
  "/internal/billing/run-auto-top-ups",
  "/internal/notifications/digest",
  "/internal/notifications/social",
]);

function platformBindingAuthorized(bound: PlatformBinding, path: string): boolean {
  if (bound.actor === "artifact-worker") {
    return path === "/internal/chat-artifacts" || path.startsWith("/internal/chat-artifacts/");
  }
  if (bound.actor === "llm-broker") {
    return path === "/internal/product-analytics/events";
  }
  if (bound.actor === "npm-cache-proxy") {
    return path === "/internal/fleet/npm-cache-authorize";
  }
  return PLATFORM_INTERNAL_ROUTES.has(path);
}

// Exported so agent-productivity-enforcement.spec.ts can pin this allowlist
// in lockstep with the route manifest createAgentProductivityRoutes exports —
// exact strings on both sides; this list is never merged or prefix-matched.
export const SELF_SCOPED_INTERNAL_BROKER_ROUTES = new Set([
  "/internal/fleet/blob/materialization/read-url",
  "/internal/fleet/blob/materialization/manifest/read-url",
  "/internal/computer/agent-context",
  "/internal/connectors/access-token",
  "/internal/connectors/github-project-clone-access",
  "/internal/byok/agent-usage-status",
  "/internal/byok/byosub-cred",
  "/internal/byok/byosub-cred-syncback",
  "/internal/byok/api-key",
  "/internal/byok/agent-model-token",
  "/internal/byok/byosub-flow",
  "/internal/byok/byosub-user",
  "/internal/byok/byosub-flow-read",
  "/internal/fleet/configured-builder-bootstrap",
  "/internal/fleet/npm-registry-credentials",
  "/internal/fleet/user-snapshot",
  "/internal/fleet/builder-runtime-state/download-url",
  "/internal/fleet/builder-runtime-state/snapshot-urls",
  "/internal/fleet/builder-runtime-state/prune",
  "/internal/fleet/computer-home/checkpoint-url",
  "/internal/fleet/computer-home/commit",
  "/internal/fleet/computer-home/download-url",
  "/internal/fleet/computer-home/prune",
  "/internal/fleet/openclaw-boot/claim",
  "/internal/fleet/openclaw-boot/healthy",
  "/internal/fleet/uid-for-slug",
  "/internal/fleet/vm-runtime",
  "/internal/fleet/computer-egress",
  "/internal/openclaw-control/redeem",
  "/internal/openclaw-control/authorize",
  "/internal/openclaw-control/profile",
  "/internal/openclaw-control/tool-conversation",
  "/internal/voice/conversation",
  "/internal/voice/turn",
  "/internal/voice/bind",
  "/internal/voice/end",
  "/internal/openclaw-control/mattermost/authorize",
  "/internal/openclaw-control/mattermost/channels",
  "/internal/workspace-git/authorize",
  "/internal/channel-agent-readiness/authorize",
  "/internal/openclaw/notifications/final-reply",
  "/internal/openclaw/activity/session-context",
  "/internal/openclaw/activity/dispatch-context",
  "/internal/agent-support/ask",
  "/internal/openclaw/previews/authorize",
  "/internal/agent-projects/create",
  "/internal/agent-projects/list",
  "/internal/agent-projects/set-recipe",
  "/internal/agent-projects/delegate",
  "/internal/agent-projects/identity",
  "/internal/project-runs/capability",
  "/internal/project-runs/start",
  "/internal/project-runs/status",
  "/internal/openclaw/project-publish",
  "/internal/agent-board/list",
  "/internal/agent-board/card-read",
  "/internal/agent-board/card-create",
  "/internal/agent-board/card-update",
  "/internal/agent-board/card-move",
  "/internal/agent-board/card-comment",
  "/internal/agent-productivity/google/calendar/events",
  "/internal/agent-productivity/google/gmail/search",
  "/internal/agent-productivity/google/gmail/read",
  "/internal/agent-productivity/google/gmail/triage",
  "/internal/agent-productivity/google/gmail/drafts/create",
  "/internal/agent-productivity/google/gmail/send",
  "/internal/agent-productivity/google/drive/search",
  "/internal/agent-productivity/google/drive/read",
  "/internal/agent-productivity/google/docs/create",
  "/internal/agent-productivity/google/docs/read",
  "/internal/agent-productivity/google/docs/append",
  "/internal/agent-productivity/google/contacts/search",
  "/internal/agent-productivity/google/calendar/events/create",
  "/internal/agent-productivity/google/calendar/events/update",
  "/internal/agent-productivity/google/calendar/events/delete",
  "/internal/agent-productivity/google/tasks/list",
  "/internal/agent-productivity/google/tasks/create",
  "/internal/agent-productivity/google/tasks/update",
  "/internal/agent-productivity/google/sheets/create",
  "/internal/agent-productivity/google/sheets/read",
  "/internal/agent-productivity/google/sheets/append",
  "/internal/agent-productivity/obsidian/notes/list",
  "/internal/agent-productivity/obsidian/notes/search",
  "/internal/agent-productivity/obsidian/notes/read",
  "/internal/agent-productivity/obsidian/notes/write",
]);

export const FINAL_HOME_CHECKPOINT_ROUTES = new Set([
  "/internal/fleet/vm-runtime",
  "/internal/fleet/computer-home/checkpoint-url",
  "/internal/fleet/computer-home/commit",
  "/internal/fleet/computer-home/prune",
]);

function isSelfScopedInternalBrokerRoute(path: string): boolean {
  return SELF_SCOPED_INTERNAL_BROKER_ROUTES.has(path) ||
    path === "/internal/agent-imports" || path.startsWith("/internal/agent-imports/");
}

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
  if (snap.exists) {
    const data = snap.data() as Record<string, unknown> | undefined;
    const provisioning = data?.provisioning as Record<string, unknown> | undefined;
    const openclaw = provisioning?.openclaw as Record<string, unknown> | undefined;
    if (openclaw?.gatewayId === gatewayId) return true;
  }
  return uidHoldsDisposableClaim(db, uid, gatewayId);
}

// The user mirror only names a disposable builder once activation finishes, and
// activation cannot finish without the bootstrap calls this check guards. The
// gateway's own allocation is the platform-written record of that pending
// binding, so an active claim binds the uid for exactly as long as it stands.
// Both the claim and the owner must name the uid, and a retired gateway's
// leftover claim binds nothing.
async function uidHoldsDisposableClaim(
  db: Pick<Firestore, "collection">,
  uid: string,
  gatewayId: string,
): Promise<boolean> {
  const snap = await db.collection("gateways").doc(gatewayId).get();
  if (!snap.exists) return false;
  const gateway = snap.data() as Record<string, unknown> | undefined;
  if (!gateway || gateway.desiredStatus === "retired") return false;
  const allocation = gateway.allocation as Record<string, unknown> | undefined;
  return (
    allocation?.kind === "disposable-builder" &&
    allocation.claimedByUid === uid &&
    gateway.ownerUid === uid
  );
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

function routeIsPlatformWideNotificationProducer(req: Request): boolean {
  return normalizeTenantPolicyPath(req.path) === "/internal/notifications/social";
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

async function uidsAllowedForRequest(
  db: Pick<Firestore, "collection">,
  uids: string[],
  gatewayId: string,
  req: Request,
): Promise<boolean> {
  if (routeRequiresTargetUserOwnership(req) && uids.length === 0) return false;
  return uids.length === 0 || allUidsBelongToGateway(db, uids, gatewayId);
}

async function gatewayDenialReason(
  db: Pick<Firestore, "collection">,
  bound: GatewayBinding,
  req: Request,
): Promise<string | null> {
  const gatewayIds = requestedGatewayIds(req);
  const requestTargetsDifferentGateway = gatewayIds.some((gatewayId) => gatewayId !== bound.gatewayId);
  if (gatewayIds.length > 0 && requestTargetsDifferentGateway) {
    return "request names a gatewayId other than the bound gateway";
  }
  if (routeIsPlatformWideNotificationProducer(req)) {
    return "route is platform-only";
  }
  if (bound.finalHomeCheckpoint) {
    return FINAL_HOME_CHECKPOINT_ROUTES.has(req.path)
      ? null
      : RETIRED_COMPUTER_BINDING_DENIAL_REASON;
  }

  // These brokers perform route-specific authorization from their own body
  // shape. Keeping this as an explicit route allowlist avoids turning
  // gatewayId into a generic skeleton key for future internal routes.
  if (isSelfScopedInternalBrokerRoute(req.path)) {
    return null;
  }
  return targetedDenialReason(db, bound, req, gatewayIds.length > 0);
}

async function targetedDenialReason(
  db: Pick<Firestore, "collection">,
  bound: GatewayBinding,
  req: Request,
  namesBoundGateway: boolean,
): Promise<string | null> {
  const uids = requestedUids(req);
  if (!(await uidsAllowedForRequest(db, uids, bound.gatewayId, req))) {
    return "request names a user not assigned to the bound gateway";
  }

  const slugs = requestedSlugs(req);
  if (slugs.length > 0 && !(await allSlugsAllowedForRequest(db, slugs, bound, req))) {
    return "request names a workspace slug not assigned to the bound gateway";
  }

  const flowId = requestedFlowId(req);
  if (flowId && !(await flowBelongsToGateway(db, flowId, bound.gatewayId))) {
    return "request names a flow owned by another gateway";
  }

  return uids.length > 0 || slugs.length > 0 || namesBoundGateway || flowId !== null
    ? null
    : "route is not admitted for gateway tenants and the request names no owned user, slug, gateway, or flow";
}

const PLACEMENT_DENIAL_REASONS: ReadonlySet<string> = new Set([
  "request names a gatewayId other than the bound gateway",
  "request names a user not assigned to the bound gateway",
  "request names a workspace slug not assigned to the bound gateway",
  RETIRED_COMPUTER_BINDING_DENIAL_REASON,
]);

export function tenantDenialCause(reason: string): TenantDenialCause {
  return PLACEMENT_DENIAL_REASONS.has(reason) ? "placement" : "policy";
}

function denialTenant(bound: Express.Request["boundTenant"]): TenantDenialTenant {
  if (bound?.kind === "gateway") {
    return { kind: "gateway", gatewayId: bound.gatewayId, ...(bound.ownerUid ? { ownerUid: bound.ownerUid } : {}) };
  }
  if (bound?.kind === "platform") return { kind: "platform", actor: bound.actor };
  return { kind: "unbound" };
}

function requestedAgentId(req: Request): string | null {
  return stringValue(body(req).agentId);
}

export function createTenantEnforcementMiddleware(
  opts: TenantEnforcementOptions = {},
): (req: Request, res: Response, next: NextFunction) => void {
  const db = opts.db ?? defaultDb;
  const onDenied = opts.onDenied ?? createTenantDenialReporter({ db });
  const deny = (req: Request, res: Response, reason: string): void => {
    const denial: TenantDenial = {
      method: req.method,
      path: req.path,
      reason,
      cause: tenantDenialCause(reason),
      tenant: denialTenant(req.boundTenant),
      agentId: requestedAgentId(req),
    };
    onDenied(denial).catch((error: unknown) => {
      logger.error("[tenant-enforcement] denial reporter threw", { ...denial, error });
    });
    res.status(403).json({ error: `forbidden: ${reason}`, code: "tenant-enforcement" });
  };
  return (req, res, next) => {
    const bound = req.boundTenant;
    if (bound?.kind === "platform") {
      if (platformBindingAuthorized(bound, req.path)) {
        next();
      } else {
        deny(req, res, `platform actor ${bound.actor} is not admitted on this route`);
      }
      return;
    }
    if (!bound || bound.kind !== "gateway") {
      deny(req, res, "request carries no gateway tenant binding");
      return;
    }

    gatewayDenialReason(db, bound, req)
      .then((reason) => {
        if (reason !== null) {
          deny(req, res, reason);
          return;
        }
        next();
      })
      .catch((error: unknown) => {
        deny(req, res, `authorization check failed: ${error instanceof Error ? error.message : String(error)}`);
      });
  };
}
