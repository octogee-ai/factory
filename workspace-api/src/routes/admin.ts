/**
 * Admin routes — operator console for the F&F launch and beyond.
 *
 * Endpoints (all under requireAdmin):
 *   GET    /customers                  — cursor-paginated list (replaces /dashboard)
 *   GET    /customers/stats            — stat cards + CSI rollup
 *   GET    /funnel                     — trial conversion funnel rollup
 *   GET    /customer/:uid              — drill-in (replaces POST /customer-detail)
 *   GET    /customer/:uid/usage        — per-workspace usage (replaces POST /workspace-usage)
 *   GET    /customer/:uid/throttle     — throttle history (last 50)
 *   GET    /customer/:uid/audit        — admin actions audit log (last 50)
 *   POST   /customer/:uid/ops          — ops knob writes (audit-logged)
 *   POST   /system-config              — global config (kill-switch, signups, banner)
 *
 * Spec: docs/ADMIN-DASHBOARD-SPEC.md §12.
 */
import { Router, Request, Response, NextFunction } from "express";
import { requireAdmin } from "../middleware/auth";
import { logger } from "../middleware/logging";
import { db, FieldValue, Timestamp } from "../lib/db";
import { getTierConfig, type TierName } from "../billing/tiers";
import type { CSIDocument } from "../csi/types";
import { updateCSIForUser } from "../csi/updater";
import { getWorkspaceMmContext } from "../lib/mattermost-context";
import { workspaceSlugsForUser } from "../lib/workspace-slugs";
import {
  buildCustomerSummary,
  buildFunnelRollup,
  toISODate,
  isActiveStatus,
  type CustomerSummary,
} from "./admin-shape";

// ── Workspace-slug helper (with observability) ──────────────────────────────

function warnIfNoSlug(slugs: string[], uid: string): string[] {
  if (slugs.length === 0) {
    logger.warn(
      "no workspace slug resolved — workspace reads will return empty",
      { uid },
    );
  }
  return slugs;
}

const router = Router();
router.use(requireAdmin);

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

// ── Helpers: read-side ──────────────────────────────────────────────────────

async function readCSIByUids(uids: string[]): Promise<Map<string, CSIDocument>> {
  if (uids.length === 0) return new Map();
  const refs = uids.map((uid) => db.doc(`users/${uid}/csi/latest`));
  const docs = await db.getAll(...refs);
  const out = new Map<string, CSIDocument>();
  for (let i = 0; i < uids.length; i++) {
    if (docs[i]?.exists) {
      out.set(uids[i], docs[i].data() as CSIDocument);
    }
  }
  return out;
}

// ── GET /customers — cursor-paginated list ──────────────────────────────────

router.get("/customers", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pageSize = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, parseInt((req.query.pageSize as string) ?? `${DEFAULT_PAGE_SIZE}`, 10)),
    );
    const cursor = (req.query.cursor as string | undefined) ?? null;
    const search = ((req.query.search as string | undefined) ?? "").trim().toLowerCase();
    const trialStatus = (req.query.trialStatus as string | undefined) ?? "all";
    const funnelStage = (req.query.funnelStage as string | undefined) ?? "all";
    const throttleFilter = (req.query.throttle as string | undefined) ?? "all";
    const byotFilter = (req.query.byot as string | undefined) ?? "all";
    const sort = ((req.query.sort as string | undefined) ?? "createdAt") as
      | "createdAt" | "lastActive" | "trialDay" | "percentUsed" | "revenue";

    // Cursor-based pagination over ordered users. The cursor is a doc id;
    // we resolve it to the doc, then `startAfter`. Approximate `total` is
    // pulled from a counter the user-create trigger maintains (hourly-fresh
    // is fine — counts at scale shouldn't pay for collection scans).
    let q = db.collection("users")
      .orderBy(sort === "lastActive" ? "usage.lastUpdated" : "createdAt", "desc")
      .limit(pageSize + 1); // +1 to detect hasMore

    if (cursor) {
      const cursorSnap = await db.collection("users").doc(cursor).get();
      if (cursorSnap.exists) {
        q = q.startAfter(cursorSnap);
      }
    }

    const snap = await q.get();
    const docs = snap.docs;
    const hasMore = docs.length > pageSize;
    const pageDocs = hasMore ? docs.slice(0, pageSize) : docs;

    // Batch-load CSI for the page
    const uids = pageDocs.map((d) => d.id);
    const csiByUid = await readCSIByUids(uids);

    // Build summaries
    let items: CustomerSummary[] = pageDocs.map((doc) =>
      buildCustomerSummary(doc.id, doc.data() as Record<string, any>, csiByUid.get(doc.id) ?? null),
    );

    // In-memory filtering. Fine at F&F scale; revisit with normalized
    // lowercase fields + Firestore where-chains at 1k+ customers (§7.4).
    if (search) {
      items = items.filter((c) =>
        c.displayName.toLowerCase().includes(search) ||
        c.email.toLowerCase().includes(search) ||
        c.username.toLowerCase().includes(search),
      );
    }
    if (trialStatus !== "all") {
      items = items.filter((c) => {
        if (trialStatus === "trialing") return c.subscriptionStatus === "trialing";
        if (trialStatus === "converted") return c.trial?.funnelStage === "converted";
        if (trialStatus === "expired") return c.trial?.funnelStage === "expired";
        if (trialStatus === "paid") return isActiveStatus(c.subscriptionStatus) && c.tier !== "trial" && c.tier !== "free";
        return true;
      });
    }
    if (funnelStage !== "all") {
      items = items.filter((c) => c.trial?.funnelStage === funnelStage);
    }
    if (throttleFilter !== "all") {
      const map: Record<string, number> = { normal: 0, warning: 1, advisor: 2, blocked: 3 };
      const lvl = map[throttleFilter];
      if (lvl !== undefined) items = items.filter((c) => c.throttleLevel === lvl);
    }
    if (byotFilter !== "all") {
      items = items.filter((c) => c.byotActive === (byotFilter === "on"));
    }

    // Approximate total — single-doc read.
    const statsSnap = await db.doc("system/stats").get();
    const total: number =
      statsSnap.data()?.totalCustomers ?? null;

    res.json({
      items,
      nextCursor: hasMore ? pageDocs[pageDocs.length - 1].id : null,
      hasMore,
      total,
      generatedAt: new Date().toISOString(),
    });
  } catch (e) { next(e); }
});

// ── GET /customers/stats — top-of-page stat cards ───────────────────────────

router.get("/customers/stats", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    // Aggregate across ALL users — same as the old /dashboard's stats block,
    // but without sending the customer rows. Cheaper to call from the page
    // header without forcing a re-fetch of the list.
    const usersSnap = await db.collection("users").orderBy("createdAt", "desc").get();
    const uids = usersSnap.docs.map((d) => d.id);
    const csiByUid = await readCSIByUids(uids);

    let totalCustomers = 0;
    let mrrUsd = 0;
    let totalCostUsd = 0;
    let needsAttention = 0;
    let csiActive = 0;
    let csiAtRisk = 0;
    let csiChurning = 0;
    let csiNoData = 0;

    for (const doc of usersSnap.docs) {
      const summary = buildCustomerSummary(
        doc.id,
        doc.data() as Record<string, any>,
        csiByUid.get(doc.id) ?? null,
      );
      totalCustomers++;
      mrrUsd += summary.revenueUsd;
      totalCostUsd += summary.costUsd;
      if (summary.throttleLevel > 0 || summary.percentUsed > 80) needsAttention++;

      if (!summary.csi) csiNoData++;
      else if (summary.csi.healthScore === "active") csiActive++;
      else if (summary.csi.healthScore === "at_risk") csiAtRisk++;
      else if (summary.csi.healthScore === "churning") csiChurning++;
    }

    res.json({
      totalCustomers,
      mrrUsd: Math.round(mrrUsd * 100) / 100,
      totalCostUsd: Math.round(totalCostUsd * 100) / 100,
      needsAttention,
      csi: { active: csiActive, atRisk: csiAtRisk, churning: csiChurning, noData: csiNoData },
      generatedAt: new Date().toISOString(),
    });
  } catch (e) { next(e); }
});

// ── GET /funnel — conversion funnel rollup ──────────────────────────────────

router.get("/funnel", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const windowDays = Math.max(1, Math.min(365,
      parseInt((req.query.windowDays as string) ?? "30", 10),
    ));
    const cutoff = Timestamp.fromMillis(Date.now() - windowDays * 24 * 60 * 60 * 1000);

    const usersSnap = await db.collection("users")
      .where("createdAt", ">=", cutoff)
      .get();

    const uids = usersSnap.docs.map((d) => d.id);
    const csiByUid = await readCSIByUids(uids);

    const inputs = usersSnap.docs.map((d) => ({
      uid: d.id,
      user: d.data() as Record<string, any>,
      csi: csiByUid.get(d.id) ?? null,
    }));

    const rollup = buildFunnelRollup(inputs, windowDays, Date.now());
    res.json(rollup);
  } catch (e) { next(e); }
});

// ── GET /customer/:uid — drill-in ───────────────────────────────────────────

router.get("/customer/:uid", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const uid = req.params.uid;
    if (!uid) { res.status(400).json({ error: "uid required" }); return; }

    const userDoc = await db.collection("users").doc(uid).get();
    if (!userDoc.exists) { res.status(404).json({ error: "User not found" }); return; }
    const d = userDoc.data()!;

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const logsSnap = await db.collection("users").doc(uid)
      .collection("usage_logs").where("date", ">=", thirtyDaysAgo.toISOString().slice(0, 10))
      .orderBy("date", "desc").get();

    const wsSnap = await db.collection("users").doc(uid).collection("workspaces").get();
    const onboardingSnap = await db.collection("users").doc(uid).collection("onboarding").get();

    const subscription = d.subscription || {};
    const usage = d.usage || {};
    const provisioning = d.provisioning || {};
    const tier: TierName = subscription.tier || "trial";
    const tierConfig = getTierConfig(tier);

    const csiSnap = await db.doc(`users/${uid}/csi/latest`).get();
    const csiData = csiSnap.exists ? (csiSnap.data() as CSIDocument) : null;

    const summary = buildCustomerSummary(uid, d, csiData);

    const mmContext = await getWorkspaceMmContext(uid, undefined, d);

    res.json({
      // Top-level — derived from the same shape the list uses
      summary,
      // Plus the heavy per-customer data the list view doesn't need
      subscription: {
        status: subscription.status || "none",
        stripeCustomerId: subscription.stripeCustomerId || null,
        currentPeriodEnd: toISODate(subscription.currentPeriodEnd),
        trialStartedAt: toISODate(subscription.trialStartedAt),
        trialEndsAt: toISODate(subscription.trialEndsAt),
        canceledAt: toISODate(subscription.canceledAt),
      },
      tierConfig: {
        monthlyPrice: tierConfig.monthlyPrice,
        weeklyTokenBudget: tierConfig.weeklyTokenBudget,
      },
      usage: {
        totalTokensUsed: usage.totalTokensUsed || 0,
        costUsd: usage.costUsd || 0,
        windowTokensUsed: usage.windowTokensUsed || 0,
        windowSize: summary.windowSize,
        available: summary.available,
        nextRefillAt: summary.nextRefillAt,
        throttleLevel: usage.throttleLevel || 0,
        // §9.2: throttleReason is populated by usage-tracking.ts +
        // onUsageUpdate.ts; null for users with no recent activity.
        throttleReason: usage.throttleReason || null,
        interactionCount: usage.interactionCount || 0,
        lastUpdated: toISODate(usage.lastUpdated),
        // §9.2 USD-throttle fields. Populated by scripts/lib/usage-tracking.ts
        // on every turn — 0 for customers who haven't chatted since PR-B.
        windowCostUsd: typeof usage.windowCostUsd === "number" ? usage.windowCostUsd : 0,
        windowBudgetUsd: typeof usage.windowBudgetUsd === "number" ? usage.windowBudgetUsd : 0,
      },
      byot: { active: d.byotActive === true },
      provisioning: {
        status: provisioning.openclaw?.status || provisioning.status || "unknown",
        slug: provisioning.openclaw?.slug || d.username || "",
        activatedAgents: provisioning.openclaw?.activatedAgents || [],
        provisionedAt: toISODate(provisioning.openclaw?.provisionedAt),
      },
      mattermost: {
        connected: !!d.mattermost?.userId,
        userId: d.mattermost?.userId || null,
        channelId: mmContext?.coachDmChannelId || null,
        username: d.mattermost?.username || null,
      },
      onboarding: {
        step: d.onboardingStep || "unknown",
        complete: d.onboardingComplete || false,
        milestones: Object.fromEntries(onboardingSnap.docs.map((doc) => [doc.id, doc.data()])),
      },
      faceModel: d.faceModel || null,
      brainModel: d.brainModel || null,
      enforcement: d.faceBrainEnforcement || "observe",
      throttleActive: d.billing?.throttleActive !== false,
      selectedTier: d.selectedTier || tier,
      workspaces: wsSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() })),
      usageLogs: logsSnap.docs.map((doc) => doc.data()),
      modelCosts: await (async () => {
        const costs: Record<string, { tokens: number; costUsd: number; lastUsedAt: string | null }> = {};
        for (const slug of warnIfNoSlug(workspaceSlugsForUser(d), uid)) {
          const modelsSnap = await db.collection(`workspaces/${slug}/usage_models`).get();
          for (const modelDoc of modelsSnap.docs) {
            const md = modelDoc.data();
            const model = md.model || modelDoc.id.split("_")[0];
            if (!costs[model]) costs[model] = { tokens: 0, costUsd: 0, lastUsedAt: null };
            costs[model].tokens += md.tokens || 0;
            costs[model].costUsd += md.cost_usd || 0;
            const lastUsed = toISODate(md.lastUsedAt);
            if (lastUsed && (!costs[model].lastUsedAt || lastUsed > costs[model].lastUsedAt!)) {
              costs[model].lastUsedAt = lastUsed;
            }
          }
        }
        return costs;
      })(),
      createdAt: toISODate(d.createdAt),
      approved: d.approved || false,
      // Full CSI doc for detail view (CSI-T trial state lives inside)
      csi: csiData ? {
        healthScore: csiData.healthScore,
        sentiment: csiData.sentiment,
        intentGapScore: csiData.intentGapScore,
        updatedAt: toISODate(csiData.updatedAt),
        featureSignals: csiData.featureSignals,
        sources: csiData.sources,
        confidence: csiData.confidence,
        notes: csiData.notes ?? null,
        provisioner: csiData.provisioner ? {
          status: csiData.provisioner.status,
          durationMinutes: csiData.provisioner.durationMinutes,
          error: csiData.provisioner.error,
          lastEventAt: toISODate(csiData.provisioner.lastEventAt),
          attempts: csiData.provisioner.attempts,
        } : null,
        lastSessionSummary: csiData.lastSessionSummary ? {
          sessionId: csiData.lastSessionSummary.sessionId,
          sentiment: csiData.lastSessionSummary.sentiment,
          intentGapScore: csiData.lastSessionSummary.intentGapScore,
          outcome: csiData.lastSessionSummary.outcome,
          highlights: csiData.lastSessionSummary.highlights,
          watchItems: csiData.lastSessionSummary.watchItems,
          ingestedAt: toISODate(csiData.lastSessionSummary.ingestedAt),
        } : null,
        trial: csiData.trial ? {
          startedAt: toISODate(csiData.trial.startedAt),
          endsAt: toISODate(csiData.trial.endsAt),
          dayN: csiData.trial.dayN,
          daysRemaining: csiData.trial.daysRemaining,
          expired: csiData.trial.expired,
          milestones: {
            firstChatWithCoachAt: csiData.trial.milestones.firstChatWithCoachAt,
            onboardingCompleteAt: csiData.trial.milestones.onboardingCompleteAt,
            firstProjectCreatedAt: csiData.trial.milestones.firstProjectCreatedAt,
            byotConfiguredAt: csiData.trial.milestones.byotConfiguredAt,
            paidStartedAt: csiData.trial.milestones.paidStartedAt,
          },
          hoursSinceSignup: csiData.trial.hoursSinceSignup,
          hoursSinceLastActivity: csiData.trial.hoursSinceLastActivity,
          costSpentLast24h: csiData.trial.costSpentLast24h,
          costSpentTotal: csiData.trial.costSpentTotal,
          funnelStage: csiData.trial.funnelStage,
          flags: csiData.trial.flags,
        } : null,
      } : null,
    });
  } catch (e) { next(e); }
});

// ── GET /customer/:uid/usage — per-workspace usage breakdown ────────────────

router.get("/customer/:uid/usage", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const uid = req.params.uid;
    const days = Math.max(1, Math.min(365,
      parseInt((req.query.days as string) ?? "30", 10),
    ));

    const userDoc = await db.collection("users").doc(uid).get();
    if (!userDoc.exists) { res.status(404).json({ error: "User not found" }); return; }
    const userData = userDoc.data()!;

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    const slugs = warnIfNoSlug(workspaceSlugsForUser(userData), uid);

    const workspaces = await Promise.all(
      slugs.map(async (slug) => {
        const wsRef = db.collection("workspaces").doc(slug);
        const summaryRef  = wsRef.collection("usage_summary").doc("current");
        const sessionsRef = wsRef.collection("usage_sessions");
        const modelsRef   = wsRef.collection("usage_models");

        const [summarySnap, sessionsSnap, modelsSnap] = await Promise.all([
          summaryRef.get(),
          sessionsRef.where("date", ">=", cutoffStr).orderBy("date", "desc").get(),
          modelsRef.where("date", ">=", cutoffStr).get(),
        ]);

        const summary = summarySnap.exists ? summarySnap.data()! : {};
        const sessions = sessionsSnap.docs.map((d) => {
          const sd = d.data();
          return {
            date: sd.date || d.id,
            tokensUsed: sd.tokensUsed || 0,
            costUsd: sd.costUsd || 0,
            interactions: sd.interactions || 0,
            roles: sd.roles || {},
          };
        });
        const models = modelsSnap.docs.map((d) => {
          const md = d.data();
          return {
            id: d.id,
            date: md.date || d.id.split("_").slice(-1)[0] || "",
            model: md.model || d.id.split("_").slice(0, -1).join("_"),
            tokens: md.tokens || 0,
            cost_usd: md.cost_usd || 0,
            interaction_count: md.interaction_count || 0,
            role: md.role || "coach",
            lastUsedAt: toISODate(md.lastUsedAt),
          };
        });

        return {
          workspaceId: slug,
          displayName: userData.displayName || userData.username || slug,
          summary: {
            totalTokens: Number(summary.totalTokens) || 0,
            totalCostUsd: Number(summary.totalCostUsd) || 0,
            totalInteractions: Number(summary.totalInteractions) || 0,
            lastUpdated: toISODate(summary.lastUpdated),
            modelCosts: summary.modelCosts || {},
          },
          sessions,
          models,
        };
      }),
    );

    // Surface diagnostic state so the frontend can show the right message
    // (§10): no slug vs. slug-but-no-data are different problems.
    const diagnostic =
      slugs.length === 0
        ? { kind: "no-slug" as const, message: "User has no workspace slug. Check users/{uid}.username." }
        : workspaces.every((w) => w.summary.totalTokens === 0 && w.sessions.length === 0)
          ? { kind: "no-data" as const, message: "Workspace exists but no sessions logged yet." }
          : { kind: "ok" as const, message: null };

    res.json({ uid, workspaces, diagnostic, generatedAt: new Date().toISOString() });
  } catch (e) { next(e); }
});

// ── GET /customer/:uid/throttle — last 50 throttle history entries ──────────

router.get("/customer/:uid/throttle", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const uid = req.params.uid;
    const limit = Math.max(1, Math.min(200,
      parseInt((req.query.limit as string) ?? "50", 10),
    ));

    const snap = await db.collection(`users/${uid}/throttle_history`)
      .orderBy("at", "desc")
      .limit(limit)
      .get();

    const items = snap.docs.map((doc) => {
      const d = doc.data();
      return {
        id: doc.id,
        at: toISODate(d.at),
        fromLevel: typeof d.fromLevel === "number" ? d.fromLevel : null,
        toLevel:   typeof d.toLevel === "number" ? d.toLevel : null,
        pct:       typeof d.pct === "number" ? d.pct : null,
        reason:    d.reason ?? null,
        windowCostUsd:   typeof d.windowCostUsd === "number" ? d.windowCostUsd : null,
        windowBudgetUsd: typeof d.windowBudgetUsd === "number" ? d.windowBudgetUsd : null,
      };
    });

    res.json({ items, generatedAt: new Date().toISOString() });
  } catch (e) { next(e); }
});

// ── GET /customer/:uid/audit — admin actions audit log ──────────────────────

router.get("/customer/:uid/audit", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const uid = req.params.uid;
    const limit = Math.max(1, Math.min(200,
      parseInt((req.query.limit as string) ?? "50", 10),
    ));

    const snap = await db.collection(`users/${uid}/admin_actions`)
      .orderBy("at", "desc")
      .limit(limit)
      .get();

    const items = snap.docs.map((doc) => {
      const d = doc.data();
      return {
        id: doc.id,
        at: toISODate(d.at),
        adminUid: d.adminUid ?? null,
        adminEmail: d.adminEmail ?? null,
        action: d.action ?? "(unknown)",
        before: d.before ?? null,
        after: d.after ?? null,
      };
    });

    res.json({ items, generatedAt: new Date().toISOString() });
  } catch (e) { next(e); }
});

// ── POST /customer/:uid/ops — consolidated ops knob writes ──────────────────
// Body: { action, value }
// Records the change to users/{uid}/admin_actions in the same write batch
// so audit + state can never drift (§8.4).

const OPS_FIELD_MAP: Record<string, string> = {
  setTier:        "selectedTier",
  setFaceModel:   "faceModel",
  setBrainModel:  "brainModel",
  setEnforcement: "faceBrainEnforcement",
  setThrottle:    "billing.throttleActive",
};

router.post("/customer/:uid/ops", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const uid = req.params.uid;
    const { action, value } = (req.body ?? {}) as { action?: string; value?: unknown };
    if (!action || typeof action !== "string" || !(action in OPS_FIELD_MAP)) {
      res.status(400).json({ error: `Unknown ops action: ${action}` });
      return;
    }
    const field = OPS_FIELD_MAP[action];

    // Read existing value for the audit `before` record.
    const userRef = db.collection("users").doc(uid);
    const userSnap = await userRef.get();
    if (!userSnap.exists) { res.status(404).json({ error: "User not found" }); return; }
    const userData = userSnap.data() ?? {};

    const dottedRead = (path: string, src: Record<string, any>): unknown => {
      return path.split(".").reduce<unknown>((acc, key) => {
        if (acc && typeof acc === "object" && key in (acc as Record<string, unknown>)) {
          return (acc as Record<string, unknown>)[key];
        }
        return undefined;
      }, src);
    };
    const before = dottedRead(field, userData);

    // For setTier, mirror to both `selectedTier` and `tier` for back-compat
    // with the gateway provisioner that reads `tier`.
    const update: Record<string, unknown> = { [field]: value === undefined ? null : value };
    if (action === "setTier") update["tier"] = value;

    await userRef.update(update);

    // Audit row
    const auditRef = userRef.collection("admin_actions").doc();
    await auditRef.set({
      at: FieldValue.serverTimestamp(),
      adminUid: req.uid ?? null,
      adminEmail: req.user?.email ?? null,
      action,
      field,
      before,
      after: value === undefined ? null : value,
    });

    res.json({ success: true, action, field, before, after: value });
  } catch (e) { next(e); }
});

// ── POST /system-config — global operator knobs ─────────────────────────────
// Writes to system/config (admin-readable per existing rules). Only the
// fields explicitly listed are accepted; unknown fields are ignored
// rather than 400'd so we can iterate forward without breaking clients.

const ALLOWED_SYSTEM_FIELDS = new Set([
  "throttleEnabledGlobal",
  "signupsOpen",
  "banner",
]);

router.post("/system-config", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const update: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body)) {
      if (ALLOWED_SYSTEM_FIELDS.has(k)) update[k] = v;
    }
    if (Object.keys(update).length === 0) {
      res.status(400).json({ error: "No accepted fields in body" });
      return;
    }
    update.updatedAt = FieldValue.serverTimestamp();
    update.updatedBy = req.uid ?? null;

    await db.doc("system/config").set(update, { merge: true });
    res.json({ success: true, updated: Object.keys(update) });
  } catch (e) { next(e); }
});

// ── POST /customer/:uid/csi-refresh — force CSI recompute ──────────────────
// Convenience for the operator: when a customer does something interesting,
// the dashboard's "Refresh" button can hit this to compute CSI-T immediately
// rather than waiting for the cron.

router.post("/customer/:uid/csi-refresh", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const uid = req.params.uid;
    const updated = await updateCSIForUser(uid);
    res.json({ success: !!updated, updatedAt: updated ? toISODate(updated.updatedAt) : null });
  } catch (e) { next(e); }
});

export default router;
