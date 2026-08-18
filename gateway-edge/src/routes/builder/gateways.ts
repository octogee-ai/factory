import { Router, Request, Response, NextFunction } from "express";
import rateLimit from "express-rate-limit";
import { requireAuth } from "../../middleware/auth.js";
import { db, FieldValue, Timestamp } from "../../lib/db.js";
import {
  BuilderGatewayListEntry,
  BuilderGatewaysMeResponse,
} from "@octogee/shared/types/builder-shell";
import {
  isGatewayClassShellAccessEnabled,
  isGatewayClassControlUiAccessEnabled,
  isValidGatewayId,
  resolveGatewayClass,
  resolveGatewayImageProfile,
} from "@octogee/shared/types/glm";
import {
  readGatewayArtifact,
  readGatewayAuthorization,
  gatewayRuntimeHeartbeatOf,
  readGatewayRuntimeDoc,
  gatewayAuthorizationFromRootDocument,
  type GatewayAuthorization,
} from "@octogee/core/gateway-live-release";
import { projectOpenClawConfigStatus } from "../../lib/openclaw-config-status.js";
import {
  OPENCLAW_CONTROL_AUDIT_COLLECTION,
  OPENCLAW_CONTROL_TICKETS_COLLECTION,
  createOpenClawControlTicket,
} from "@octogee/core/openclaw-control-tickets";
import {
  GATEWAY_ACCESS_GRANTS_COLLECTION,
  gatewayAccessGrantId,
  isCanonicalWorkspaceMembership,
  resolveGatewayPrincipalAccess,
  type GatewayPrincipalAccess,
  type ResolvedGatewayAccess,
} from "@octogee/core/gateway-principal-access";
import { slugFromAssignedUser, userAssignmentMatchesGateway } from "@octogee/core/assigned-roster";
import { isOpenClawControlRevisionRuntimeReady } from "../../openclaw-control/runtime-ready.js";
import {
  recordGatewayAccessDenial,
  setGatewayAccessDenialAudit,
} from "../../lib/gateway-access-audit.js";
import type { FeaturePolicy, FeatureSubject } from "@octogee/shared/types/feature-flags";

const NOT_FOUND = "not-found";
const CAPABILITY_DISABLED = "capability-disabled";
const NOT_READY = "not-ready";

function accessRole(access: ResolvedGatewayAccess): BuilderGatewayListEntry["via"] {
  if (access.kind === "owner") return "owner";
  if (access.permissionSetIds.includes("co-owner.v1")) return "co-owner";
  if (access.permissionSetIds.includes("trusted-helper.v1")) return "trusted-helper";
  if (access.permissionSetIds.includes("agent-viewer.v1")) return "agent-viewer";
  return "shell-only";
}

const openClawTicketRateLimit = rateLimit({
  windowMs: 60_000,
  limit: 6,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => `${req.uid}:${req.params.gatewayId}`,
  message: { error: "ticket-rate-limited", retryable: true },
});

function builderViewOf({
  authorization,
  scope,
  access,
  imageTag,
  heartbeat,
  runtime,
  isCurrentAssignment,
}: {
  authorization: Extract<GatewayAuthorization, { kind: "durable" }>;
  scope: GatewayWorkspaceScope;
  access: ResolvedGatewayAccess;
  imageTag: string | undefined;
  heartbeat: Record<string, unknown> | null;
  runtime: unknown;
  isCurrentAssignment: boolean;
}): BuilderGatewayListEntry {
  const { gateway, config } = authorization;
  const explicitProfile = config.profile ?? undefined;
  const profile = explicitProfile ?? "standard";
  const gatewayClass = resolveGatewayClass({
    gatewayClass: config.gatewayClass,
    profile: explicitProfile,
    imageProfile: config.imageProfile,
  });
  const imageProfile = resolveGatewayImageProfile({
    gatewayClass,
    imageProfile: config.imageProfile,
    profile: explicitProfile,
  });
  const configStatus = projectOpenClawConfigStatus(heartbeat);
  const controlUiEnabled = access.dashboard && isGatewayClassControlUiAccessEnabled(
    gatewayClass,
    config.builderAccess ?? undefined,
  );
  return {
    gatewayId: gateway.gatewayId,
    workspaceSlug: scope.workspaceSlug,
    profile,
    gatewayClass,
    imageProfile,
    desiredStatus: gateway.desiredStatus,
    imageTag,
    shellsEnabled: access.shell && isGatewayClassShellAccessEnabled(
      gatewayClass,
      config.builderAccess ?? undefined,
    ),
    controlUiEnabled,
    controlUiReady: openClawControlReachable({
      authorization,
      runtime,
      controlUiEnabled,
      isCurrentAssignment,
    }),
    isCurrentAssignment,
    ...(configStatus ? { configStatus } : {}),
    via: accessRole(access),
    permissionSetIds: access.permissionSetIds,
    capabilities: {
      dashboard: access.dashboard,
      config: access.config,
      shell: access.shell,
      workspaceManagement: access.workspaceManagement,
    },
    grantRevision: access.grantRevision,
    accessExpiresAt: access.expiresAt === null
      ? null
      : new Date(access.expiresAt).toISOString(),
  };
}

interface GatewayWorkspaceScope {
  gatewayId: string;
  workspaceSlug: string;
  ownerUid: string;
}

type DocumentReader = (path: string) => Promise<{ exists: boolean; data(): unknown }>;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

type DurableGatewayAuthorization = Extract<GatewayAuthorization, { kind: "durable" }>;

function isSharedGateway(authorization: DurableGatewayAuthorization): boolean {
  return resolveGatewayClass({
    gatewayClass: authorization.config.gatewayClass,
    profile: authorization.config.profile ?? undefined,
    imageProfile: authorization.config.imageProfile,
  }) === "shared";
}

async function currentOwnerScope(
  get: DocumentReader,
  gatewayId: string,
  workspaceSlug: string,
  ownerUid: string,
): Promise<GatewayWorkspaceScope | null> {
  const owner = await get(`users/${ownerUid}`);
  return owner.exists && userAssignmentMatchesGateway(
    record(owner.data()) ?? undefined,
    gatewayId,
    workspaceSlug,
  )
    ? { gatewayId, workspaceSlug, ownerUid }
    : null;
}

async function privateGatewayWorkspaceScope(
  authorization: DurableGatewayAuthorization,
  workspaceSlug: string,
  get: DocumentReader,
): Promise<GatewayWorkspaceScope | null> {
  const { gatewayId } = authorization.gateway;
  const ownerUid = authorization.config.ownerUid;
  if (!ownerUid || authorization.config.builderSlug !== workspaceSlug) return null;
  return currentOwnerScope(get, gatewayId, workspaceSlug, ownerUid);
}

async function sharedGatewayWorkspaceScope(
  authorization: DurableGatewayAuthorization,
  workspaceSlug: string,
  get: DocumentReader,
): Promise<GatewayWorkspaceScope | null> {
  const { gatewayId } = authorization.gateway;
  const workspace = await get(`workspaces/${workspaceSlug}`);
  const ownerUid = record(workspace.exists ? workspace.data() : undefined)?.ownerUid;
  if (typeof ownerUid !== "string" || !ownerUid) return null;
  return currentOwnerScope(get, gatewayId, workspaceSlug, ownerUid);
}

async function workspaceScopeFor(
  authorization: DurableGatewayAuthorization,
  workspaceSlug: string | null | undefined,
  get: DocumentReader,
  requireCurrentOwnerAssignment = false,
): Promise<GatewayWorkspaceScope | null> {
  if (!workspaceSlug) return null;
  if (isSharedGateway(authorization)) {
    return sharedGatewayWorkspaceScope(authorization, workspaceSlug, get);
  }
  if (!requireCurrentOwnerAssignment) {
    const ownerUid = authorization.config.ownerUid;
    return ownerUid && authorization.config.builderSlug === workspaceSlug
      ? { gatewayId: authorization.gateway.gatewayId, workspaceSlug, ownerUid }
      : null;
  }
  return privateGatewayWorkspaceScope(authorization, workspaceSlug, get);
}

async function principalAccess(
  scope: GatewayWorkspaceScope,
  uid: string,
  get: DocumentReader,
  now = Date.now(),
): Promise<GatewayPrincipalAccess> {
  const { gatewayId, workspaceSlug, ownerUid } = scope;
  if (ownerUid === uid) {
    return resolveGatewayPrincipalAccess({
      gateway: { gatewayId, ownerUid, workspaceSlug },
      uid,
      grant: null,
      isWorkspaceMember: false,
      now,
    });
  }
  const [grantSnap, membershipSnap] = await Promise.all([
    get(`${GATEWAY_ACCESS_GRANTS_COLLECTION}/${gatewayAccessGrantId(gatewayId, workspaceSlug, uid)}`),
    get(`workspaces/${workspaceSlug}/members/${uid}`),
  ]);
  return resolveGatewayPrincipalAccess({
    gateway: { gatewayId, ownerUid, workspaceSlug },
    uid,
    grant: grantSnap.exists ? grantSnap.data() : null,
    isWorkspaceMember: membershipSnap.exists &&
      isCanonicalWorkspaceMembership(membershipSnap.data()),
    now,
  });
}

async function builderGatewayCandidates(uid: string) {
  const [userSnap, ownedSnap, grantSnap] = await Promise.all([
    db.doc(`users/${uid}`).get(),
    db.collection("gateways").where("ownerUid", "==", uid).get(),
    db.collection(GATEWAY_ACCESS_GRANTS_COLLECTION)
      .where("granteeUid", "==", uid)
      .where("state", "==", "active")
      .get(),
  ]);
  const user = record(userSnap.exists ? userSnap.data() : undefined);
  const assignedOpenClaw = record(record(user?.provisioning)?.openclaw);
  const selfGatewayId = typeof assignedOpenClaw?.gatewayId === "string" ? assignedOpenClaw.gatewayId : null;
  const selfWorkspaceSlug = slugFromAssignedUser(user ?? undefined);
  const delegatedRoots = await Promise.all(grantSnap.docs.map(async (grant) => {
    const data = grant.data() as Record<string, unknown>;
    if (typeof data.gatewayId !== "string" || typeof data.workspaceSlug !== "string") return null;
    const root = await db.doc(`gateways/${data.gatewayId}`).get();
    return root.exists ? { root, workspaceSlug: data.workspaceSlug } : null;
  }));
  const assignedRoot = selfGatewayId && selfWorkspaceSlug
    ? await db.doc(`gateways/${selfGatewayId}`).get()
    : null;
  return [
    ...ownedSnap.docs.map((root) => ({ root, workspaceSlug: root.data().builderSlug })),
    ...(assignedRoot?.exists && selfWorkspaceSlug
      ? [{ root: assignedRoot, workspaceSlug: selfWorkspaceSlug }]
      : []),
    ...delegatedRoots.filter((item): item is { root: typeof ownedSnap.docs[number]; workspaceSlug: string } => item !== null),
  ];
}

type BuilderGatewayCandidate = Awaited<ReturnType<typeof builderGatewayCandidates>>[number];

async function builderGatewayEntry(
  uid: string,
  candidate: BuilderGatewayCandidate,
): Promise<{ scopeKey: string; entry: BuilderGatewayListEntry } | null> {
  const authorization = gatewayAuthorizationFromRootDocument(candidate.root.data(), candidate.root.id);
  if (!authorization) return null;
  const scope = await workspaceScopeFor(
    authorization,
    typeof candidate.workspaceSlug === "string" ? candidate.workspaceSlug : null,
    (path) => db.doc(path).get(),
  );
  if (!scope) return null;
  const access = await principalAccess(scope, uid, (path) => db.doc(path).get());
  if (access.kind === "denied") return null;
  const [artifact, runtime, ownerAssignment] = await Promise.all([
    readGatewayArtifact(db, authorization.gateway.gatewayId, authorization.gateway.liveRelease),
    readGatewayRuntimeDoc(db, authorization.gateway),
    db.collection("users").doc(scope.ownerUid).get(),
  ]);
  const heartbeat = gatewayRuntimeHeartbeatOf(runtime, authorization.gateway);
  const isCurrentAssignment = ownerAssignment?.exists === true && userAssignmentMatchesGateway(
    ownerAssignment.data(),
    authorization.gateway.gatewayId,
    scope.workspaceSlug,
  );
  return {
    scopeKey: `${scope.gatewayId}\0${scope.workspaceSlug}`,
    entry: builderViewOf({
      authorization,
      scope,
      access,
      imageTag: artifact?.imageTag,
      heartbeat,
      runtime,
      isCurrentAssignment,
    }),
  };
}

async function builderGatewaysFor(uid: string): Promise<BuilderGatewayListEntry[]> {
  const seen = new Set<string>();
  const entries: BuilderGatewayListEntry[] = [];
  for (const candidate of await builderGatewayCandidates(uid)) {
    const result = await builderGatewayEntry(uid, candidate);
    if (!result || seen.has(result.scopeKey)) continue;
    seen.add(result.scopeKey);
    entries.push(result.entry);
  }
  return entries.sort((a, b) => a.gatewayId.localeCompare(b.gatewayId) ||
    a.workspaceSlug.localeCompare(b.workspaceSlug));
}

function registerGatewayListRoute(router: Router): void {
  router.get("/gateways/me", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body: BuilderGatewaysMeResponse = { gateways: await builderGatewaysFor(req.uid!) };
      res.json(body);
    } catch (err) {
      next(err);
    }
  });
}

function apiOrigin(): string {
  const configured = process.env.API_PUBLIC_URL?.trim();
  if (!configured) throw new Error("API_PUBLIC_URL is required for OpenClaw Dashboard launch URLs");
  return configured.replace(/\/$/u, "");
}

type TicketResult =
  | { kind: typeof NOT_FOUND }
  | { kind: typeof CAPABILITY_DISABLED }
  | { kind: typeof NOT_READY }
  | { kind: "minted"; minted: ReturnType<typeof createOpenClawControlTicket> };

function controlUiAccess(
  authorization: Extract<GatewayAuthorization, { kind: "durable" }>,
  access: GatewayPrincipalAccess,
): "allowed" | typeof NOT_FOUND | typeof CAPABILITY_DISABLED {
  if (access.kind === "denied" || !access.dashboard || !access.brokerProfile) return NOT_FOUND;
  const gatewayClass = resolveGatewayClass({
    gatewayClass: authorization.config.gatewayClass,
    profile: authorization.config.profile ?? undefined,
    imageProfile: authorization.config.imageProfile,
  });
  return isGatewayClassControlUiAccessEnabled(
    gatewayClass,
    authorization.config.builderAccess ?? undefined,
  ) ? "allowed" : CAPABILITY_DISABLED;
}

function denialAuditInput(
  scope: GatewayWorkspaceScope,
  uid: string,
  access: GatewayPrincipalAccess,
  reason: "permission_required" | Exclude<GatewayPrincipalAccess, ResolvedGatewayAccess>["reason"],
) {
  return {
    gatewayId: scope.gatewayId,
    workspaceSlug: scope.workspaceSlug,
    ownerUid: scope.ownerUid,
    actorUid: uid,
    granteeUid: uid,
    reason,
    source: "system" as const,
    now: Date.now(),
    beforePermissionSetIds: access.kind === "denied" ? [] : access.permissionSetIds,
    beforeRevision: access.kind === "denied" ? null : access.grantRevision,
  };
}

function requestedWorkspaceSlug(
  req: Request,
  authorization: Extract<GatewayAuthorization, { kind: "durable" }>,
): string | null {
  const requested = req.query.workspaceSlug;
  if (typeof requested === "string" && requested.length > 0) return requested;
  return isSharedGateway(authorization) ? null : authorization.config.builderSlug;
}

function servingRevisionId(
  authorization: Extract<GatewayAuthorization, { kind: "durable" }>,
): string | null {
  const { gateway } = authorization;
  if (gateway.desiredStatus !== "running" ||
    gateway.desiredRelease !== gateway.liveRelease ||
    typeof gateway.liveRelease !== "number") return null;
  return gateway.gatewayId;
}

function openClawControlRuntimeReachable(
  authorization: Extract<GatewayAuthorization, { kind: "durable" }>,
  runtime: unknown,
): boolean {
  const revisionId = servingRevisionId(authorization);
  if (!revisionId) return false;
  return isOpenClawControlRevisionRuntimeReady(runtime, {
    gatewayId: authorization.gateway.gatewayId,
    revisionId,
  });
}

/** Every condition `mintOpenClawTicket` would reject on, answered from the list. */
function openClawControlReachable(input: {
  authorization: Extract<GatewayAuthorization, { kind: "durable" }>;
  runtime: unknown;
  controlUiEnabled: boolean;
  isCurrentAssignment: boolean;
}): boolean {
  return input.controlUiEnabled &&
    input.isCurrentAssignment &&
    openClawControlRuntimeReachable(input.authorization, input.runtime);
}

async function mintOpenClawTicket(
  gatewayId: string,
  workspaceSlug: string,
  uid: string,
): Promise<TicketResult> {
  return db.runTransaction(async (tx) => {
    const rootSnap = await tx.get(db.doc(`gateways/${gatewayId}`));
    const serving = rootSnap.exists
      ? gatewayAuthorizationFromRootDocument(rootSnap.data(), gatewayId)
      : null;
    if (!serving) return { kind: NOT_READY };
    const scope = await workspaceScopeFor(
      serving,
      workspaceSlug,
      async (path) => {
        const snap = await tx.get(db.doc(path));
        return { exists: snap.exists, data: () => snap.data() };
      },
      true,
    );
    if (!scope) return { kind: NOT_FOUND };
    const principal = await principalAccess(
      scope,
      uid,
      async (path) => {
        const snap = await tx.get(db.doc(path));
        return { exists: snap.exists, data: () => snap.data() };
      },
    );
    if (principal.kind === "denied" || !principal.brokerProfile) {
      setGatewayAccessDenialAudit(db, tx, denialAuditInput(
        scope,
        uid,
        principal,
        principal.kind === "denied" ? principal.reason : "permission_required",
      ));
      return { kind: NOT_FOUND };
    }
    const access = controlUiAccess(serving, principal);
    if (access !== "allowed") return { kind: access };
    const revisionId = servingRevisionId(serving);
    if (!revisionId) return { kind: NOT_READY };
    const revisionSnap = await tx.get(db.doc(`glmGateways/${revisionId}`));
    if (!openClawControlRuntimeReachable(
      serving,
      revisionSnap.exists ? revisionSnap.data() : undefined,
    )) return { kind: NOT_READY };
    const minted = createOpenClawControlTicket({
      uid,
      gatewayId,
      workspaceSlug: scope.workspaceSlug,
      revisionId,
      brokerProfile: principal.brokerProfile,
      permissionSetIds: principal.permissionSetIds,
      grantRevision: principal.grantRevision,
    });
    tx.set(db.collection(OPENCLAW_CONTROL_TICKETS_COLLECTION).doc(minted.ticketHash), {
      ...minted.document,
      createdAt: FieldValue.serverTimestamp(),
      expireAt: Timestamp.fromMillis(minted.document.expiresAt),
    });
    tx.set(db.collection(OPENCLAW_CONTROL_AUDIT_COLLECTION).doc(), {
      gatewayId,
      workspaceSlug: scope.workspaceSlug,
      revisionId,
      uid,
      event: "ticket_mint",
      outcome: "ok",
      reason: "none",
      brokerProfile: principal.brokerProfile,
      permissionSetIds: principal.permissionSetIds,
      grantRevision: principal.grantRevision,
      createdAt: FieldValue.serverTimestamp(),
    });
    return { kind: "minted" as const, minted };
  });
}

async function openClawReleaseAllowed(
  req: Request,
  res: Response,
  authorization: Extract<GatewayAuthorization, { kind: "durable" }>,
  scope: GatewayWorkspaceScope,
  featurePolicy: FeaturePolicy | undefined,
): Promise<boolean> {
  if (!featurePolicy) return true;
  const subject: FeatureSubject = {
    uid: req.uid!,
    isAdmin: req.isAdmin === true,
    workspaceSlug: scope.workspaceSlug,
    gatewayClass: resolveGatewayClass({
      gatewayClass: authorization.config.gatewayClass,
      profile: authorization.config.profile ?? undefined,
      imageProfile: authorization.config.imageProfile,
    }),
    ...(authorization.config.profile ? { gatewayProfile: authorization.config.profile } : {}),
  };
  const decision = await featurePolicy.evaluate(
    "release-openclaw-dashboard",
    subject,
    "openclaw-dashboard",
  );
  if (decision.state === "disabled") {
    res.status(404).json({ error: "feature_unavailable" });
    return false;
  }
  if (decision.state === "unavailable") {
    res.status(503).json({ error: "feature_evaluation_unavailable" });
    return false;
  }
  return true;
}

function registerOpenClawTicketRoute(router: Router, featurePolicy: FeaturePolicy | undefined): void {
  router.post(
    "/gateways/:gatewayId/openclaw-ticket",
    openClawTicketRateLimit,
    async (req: Request, res: Response, next: NextFunction) => {
    try {
      const gatewayId = req.params.gatewayId;
      if (!isValidGatewayId(gatewayId)) {
        res.status(404).json({ error: "not-found" });
        return;
      }
      const uid = req.uid!;
      const authorization = await readGatewayAuthorization(db, gatewayId);
      if (!authorization) {
        res.status(404).json({ error: "not-found" });
        return;
      }
      const workspaceSlug = requestedWorkspaceSlug(req, authorization);
      if (!workspaceSlug) {
        res.status(404).json({ error: "not-found" });
        return;
      }
      const scope = await workspaceScopeFor(
        authorization,
        workspaceSlug,
        (path) => db.doc(path).get(),
        true,
      );
      if (!scope) {
        res.status(404).json({ error: "not-found" });
        return;
      }
      const principal = await principalAccess(
        scope,
        uid,
        (path) => db.doc(path).get(),
      );
      const access = controlUiAccess(authorization, principal);
      if (access === NOT_FOUND) {
        await recordGatewayAccessDenial(db, denialAuditInput(
          scope,
          uid,
          principal,
          principal.kind === "denied" ? principal.reason : "permission_required",
        ));
        res.status(404).json({ error: "not-found" });
        return;
      }
      if (access === CAPABILITY_DISABLED) {
        res.status(403).json({ error: CAPABILITY_DISABLED });
        return;
      }
      if (!(await openClawReleaseAllowed(req, res, authorization, scope, featurePolicy))) return;
      const result = await mintOpenClawTicket(gatewayId, scope.workspaceSlug, uid);
      if (result.kind === NOT_FOUND) {
        res.status(404).json({ error: "not-found" });
        return;
      }
      if (result.kind === CAPABILITY_DISABLED) {
        res.status(403).json({ error: CAPABILITY_DISABLED });
        return;
      }
      if (result.kind === NOT_READY) {
        res.status(409).json({ error: "gateway-not-ready", retryable: true });
        return;
      }
      res.status(201).json({
        launchUrl: `${apiOrigin()}/g/${gatewayId}/openclaw/launch/${result.minted.ticket}`,
        expiresAt: result.minted.document.expiresAt,
      });
    } catch (err) {
      next(err);
    }
  },
    );
}

export function createBuilderGatewayRoutes({ featurePolicy }: { featurePolicy?: FeaturePolicy } = {}): Router {
  const router = Router();
  router.use(requireAuth);
  registerGatewayListRoute(router);
  registerOpenClawTicketRoute(router, featurePolicy);
  return router;
}

export default createBuilderGatewayRoutes();
