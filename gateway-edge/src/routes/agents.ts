import { Router, Request, Response, NextFunction } from "express";
import { requireAuth } from "../middleware/auth.js";
import { db, FieldValue } from "../lib/db.js";
import { platformStateStore } from "../lib/platform-state.js";
import { syncDefaultAgentIdentity } from "../lib/default-agent-identity.js";

const router = Router();

const ALLOWED_DEFAULT_AGENT_PATCH_FIELDS = ["name", "persona"] as const;
type DefaultAgentPatchField = (typeof ALLOWED_DEFAULT_AGENT_PATCH_FIELDS)[number];

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

function defaultAgentPatchFromBody(body: unknown): Partial<Record<DefaultAgentPatchField, string>> {
  const source = (body ?? {}) as Record<string, unknown>;
  const patch: Partial<Record<DefaultAgentPatchField, string>> = {};
  for (const key of ALLOWED_DEFAULT_AGENT_PATCH_FIELDS) {
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

    const patch = defaultAgentPatchFromBody(req.body);
    if (Object.keys(patch).length === 0) {
      res.status(400).json({ error: "no_valid_fields", allowed: ALLOWED_DEFAULT_AGENT_PATCH_FIELDS });
      return;
    }

    const updated = await syncDefaultAgentIdentity(uid, patch);

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

    const [userSnap, user] = await Promise.all([
      db.doc(`users/${request.targetUid}`).get(),
      platformStateStore.users.records.get(request.targetUid),
    ]);
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

    if (user?.agents.activatedAgents.includes(request.role)) {
      res.json({ status: "already_active", role: request.role });
      return;
    }

    await queueActivation(request);

    res.json({ status: "queued", role: request.role, tier });
  } catch (e) { next(e); }
});

export default router;
