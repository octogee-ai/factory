/**
 * Admin routes — dashboard, customer detail, workspace usage, CSI visibility.
 * Migrated from functions/src/triggers/adminDashboard.ts
 */
import { Router, Request, Response, NextFunction } from "express";
import { requireAdmin } from "../middleware/auth";
import { logger } from "../middleware/logging";
import { db } from "../lib/db";
import { getTierConfig, isUnlimitedTier, calculateAvailableTokens, type TierName } from "../billing/tiers";
import type { CSIDocument } from "../csi/types";

const router = Router();
router.use(requireAdmin);

function toISODate(val: any): string | null {
  if (!val) return null;
  if (val?.toDate) return val.toDate().toISOString();
  if (val instanceof Date) return val.toISOString();
  return null;
}

function isActiveStatus(status: string): boolean {
  return status === "active" || status === "trialing";
}

// ── GET /dashboard — all customer summaries ───────────────────────────────

router.get("/dashboard", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const usersSnap = await db.collection("users").orderBy("createdAt", "desc").get();

    // Batch-read CSI documents for all users
    const csiRefs = usersSnap.docs.map((doc) => db.doc(`users/${doc.id}/csi/latest`));
    const csiDocs = csiRefs.length > 0 ? await db.getAll(...csiRefs) : [];
    const csiByUid = new Map<string, CSIDocument>();
    for (let i = 0; i < usersSnap.docs.length; i++) {
      if (csiDocs[i]?.exists) {
        csiByUid.set(usersSnap.docs[i].id, csiDocs[i].data() as CSIDocument);
      }
    }

    const customers = usersSnap.docs.map((doc) => {
      const d = doc.data();
      const tier: TierName = d.subscription?.tier ?? "trial";
      const tierConfig = getTierConfig(tier);
      const subscriptionStatus: string = d.subscription?.status ?? "trial";
      const costUsd: number = d.usage?.costUsd ?? 0;
      const throttleLevel: number = d.usage?.throttleLevel ?? 0;
      const agentIds: string[] = d.provisioning?.openclaw?.agentIds ?? [];
      const revenueUsd: number = tierConfig.monthlyPrice;
      const windowTokensUsed = d.usage?.windowTokensUsed ?? 0;
      const windowStartedAt = d.usage?.windowStartedAt?.toDate?.() ?? null;
      const { available, windowSize, nextRefillAt } = calculateAvailableTokens(tier, windowTokensUsed, windowStartedAt);
      const percentUsed = windowSize > 0 ? Math.min(100, Math.round((windowTokensUsed / windowSize) * 100)) : 0;

      const csi = csiByUid.get(doc.id) ?? null;

      return {
        uid: doc.id,
        businessName: d.businessName ?? d.email?.split("@")[0] ?? "(unknown)",
        email: d.email ?? "",
        tier, subscriptionStatus,
        windowTokensUsed, windowSize, available,
        nextRefillAt: nextRefillAt?.toISOString() ?? null,
        weeklyBudget: tierConfig.weeklyTokenBudget,
        totalTokensUsed: d.usage?.totalTokensUsed ?? d.usage?.tokensUsed ?? 0,
        costUsd, throttleLevel,
        lastActive: toISODate(d.usage?.lastUpdated),
        mattermostConnected: !!d.mattermost?.userId,
        agentCount: agentIds.length,
        createdAt: toISODate(d.createdAt),
        percentUsed, revenueUsd,
        marginUsd: revenueUsd - costUsd,
        tokensUsed: windowTokensUsed,
        tokensLimit: windowSize,
        // CSI fields
        csi: csi ? {
          healthScore: csi.healthScore,
          sentiment: csi.sentiment,
          intentGapScore: csi.intentGapScore,
          updatedAt: toISODate(csi.updatedAt),
          daysInactive: csi.featureSignals?.daysInactive ?? null,
          messagesThisWeek: csi.featureSignals?.messagesThisWeek ?? null,
          streakDays: csi.featureSignals?.streakDays ?? null,
          onboardingComplete: csi.featureSignals?.onboardingComplete ?? null,
          provisionerStatus: csi.provisioner?.status ?? null,
          sessionOutcome: csi.lastSessionSummary?.outcome ?? null,
          watchItems: csi.lastSessionSummary?.watchItems ?? [],
          highlights: csi.lastSessionSummary?.highlights ?? [],
          riskFactors: csi.notes?.riskFactors ?? [],
          positiveSignals: csi.notes?.positiveSignals ?? [],
        } : null,
      };
    });

    const csiCustomers = customers.filter((c) => c.csi !== null);
    const stats = {
      totalCustomers: customers.length,
      mrrUsd: customers.filter((c) => isActiveStatus(c.subscriptionStatus)).reduce((s, c) => s + c.revenueUsd, 0),
      totalCostUsd: customers.reduce((s, c) => s + c.costUsd, 0),
      needsAttention: customers.filter((c) => c.throttleLevel > 0 || c.percentUsed > 80).length,
      // CSI stats
      csi: {
        active: csiCustomers.filter((c) => c.csi?.healthScore === "active").length,
        atRisk: csiCustomers.filter((c) => c.csi?.healthScore === "at_risk").length,
        churning: csiCustomers.filter((c) => c.csi?.healthScore === "churning").length,
        noData: customers.length - csiCustomers.length,
      },
    };

    res.json({ customers, stats, generatedAt: new Date().toISOString() });
  } catch (e) { next(e); }
});

// ── POST /customer-detail — detailed customer data ────────────────────────

router.post("/customer-detail", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { uid } = req.body as { uid: string };
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
    const tier = subscription.tier || "trial";
    const { available, windowSize, nextRefillAt } = calculateAvailableTokens(
      tier as any, usage.windowTokensUsed || 0, usage.windowStartedAt?.toDate?.() || null,
    );

    // Fetch CSI document
    const csiSnap = await db.doc(`users/${uid}/csi/latest`).get();
    const csiData = csiSnap.exists ? csiSnap.data() as CSIDocument : null;

    res.json({
      uid, email: d.email || "", displayName: d.displayName || d.firstName || "",
      businessName: d.businessName || "", businessSlug: d.businessSlug || "", tier,
      subscription: {
        status: subscription.status || "none",
        stripeCustomerId: subscription.stripeCustomerId || null,
        currentPeriodEnd: subscription.currentPeriodEnd?.toDate?.()?.toISOString() || null,
      },
      usage: {
        totalTokensUsed: usage.totalTokensUsed || 0, costUsd: usage.costUsd || 0,
        windowTokensUsed: usage.windowTokensUsed || 0, windowSize, available,
        nextRefillAt: nextRefillAt?.toISOString() || null,
        throttleLevel: usage.throttleLevel || 0, interactionCount: usage.interactionCount || 0,
        lastUpdated: usage.lastUpdated?.toDate?.()?.toISOString() || null,
      },
      provisioning: {
        status: provisioning.openclaw?.status || provisioning.status || "unknown",
        slug: provisioning.openclaw?.slug || "",
        activatedAgents: provisioning.openclaw?.activatedAgents || [],
        provisionedAt: provisioning.openclaw?.provisionedAt?.toDate?.()?.toISOString() || null,
      },
      mattermost: {
        connected: !!d.mattermost?.userId, userId: d.mattermost?.userId || null,
        channelId: d.mattermost?.channelId || null, username: d.mattermost?.username || null,
      },
      onboarding: {
        step: d.onboardingStep || "unknown", complete: d.onboardingComplete || false,
        milestones: Object.fromEntries(onboardingSnap.docs.map((doc) => [doc.id, doc.data()])),
      },
      workspaces: wsSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() })),
      usageLogs: logsSnap.docs.map((doc) => doc.data()),
      createdAt: d.createdAt?.toDate?.()?.toISOString() || null,
      approved: d.approved || false,
      // Full CSI document for detail view
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
      } : null,
    });
  } catch (e) { next(e); }
});

// ── POST /workspace-usage — per-workspace usage breakdown ─────────────────

router.post("/workspace-usage", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { uid, days = 30 } = req.body as { uid: string; days?: number };
    if (!uid) { res.status(400).json({ error: "uid required" }); return; }

    const userDoc = await db.collection("users").doc(uid).get();
    if (!userDoc.exists) { res.status(404).json({ error: "User not found" }); return; }
    const userData = userDoc.data()!;
    const usage = userData.usage || {};

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    let sessions: any[] = [];
    try {
      const logsSnap = await db.collection("users").doc(uid)
        .collection("usageLogs").where("date", ">=", cutoff.toISOString().slice(0, 10))
        .orderBy("date", "desc").get();
      sessions = logsSnap.docs.map((d) => {
        const data = d.data();
        return { date: data.date || d.id, tokensUsed: data.tokensUsed || 0, costUsd: data.costUsd || 0, interactions: data.interactions || 0 };
      });
    } catch (e: any) {
      logger.warn(`usageLogs query failed for uid=${uid}: ${e.message}`);
    }

    res.json({
      uid,
      workspaces: [{
        workspaceId: userData.workspaceSlug || uid,
        businessName: userData.workspaceName || userData.businessName || "Workspace",
        summary: {
          totalTokens: Number(usage.totalTokensUsed) || 0,
          totalCostUsd: Number(usage.costUsd) || 0,
          totalInteractions: Number(usage.interactionCount) || 0,
          lastUpdated: usage.lastUpdated?.toDate?.()?.toISOString?.() || null,
          modelCosts: {},
        },
        sessions,
        models: [],
      }],
      generatedAt: new Date().toISOString(),
    });
  } catch (e) { next(e); }
});

export default router;
