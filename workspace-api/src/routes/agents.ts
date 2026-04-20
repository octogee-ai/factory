/**
 * Agent routes — activation, deprovisioning, and per-Builder coach updates.
 *
 * Mounted at both /api/agents (public via Ingress, requireAuth) and
 * /internal/agents (K8s DNS only, requireAgentKey / requireAdmin). Each
 * route picks its own auth middleware.
 */
import { Router, Request, Response, NextFunction } from "express";
import { requireAuth, requireAgentKey, requireAdmin } from "../middleware/auth";
import { logger } from "../middleware/logging";
import { db, FieldValue } from "../lib/db";
import { readAgent } from "../lib/firestoreReads";
import { mmApi } from "../lib/mattermost";

const router = Router();

// Coach MM patches only touch user-visible fields; the stable `{username}-coach`
// MM username is never changed.
const ALLOWED_COACH_PATCH_FIELDS = ["name", "persona", "avatarEmoji"] as const;
type CoachPatchField = (typeof ALLOWED_COACH_PATCH_FIELDS)[number];

// ── PATCH /me — update the caller's agent (coach) identity ────────────────
// Settings UI writes here. Updates agents/{uid} and patches the coach MM
// user's nickname + first_name when `name` changes.

router.patch("/me", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const uid = req.uid;
    if (!uid) {
      res.status(401).json({ error: "unauthenticated" });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    for (const key of ALLOWED_COACH_PATCH_FIELDS) {
      const v = body[key];
      if (typeof v === "string") patch[key] = v;
    }
    if (Object.keys(patch).length === 0) {
      res.status(400).json({ error: "no_valid_fields", allowed: ALLOWED_COACH_PATCH_FIELDS });
      return;
    }

    // Update Firestore first so the doc is the source of truth even if the
    // MM patch below fails.
    await db.doc(`agents/${uid}`).set(
      { id: uid, ...patch, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );

    // Sync display fields to MM when `name` changed. MM username stays stable.
    if (typeof patch.name === "string" && patch.name) {
      try {
        const agent = await readAgent(uid);
        const coachMmUserId = agent?.mattermost.userId;
        if (coachMmUserId) {
          await mmApi(`/users/${coachMmUserId}/patch`, "PUT", {
            first_name: patch.name,
            nickname: patch.name,
          });
        }
      } catch (err) {
        // MM patch is best-effort. The next milestone sweep or a retry will
        // reconcile if this fails.
        logger.warn("coach MM patch failed (non-fatal)", {
          uid,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    res.json({ ok: true, updated: Object.keys(patch) as CoachPatchField[] });
  } catch (e) { next(e); }
});

// ── Types ──────────────────────────────────────────────────────────────────

type SpecialistRole = "alex" | "morgan" | "riley" | "robert";
const SPECIALIST_ROLES: SpecialistRole[] = ["alex", "morgan", "riley", "robert"];

const TIER_CREW_ACCESS: Record<string, string[]> = {
  starter: ["coach"],
  pro: ["coach", "alex", "riley"],
  business: ["coach", "alex", "morgan", "riley", "robert"],
  trial: ["coach", "alex", "morgan", "riley", "robert"],
  free: ["coach"],
};

const AGENT_ID_RE = /^octogee-([a-z0-9-]+)-(coach|alex|morgan|riley|robert)$/;
const SLUG_PREFIX_RE = /^octogee-([a-z0-9-]+)$/;
const ALL_ROLES = ["coach", "alex", "morgan", "riley", "robert"] as const;

// ── POST /activate — activate a specialist agent ──────────────────────────

router.post("/activate", requireAgentKey, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { uid, role, requestedBy } = req.body as { uid?: string; role?: string; requestedBy?: string };

    if (!uid || !role) {
      res.status(400).json({ error: "missing_fields", required: ["uid", "role"] });
      return;
    }

    if (!SPECIALIST_ROLES.includes(role as SpecialistRole)) {
      res.status(400).json({ error: "invalid_role", role, allowed: SPECIALIST_ROLES });
      return;
    }

    // Validate API key belongs to this uid
    const agentKey = (req as Request & { agentKey?: string }).agentKey;
    const apiSettingsSnap = await db.doc(`users/${uid}/settings/api`).get();
    if (!apiSettingsSnap.exists) {
      res.status(401).json({ error: "unauthorized", message: "No API key on record" });
      return;
    }
    const storedKey = apiSettingsSnap.data()?.apiKey;
    if (!storedKey || storedKey !== agentKey) {
      res.status(401).json({ error: "unauthorized", message: "Invalid API key" });
      return;
    }

    const userSnap = await db.doc(`users/${uid}`).get();
    if (!userSnap.exists) {
      res.status(404).json({ error: "user_not_found", uid });
      return;
    }
    const userData = userSnap.data()!;

    const tier: string = userData.subscription?.tier ?? userData.tier ?? "starter";
    const allowedRoles = TIER_CREW_ACCESS[tier] ?? TIER_CREW_ACCESS["starter"];

    if (!allowedRoles.includes(role)) {
      res.status(403).json({ error: "tier_not_allowed", tier, role, allowedRoles });
      return;
    }

    const activatedAgents: string[] = userData.provisioning?.openclaw?.activatedAgents ?? [];
    if (activatedAgents.includes(role)) {
      res.json({ status: "already_active", role });
      return;
    }

    await db.doc(`users/${uid}`).update({
      "provisioning.pendingActivations": FieldValue.arrayUnion(role),
      "provisioning.pendingActivationRequestedAt": FieldValue.serverTimestamp(),
      "provisioning.pendingActivationRequestedBy": requestedBy ?? "coach",
    });

    res.json({ status: "queued", role, tier });
  } catch (e) { next(e); }
});

// ── POST /deprovision — queue agent cleanup job ───────────────────────────
// Auth: requireAdmin (was Cloud Run IAM — now public via GKE Ingress)

router.post("/deprovision", requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { slugPrefix, agentId, deleteWorkspace = false } = req.body as {
      slugPrefix?: string;
      agentId?: string;
      deleteWorkspace?: boolean;
    };

    if (!slugPrefix && !agentId) {
      res.status(400).json({
        error: "missing_fields",
        message: "Provide either slugPrefix or agentId",
      });
      return;
    }

    let slug: string;
    let targetAgentIds: string[];

    if (slugPrefix) {
      const m = SLUG_PREFIX_RE.exec(slugPrefix);
      if (!m) {
        res.status(400).json({ error: "invalid_format", message: "slugPrefix must be: octogee-{slug}" });
        return;
      }
      slug = m[1];
      targetAgentIds = ALL_ROLES.map((r) => `octogee-${slug}-${r}`);
    } else {
      const m = AGENT_ID_RE.exec(agentId!);
      if (!m) {
        res.status(400).json({ error: "invalid_format", message: "agentId must be: octogee-{slug}-{role}" });
        return;
      }
      slug = m[1];
      targetAgentIds = [agentId!];
    }

    // Look up Discord IDs (best-effort)
    let discordChannelId: string | null = null;
    let discordAdminChannelId: string | null = null;
    let uid: string | null = null;

    try {
      const bySlug = await db.collection("users").where("workspaceSlug", "==", slug).limit(1).get();
      if (!bySlug.empty) {
        const userData = bySlug.docs[0].data();
        uid = bySlug.docs[0].id;
        discordChannelId = userData.discord?.channelId ?? userData.provisioning?.discord?.channels?.octogee ?? null;
        discordAdminChannelId = userData.provisioning?.discord?.channels?.admin ?? null;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`deprovisionAgents: Firestore lookup failed (non-fatal): ${msg}`);
    }

    const jobId = `${slug}-${Date.now()}`;
    await db.collection("cleanupJobs").doc(jobId).set({
      jobId, slug, slugPrefix: `octogee-${slug}`, targetAgentIds,
      deleteWorkspace: !!deleteWorkspace,
      discordChannelId, discordAdminChannelId, uid,
      status: "pending",
      requestedAt: FieldValue.serverTimestamp(),
      requestedBy: "admin",
      completedAt: null, error: null,
    });

    res.json({
      status: "queued", jobId, slug, targetAgentIds,
      discordChannelId, discordAdminChannelId,
      message: "Cleanup job queued. The gateway provisioner will process it within seconds.",
    });
  } catch (e) { next(e); }
});

export default router;
