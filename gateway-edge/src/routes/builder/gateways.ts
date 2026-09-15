import { Router, Request, Response, NextFunction } from "express";
import rateLimit from "express-rate-limit";
import { requireAuth } from "../../middleware/auth.js";
import { db, FieldValue, Timestamp } from "../../lib/db.js";
import {
  GatewayControlListEntry,
  GatewayControlListResponse,
} from "@octogee/shared/types/gateway-control";
import {
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
  OPENCLAW_CONTROL_TICKETS_COLLECTION,
  createOpenClawControlTicket,
} from "@octogee/core/openclaw-control-tickets";
import {
  isCanonicalWorkspaceMembership,
  resolveGatewayPrincipalAccess,
  workspacePermissionsEnabled,
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

function accessRole(access: ResolvedGatewayAccess): GatewayControlListEntry["via"] {
  return access.kind;
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
}): GatewayControlListEntry {
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
    capabilities: {
      dashboard: access.dashboard,
      workspaceManagement: access.workspaceManagement,
    },
  };
}

export interface GatewayWorkspaceScope {
  gatewayId: string;
  workspaceSlug: string;
  ownerUid: string;
}

export type DocumentReader = (path: string) => Promise<{ exists: boolean; data(): unknown }>;

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

export async function workspaceScopeFor(
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

export async function principalAccess(
  scope: GatewayWorkspaceScope,
  uid: string,
  get: DocumentReader,
): Promise<GatewayPrincipalAccess> {
  const { gatewayId, workspaceSlug, ownerUid } = scope;
  if (ownerUid === uid) return resolveGatewayPrincipalAccess({ gateway: scope, uid, membership: null });
  const [membershipSnap, workspaceSnap, gatewaySnap, ownerSnap] = await Promise.all([
    get(`workspaces/${workspaceSlug}/members/${uid}`),
    get(`workspaces/${workspaceSlug}`),
    get(`gateways/${gatewayId}`),
    get(`users/${ownerUid}`),
  ]);
  const workspace = record(workspaceSnap.data());
  return resolveGatewayPrincipalAccess({
    gateway: { gatewayId, ownerUid, workspaceSlug,
      perUserIdentity: workspaceSnap.exists && workspace?.ownerUid === ownerUid &&
        workspacePermissionsEnabled(gatewayAuthorizationFromRootDocument(gatewaySnap.data(), gatewayId)?.config ?? {}, ownerSnap.data() ?? {}),
    },
    uid,
    membership: membershipSnap.exists ? membershipSnap.data() : null,
  });
}

async function builderGatewayCandidates(uid: string) {
  const [userSnap, ownedSnap, membershipsSnap] = await Promise.all([
    db.doc(`users/${uid}`).get(),
    db.collection("gateways").where("ownerUid", "==", uid).get(),
    db.collectionGroup("members").where("id", "==", uid).get(),
  ]);
  const user = record(userSnap.exists ? userSnap.data() : undefined);
  const assignedOpenClaw = record(record(user?.provisioning)?.openclaw);
  const selfGatewayId = typeof assignedOpenClaw?.gatewayId === "string" ? assignedOpenClaw.gatewayId : null;
  const selfWorkspaceSlug = slugFromAssignedUser(user ?? undefined);
  const teamRoots = await Promise.all(membershipsSnap.docs.map(async (member) => {
    if (!isCanonicalWorkspaceMembership(member.data())) return null;
    const workspaceRef = member.ref.parent.parent;
    if (!workspaceRef || workspaceRef.parent.id !== "workspaces") return null;
    const workspace = await workspaceRef.get();
    const data = workspace.data();
    if (typeof data?.ownerUid !== "string") return null;
    const owner = await db.doc(`users/${data.ownerUid}`).get();
    const ownerData = owner.data();
    const gatewayId = record(record(ownerData?.provisioning)?.openclaw)?.gatewayId;
    if (typeof gatewayId !== "string" || !userAssignmentMatchesGateway(ownerData, gatewayId, workspace.id)) return null;
    const root = await db.doc(`gateways/${gatewayId}`).get();
    return root.exists ? { root, workspaceSlug: workspace.id } : null;
  }));
  const assignedRoot = selfGatewayId && selfWorkspaceSlug
    ? await db.doc(`gateways/${selfGatewayId}`).get()
    : null;
  return [
    ...ownedSnap.docs.map((root) => ({ root, workspaceSlug: root.data().builderSlug })),
    ...(assignedRoot?.exists && selfWorkspaceSlug
      ? [{ root: assignedRoot, workspaceSlug: selfWorkspaceSlug }]
      : []),
    ...teamRoots.filter((item): item is { root: typeof ownedSnap.docs[number]; workspaceSlug: string } => item !== null),
  ];
}

type BuilderGatewayCandidate = Awaited<ReturnType<typeof builderGatewayCandidates>>[number];

async function builderGatewayEntry(
  uid: string,
  candidate: BuilderGatewayCandidate,
): Promise<{ scopeKey: string; entry: GatewayControlListEntry } | null> {
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

async function builderGatewaysFor(uid: string): Promise<GatewayControlListEntry[]> {
  const seen = new Set<string>();
  const entries: GatewayControlListEntry[] = [];
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
      const body: GatewayControlListResponse = { gateways: await builderGatewaysFor(req.uid!) };
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
  if (access.kind === "denied" || !access.dashboard) return NOT_FOUND;
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
    if (principal.kind === "denied") {
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
    });
    tx.set(db.collection(OPENCLAW_CONTROL_TICKETS_COLLECTION).doc(minted.ticketHash), {
      ...minted.document,
      createdAt: FieldValue.serverTimestamp(),
      expireAt: Timestamp.fromMillis(minted.document.expiresAt),
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
