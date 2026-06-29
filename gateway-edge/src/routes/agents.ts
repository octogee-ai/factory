import { Router, Request, Response, NextFunction } from "express";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { logger } from "../middleware/logging.js";
import { db, FieldValue } from "../lib/db.js";
import { syncCoachIdentity } from "../lib/coach-identity.js";

const router = Router();

const ALLOWED_COACH_PATCH_FIELDS = ["name", "persona"] as const;
type CoachPatchField = (typeof ALLOWED_COACH_PATCH_FIELDS)[number];

interface RouteError {
  status: number;
  body: Record<string, unknown>;
}

function routeError(status: number, body: Record<string, unknown>): RouteError {
  return { status, body };
}

function isRouteError<T>(value: T | RouteError): value is RouteError {
  return typeof (value as RouteError).status === "number" && "body" in (value as RouteError);
}

function sendRouteError(res: Response, error: RouteError): void {
  res.status(error.status).json(error.body);
}

function coachPatchFromBody(body: unknown): Partial<Record<CoachPatchField, string>> {
  const source = (body ?? {}) as Record<string, unknown>;
  const patch: Partial<Record<CoachPatchField, string>> = {};
  for (const key of ALLOWED_COACH_PATCH_FIELDS) {
    const value = source[key];
    if (typeof value === "string") patch[key] = value;
  }
  return patch;
}

router.patch("/me", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const uid = req.uid;
    if (!uid) {
      res.status(401).json({ error: "unauthenticated" });
      return;
    }

    const patch = coachPatchFromBody(req.body);
    if (Object.keys(patch).length === 0) {
      res.status(400).json({ error: "no_valid_fields", allowed: ALLOWED_COACH_PATCH_FIELDS });
      return;
    }

    const updated = await syncCoachIdentity(uid, patch);

    res.json({ ok: true, updated });
  } catch (e) { next(e); }
});

const SPECIALIST_ROLES = ["alex", "morgan", "riley", "robert"] as const;
type SpecialistRole = (typeof SPECIALIST_ROLES)[number];

const TIER_CREW_ACCESS: Record<string, readonly string[]> = {
  starter: ["coach"],
  pro: ["coach", "alex", "riley"],
  business: ["coach", "alex", "morgan", "riley", "robert"],
  trial: ["coach", "alex", "morgan", "riley", "robert"],
  free: ["coach"],
};

const AGENT_ID_RE = /^octogee-([a-z0-9-]+)-(coach|alex|morgan|riley|robert)$/;
const SLUG_PREFIX_RE = /^octogee-([a-z0-9-]+)$/;
const ALL_ROLES = ["coach", "alex", "morgan", "riley", "robert"] as const;

interface ActivateBody {
  uid?: string;
  role?: string;
  requestedBy?: unknown;
}

interface ActivationRequest {
  targetUid: string;
  role: SpecialistRole;
  requestedBy: unknown;
}

function isSpecialistRole(role: unknown): role is SpecialistRole {
  return typeof role === "string" && SPECIALIST_ROLES.includes(role as SpecialistRole);
}

function parseActivationRequest(req: Request): ActivationRequest | RouteError {
  const { uid, role, requestedBy } = (req.body ?? {}) as ActivateBody;
  const targetUid = req.isAdmin && uid ? uid : req.uid;
  if (!targetUid) {
    return routeError(401, { error: "unauthenticated" });
  }
  if (uid && uid !== targetUid) {
    return routeError(403, { error: "cannot_activate_other_user" });
  }
  if (!role) {
    return routeError(400, { error: "missing_fields", required: ["role"] });
  }
  if (!isSpecialistRole(role)) {
    return routeError(400, { error: "invalid_role", role, allowed: SPECIALIST_ROLES });
  }
  return { targetUid, role, requestedBy: requestedBy ?? "coach" };
}

function tierForUser(userData: FirebaseFirestore.DocumentData): string {
  return userData.subscription?.tier ?? userData.tier ?? "starter";
}

function allowedRolesForTier(tier: string): readonly string[] {
  return TIER_CREW_ACCESS[tier] ?? TIER_CREW_ACCESS["starter"];
}

function activatedAgentsForUser(userData: FirebaseFirestore.DocumentData): string[] {
  return userData.provisioning?.openclaw?.activatedAgents ?? [];
}

async function queueActivation(request: ActivationRequest): Promise<void> {
  await db.doc(`users/${request.targetUid}`).update({
    "provisioning.pendingActivations": FieldValue.arrayUnion(request.role),
    "provisioning.pendingActivationRequestedAt": FieldValue.serverTimestamp(),
    "provisioning.pendingActivationRequestedBy": request.requestedBy,
  });
}

router.post("/activate", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const request = parseActivationRequest(req);
    if (isRouteError(request)) {
      sendRouteError(res, request);
      return;
    }

    const userSnap = await db.doc(`users/${request.targetUid}`).get();
    if (!userSnap.exists) {
      res.status(404).json({ error: "user_not_found", uid: request.targetUid });
      return;
    }
    const userData = userSnap.data()!;

    const tier = tierForUser(userData);
    const allowedRoles = allowedRolesForTier(tier);
    if (!allowedRoles.includes(request.role)) {
      res.status(403).json({ error: "tier_not_allowed", tier, role: request.role, allowedRoles });
      return;
    }

    if (activatedAgentsForUser(userData).includes(request.role)) {
      res.json({ status: "already_active", role: request.role });
      return;
    }

    await queueActivation(request);

    res.json({ status: "queued", role: request.role, tier });
  } catch (e) { next(e); }
});

interface DeprovisionBody {
  slugPrefix?: string;
  agentId?: string;
  deleteWorkspace?: boolean;
}

interface DeprovisionTarget {
  slug: string;
  targetAgentIds: string[];
}

interface DiscordCleanupContext {
  discordChannelId: string | null;
  discordAdminChannelId: string | null;
  uid: string | null;
}

function parseSlugPrefixTarget(slugPrefix: string): DeprovisionTarget | RouteError {
  const match = SLUG_PREFIX_RE.exec(slugPrefix);
  if (!match) {
    return routeError(400, { error: "invalid_format", message: "slugPrefix must be: octogee-{slug}" });
  }
  const slug = match[1];
  return {
    slug,
    targetAgentIds: ALL_ROLES.map((role) => `octogee-${slug}-${role}`),
  };
}

function parseAgentIdTarget(agentId: string): DeprovisionTarget | RouteError {
  const match = AGENT_ID_RE.exec(agentId);
  if (!match) {
    return routeError(400, { error: "invalid_format", message: "agentId must be: octogee-{slug}-{role}" });
  }
  return {
    slug: match[1],
    targetAgentIds: [agentId],
  };
}

function parseDeprovisionTarget(body: DeprovisionBody): DeprovisionTarget | RouteError {
  if (!body.slugPrefix && !body.agentId) {
    return routeError(400, {
      error: "missing_fields",
      message: "Provide either slugPrefix or agentId",
    });
  }
  return body.slugPrefix
    ? parseSlugPrefixTarget(body.slugPrefix)
    : parseAgentIdTarget(body.agentId!);
}

async function readDiscordCleanupContext(slug: string): Promise<DiscordCleanupContext> {
  try {
    const bySlug = await db.collection("users").where("workspaceSlug", "==", slug).limit(1).get();
    if (bySlug.empty) {
      return { discordChannelId: null, discordAdminChannelId: null, uid: null };
    }
    const userData = bySlug.docs[0].data();
    return {
      uid: bySlug.docs[0].id,
      discordChannelId: userData.discord?.channelId ?? userData.provisioning?.discord?.channels?.octogee ?? null,
      discordAdminChannelId: userData.provisioning?.discord?.channels?.admin ?? null,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`deprovisionAgents: Firestore lookup failed (non-fatal): ${msg}`);
    return { discordChannelId: null, discordAdminChannelId: null, uid: null };
  }
}

function cleanupJobData(
  jobId: string,
  target: DeprovisionTarget,
  deleteWorkspace: boolean,
  context: DiscordCleanupContext
): Record<string, unknown> {
  return {
    jobId,
    slug: target.slug,
    slugPrefix: `octogee-${target.slug}`,
    targetAgentIds: target.targetAgentIds,
    deleteWorkspace,
    discordChannelId: context.discordChannelId,
    discordAdminChannelId: context.discordAdminChannelId,
    uid: context.uid,
    status: "pending",
    requestedAt: FieldValue.serverTimestamp(),
    requestedBy: "admin",
    completedAt: null,
    error: null,
  };
}

router.post("/deprovision", requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = (req.body ?? {}) as DeprovisionBody;
    const target = parseDeprovisionTarget(body);
    if (isRouteError(target)) {
      sendRouteError(res, target);
      return;
    }

    const context = await readDiscordCleanupContext(target.slug);
    const jobId = `${target.slug}-${Date.now()}`;
    await db.collection("cleanupJobs").doc(jobId).set(
      cleanupJobData(jobId, target, !!body.deleteWorkspace, context)
    );

    res.json({
      status: "queued",
      jobId,
      slug: target.slug,
      targetAgentIds: target.targetAgentIds,
      discordChannelId: context.discordChannelId,
      discordAdminChannelId: context.discordAdminChannelId,
      message: "Cleanup job queued. The gateway provisioner will process it within seconds.",
    });
  } catch (e) { next(e); }
});

export default router;
