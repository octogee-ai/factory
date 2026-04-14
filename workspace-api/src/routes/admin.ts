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
import { getWorkspaceMmContext } from "../lib/mattermost-context";

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
        faceModel: d.faceModel ?? null,
        brainModel: d.brainModel ?? null,
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
      uid, email: d.email || "", displayName: d.username || "",
      businessName: d.businessName || "", workspaceSlug: d.username || "", tier,
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
        lastKeyFingerprint: usage.lastKeyFingerprint || null,
      },
      byot: {
        active: d.byotActive === true,
      },
      provisioning: {
        status: provisioning.openclaw?.status || provisioning.status || "unknown",
        slug: provisioning.openclaw?.slug || "",
        activatedAgents: provisioning.openclaw?.activatedAgents || [],
        provisionedAt: provisioning.openclaw?.provisionedAt?.toDate?.()?.toISOString() || null,
      },
      mattermost: await (async () => {
        const ctx = await getWorkspaceMmContext(uid, undefined, d);
        return {
          connected: !!d.mattermost?.userId,
          userId: d.mattermost?.userId || null,
          channelId: ctx?.coachDmChannelId || null,
          username: d.mattermost?.username || null,
        };
      })(),
      onboarding: {
        step: d.onboardingStep || "unknown", complete: d.onboardingComplete || false,
        milestones: Object.fromEntries(onboardingSnap.docs.map((doc) => [doc.id, doc.data()])),
      },
      faceModel: d.faceModel || null,
      brainModel: d.brainModel || null,
      workspaces: wsSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() })),
      usageLogs: logsSnap.docs.map((doc) => {
        const ld = doc.data();
        return {
          ...ld,
          // Phase 0: expose the fingerprints from this day's turns so admin
          // UI can show a "Key" column. `keyFingerprint` = most-recent;
          // `keyFingerprints` = distinct set observed that day.
          keyFingerprint:  ld.keyFingerprint  || null,
          keyFingerprints: ld.keyFingerprints || (ld.keyFingerprint ? [ld.keyFingerprint] : []),
        };
      }),
      // Per-model cost breakdown (from workspace usage/models/* subcollection)
      modelCosts: await (async () => {
        const costs: Record<string, {
          tokens: number;
          costUsd: number;
          keyFingerprint: string | null;
          lastUsedAt: string | null;
        }> = {};
        for (const ws of wsSnap.docs) {
          const modelsSnap = await db.collection(`users/${uid}/workspaces/${ws.id}/usage/models`).get();
          for (const modelDoc of modelsSnap.docs) {
            const md = modelDoc.data();
            const model = md.model || modelDoc.id.split("_")[0];
            if (!costs[model]) costs[model] = { tokens: 0, costUsd: 0, keyFingerprint: null, lastUsedAt: null };
            costs[model].tokens += md.tokens || 0;
            costs[model].costUsd += md.cost_usd || 0;
            const lastUsed = md.lastUsedAt?.toDate?.()?.toISOString?.() || null;
            if (lastUsed && (!costs[model].lastUsedAt || lastUsed > costs[model].lastUsedAt!)) {
              costs[model].lastUsedAt = lastUsed;
              costs[model].keyFingerprint = md.keyFingerprint || costs[model].keyFingerprint;
            }
          }
        }
        return costs;
      })(),
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

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    // Iterate the customer's workspaces, pulling the v2 per-workspace usage
    // subcollections that the gateway provisioner populates:
    //   users/{uid}/workspaces/{wid}/usage/summary
    //   users/{uid}/workspaces/{wid}/usage/sessions/{date}
    //   users/{uid}/workspaces/{wid}/usage/models/{modelKey}_{date}
    const wsSnap = await db.collection("users").doc(uid).collection("workspaces").get();
    const wsEntries = wsSnap.docs.length > 0
      ? wsSnap.docs.map((d) => ({ id: d.id, data: d.data() }))
      : [{ id: userData.username || uid, data: userData }];

    const workspaces = await Promise.all(
      wsEntries.map(async (ws) => {
        const wid = ws.id;
        const summaryRef = db.collection(`users/${uid}/workspaces/${wid}/usage`).doc("summary");
        const sessionsRef = db.collection(`users/${uid}/workspaces/${wid}/usage/sessions`);
        const modelsRef   = db.collection(`users/${uid}/workspaces/${wid}/usage/models`);

        // Let query errors propagate via the outer try/catch so they
        // surface as 500s instead of silently hiding behind empty arrays.
        // Firestore returns an empty result (not an error) for missing
        // collections, so the normal "no usage yet" case works naturally.
        const [summarySnap, sessionsSnap, modelsSnap] = await Promise.all([
          summaryRef.get(),
          sessionsRef.where("date", ">=", cutoffStr).orderBy("date", "desc").get(),
          modelsRef.where("date", ">=", cutoffStr).get(),
        ]);

        const summary = summarySnap.exists ? summarySnap.data()! : {};
        const sessions = sessionsSnap.docs.map((d) => {
          const sd = d.data();
          return {
            date:           sd.date || d.id,
            tokensUsed:     sd.tokensUsed || 0,
            costUsd:        sd.costUsd || 0,
            interactions:   sd.interactions || 0,
            roles:          sd.roles || {},
            keyFingerprint: sd.keyFingerprint || null,
          };
        });
        const models = modelsSnap.docs.map((d) => {
          const md = d.data();
          return {
            id:                d.id,
            date:              md.date || d.id.split("_").slice(-1)[0] || "",
            model:             md.model || d.id.split("_").slice(0, -1).join("_"),
            tokens:            md.tokens || 0,
            cost_usd:          md.cost_usd || 0,
            interaction_count: md.interaction_count || 0,
            role:              md.role || "coach",
            keyFingerprint:    md.keyFingerprint || null,
            lastUsedAt:        md.lastUsedAt?.toDate?.()?.toISOString?.() || null,
          };
        });

        return {
          workspaceId:   wid,
          businessName:  ws.data.businessName || ws.data.workspaceName || userData.businessName || "Workspace",
          summary: {
            totalTokens:        Number(summary.totalTokens) || 0,
            totalCostUsd:       Number(summary.totalCostUsd) || 0,
            totalInteractions:  Number(summary.totalInteractions) || 0,
            lastUpdated:        summary.lastUpdated?.toDate?.()?.toISOString?.() || null,
            lastKeyFingerprint: summary.lastKeyFingerprint || null,
            modelCosts:         summary.modelCosts || {},
          },
          sessions,
          models,
        };
      }),
    );

    res.json({ uid, workspaces, generatedAt: new Date().toISOString() });
  } catch (e) { next(e); }
});

export default router;
