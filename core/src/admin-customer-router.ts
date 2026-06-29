
import {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { type Firestore } from "firebase-admin/firestore";
import {
  buildCustomerSummary,
  toISODate,
  type CustomerSummary,
} from "./admin-shape.js";
import { getTierConfig, type TierName } from "@octogee/shared/types/billing-tiers";
import {
  MODEL_BROKER_USAGE_WINDOWS_COLLECTION,
  modelBrokerWindowDocId,
  usageWindowStartMs,
} from "@octogee/shared/types/model-broker-usage";

async function readBrokerWindowCosts(
  db: Firestore,
  uids: string[],
  now: number,
): Promise<Map<string, number>> {
  const costs = new Map<string, number>();
  if (uids.length === 0) return costs;
  const windowStartMs = usageWindowStartMs(now);
  const refs = uids.map((uid) =>
    db
      .collection(MODEL_BROKER_USAGE_WINDOWS_COLLECTION)
      .doc(modelBrokerWindowDocId(uid, windowStartMs)),
  );
  const snaps = await db.getAll(...refs);
  snaps.forEach((snap, i) => {
    const cost = snap.data()?.costUsd;
    costs.set(uids[i]!, typeof cost === "number" && Number.isFinite(cost) ? cost : 0);
  });
  return costs;
}

export interface CustomerRouterLogger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface WorkspaceMmContextLite {
  coachDmChannelId: string | null;
}

export interface AdminCustomerRouterDeps {
  db: Firestore;

  FieldValue: { serverTimestamp: () => unknown };
  logger: CustomerRouterLogger;
  workspaceSlugsForUser: (data: { username?: string | null }) => string[];

  getWorkspaceMmContext: (
    uid: string,
    userDataHint: Record<string, unknown>,
  ) => Promise<WorkspaceMmContextLite | null>;
}

type ActorRequest = Request & {
  uid?: string;
  user?: { email?: string | null };
};

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

interface CustomerListFilters {
  search: string;
  throttleFilter: string;
  byotFilter: string;
}

interface AdminCustomerModelCredential {
  active: boolean;
  provider: string;
  mode: string;
  status: string;
  reasonCode: string | null;
  fingerprint: string | null;
  model: string | null;
  baseUrl: string | null;
  lastUsedAt: string | null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function adminModelCredentialFromSystemConfig(
  config: Record<string, unknown> | undefined,
): AdminCustomerModelCredential | null {
  const credential = objectValue(config?.modelCredential);
  const provider = stringValue(credential?.provider);
  const mode = stringValue(credential?.mode);
  const status = stringValue(credential?.status);

  if (!credential || !provider || !mode || !status) return null;

  return {
    active: credential.active === true,
    provider,
    mode,
    status,
    reasonCode: stringValue(credential.reasonCode),
    fingerprint: stringValue(credential.fingerprint),
    model: stringValue(credential.model),
    baseUrl: stringValue(credential.baseUrl),
    lastUsedAt: toISODate(credential.lastUsedAt),
  };
}


function applyCustomerFilters(
  items: CustomerSummary[],
  f: CustomerListFilters,
): CustomerSummary[] {
  let result = items;
  if (f.search) {
    const q = f.search;
    result = result.filter(
      (c) =>
        c.displayName.toLowerCase().includes(q) ||
        c.email.toLowerCase().includes(q) ||
        c.username.toLowerCase().includes(q),
    );
  }
  if (f.throttleFilter === "degraded") {
    result = result.filter((c) => c.degraded);
  } else if (f.throttleFilter === "ok") {
    result = result.filter((c) => !c.degraded);
  }
  if (f.byotFilter !== "all") {
    result = result.filter((c) => c.byotActive === (f.byotFilter === "on"));
  }
  return result;
}

const OPS_FIELD_MAP: Record<string, string> = {
  setTier: "selectedTier",
};

function dottedRead(path: string, src: Record<string, unknown>): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object" && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, src);
}

function warnIfNoSlug(
  logger: CustomerRouterLogger,
  slugs: string[],
  uid: string,
): string[] {
  if (slugs.length === 0) {
    logger.warn(
      "no workspace slug resolved — workspace reads will return empty",
      { uid },
    );
  }
  return slugs;
}

// eslint-disable-next-line max-lines-per-function -- factory mounts the customer routes; splitting it would scatter the contract
export function addAdminCustomerRoutes(
  router: Router,
  deps: AdminCustomerRouterDeps,
): Router {
  const { db, logger, FieldValue } = deps;

router.get(
    "/customers",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const pageSize = Math.min(
          MAX_PAGE_SIZE,
          Math.max(1, parseInt((req.query.pageSize as string) ?? `${DEFAULT_PAGE_SIZE}`, 10)),
        );
        const cursor = (req.query.cursor as string) || null;
        const sort = ((req.query.sort as string) ?? "createdAt") as
          | "createdAt" | "lastActive" | "percentUsed" | "revenue";
        const filters: CustomerListFilters = {
          search: ((req.query.search as string) ?? "").trim().toLowerCase(),
          throttleFilter: (req.query.throttle as string) ?? "all",
          byotFilter: (req.query.byot as string) ?? "all",
        };

        let q = db
          .collection("users")
          .orderBy(sort === "lastActive" ? "usage.lastUpdated" : "createdAt", "desc")
          .limit(pageSize + 1); 
        if (cursor) {
          const cursorDoc = await db.collection("users").doc(cursor).get();
          if (cursorDoc.exists) q = q.startAfter(cursorDoc);
        }
        const snap = await q.get();
        const docs = snap.docs;
        const hasMore = docs.length > pageSize;
        const pageDocs = hasMore ? docs.slice(0, pageSize) : docs;

        const windowCosts = await readBrokerWindowCosts(
          db,
          pageDocs.map((d) => d.id),
          Date.now(),
        );
        const items: CustomerSummary[] = applyCustomerFilters(
          pageDocs.map((d) => buildCustomerSummary(d.id, d.data(), windowCosts.get(d.id) ?? 0)),
          filters,
        );

const statsSnap = await db.doc("system/stats").get();
        const total: number | null = (statsSnap.data()?.totalCustomers as number) ?? null;

        res.json({
          items,
          nextCursor: hasMore ? pageDocs[pageDocs.length - 1]!.id : null,
          hasMore,
          total,
          generatedAt: new Date().toISOString(),
        });
      } catch (e) { next(e); }
    },
  );

  router.get(
    "/customers/stats",
    async (_req: Request, res: Response, next: NextFunction) => {
      try {
        const usersSnap = await db.collection("users").orderBy("createdAt", "desc").get();
        const windowCosts = await readBrokerWindowCosts(
          db,
          usersSnap.docs.map((doc) => doc.id),
          Date.now(),
        );

        let totalCustomers = 0;
        let incompleteProvisioning = 0;
        let mrrUsd = 0;
        let totalCostUsd = 0;
        let needsAttention = 0;

        for (const doc of usersSnap.docs) {
          const summary = buildCustomerSummary(
            doc.id,
            doc.data() as Record<string, unknown>,
            windowCosts.get(doc.id) ?? 0,
          );
          totalCustomers++;
          if (summary.provisioningStatus !== "complete") incompleteProvisioning++;
          mrrUsd += summary.revenueUsd;
          totalCostUsd += summary.costUsd;
          if (summary.degraded || summary.percentUsed > 80) needsAttention++;
        }

        res.json({
          totalCustomers,
          incompleteProvisioning,
          mrrUsd: Math.round(mrrUsd * 100) / 100,
          totalCostUsd: Math.round(totalCostUsd * 100) / 100,
          needsAttention,
          generatedAt: new Date().toISOString(),
        });
      } catch (e) { next(e); }
    },
  );

router.get(
    "/customer/:uid",
    // eslint-disable-next-line complexity -- response-shape builder; cyclomatic count tracks customer schema's optional-field depth, not branching logic. Splitting into sub-builders would scatter the response contract.
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const uid = req.params.uid as string;
        if (!uid) { res.status(400).json({ error: "uid required" }); return; }

        const userDoc = await db.collection("users").doc(uid).get();
        if (!userDoc.exists) { res.status(404).json({ error: "User not found" }); return; }
        const d = userDoc.data()!;

        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        const userRef = db.collection("users").doc(uid);
        const systemConfigSnap = await userRef.collection("system").doc("config").get();
        const modelCredential = adminModelCredentialFromSystemConfig(systemConfigSnap.data());
        const customerCredentialActive = modelCredential?.active === true || d.byotActive === true;

        const logsSnap = await userRef
          .collection("usage_logs").where("date", ">=", thirtyDaysAgo.toISOString().slice(0, 10))
          .orderBy("date", "desc").get();

        const wsSnap = await userRef.collection("workspaces").get();
        const onboardingSnap = await userRef.collection("onboarding").get();

        const subscription = d.subscription || {};
        const usage = d.usage || {};
        const provisioning = d.provisioning || {};
        const tier: TierName = subscription.tier || "trial";
        const tierConfig = getTierConfig(tier);

        const windowCosts = await readBrokerWindowCosts(db, [uid], Date.now());
        const summary = buildCustomerSummary(uid, d, windowCosts.get(uid) ?? 0);

        const mmContext = await deps.getWorkspaceMmContext(uid, d);

        const slugs = warnIfNoSlug(logger, deps.workspaceSlugsForUser(d as { username?: string | null }), uid);
        const modelCosts: Record<
          string,
          { tokens: number; costUsd: number; lastUsedAt: string | null }
        > = {};
        for (const slug of slugs) {
          const modelsSnap = await db.collection(`workspaces/${slug}/usage_models`).get();
          for (const modelDoc of modelsSnap.docs) {
            const md = modelDoc.data();
            const model = md.model || modelDoc.id.split("_")[0];
            if (!modelCosts[model]) modelCosts[model] = { tokens: 0, costUsd: 0, lastUsedAt: null };
            modelCosts[model]!.tokens += md.tokens || 0;
            modelCosts[model]!.costUsd += md.cost_usd || 0;
            const lastUsed = toISODate(md.lastUsedAt);
            if (
              lastUsed &&
              (!modelCosts[model]!.lastUsedAt || lastUsed > modelCosts[model]!.lastUsedAt!)
            ) {
              modelCosts[model]!.lastUsedAt = lastUsed;
            }
          }
        }

        res.json({
          summary,
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
            degraded: summary.degraded,
            interactionCount: usage.interactionCount || 0,
            lastUpdated: toISODate(usage.lastUpdated),
            windowCostUsd: summary.windowCostUsd,
            windowBudgetUsd: summary.windowBudgetUsd,
          },
          modelCredential,
          byot: { active: customerCredentialActive },
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
          selectedTier: d.selectedTier || tier,
          workspaces: wsSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() })),
          usageLogs: logsSnap.docs.map((doc) => doc.data()),
          modelCosts,
          createdAt: toISODate(d.createdAt),
          approved: d.approved || false,
        });
      } catch (e) { next(e); }
    },
  );

  router.get(
    "/customer/:uid/usage",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const uid = req.params.uid as string;
        const days = Math.max(1, Math.min(365,
          parseInt((req.query.days as string) ?? "30", 10),
        ));

        const userDoc = await db.collection("users").doc(uid).get();
        if (!userDoc.exists) { res.status(404).json({ error: "User not found" }); return; }
        const userData = userDoc.data()!;

        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - days);
        const cutoffStr = cutoff.toISOString().slice(0, 10);

        const slugs = warnIfNoSlug(
          logger,
          deps.workspaceSlugsForUser(userData as { username?: string | null }),
          uid,
        );

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

        const noSessions = workspaces.every(
          (w) => w.summary.totalTokens === 0 && w.sessions.length === 0,
        );
        let diagnostic:
          | { kind: "no-slug"; message: string }
          | { kind: "no-data"; message: string }
          | { kind: "ok"; message: null };
        if (slugs.length === 0) {
          diagnostic = { kind: "no-slug", message: "User has no workspace slug. Check users/{uid}.username." };
        } else if (noSessions) {
          diagnostic = { kind: "no-data", message: "Workspace exists but no sessions logged yet." };
        } else {
          diagnostic = { kind: "ok", message: null };
        }

        res.json({ uid, workspaces, diagnostic, generatedAt: new Date().toISOString() });
      } catch (e) { next(e); }
    },
  );


  router.get(
    "/customer/:uid/audit",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const uid = req.params.uid as string;
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
    },
  );

  router.post(
    "/customer/:uid/ops",
    async (req: ActorRequest, res: Response, next: NextFunction) => {
      try {
        const uid = req.params.uid as string;
        const { action, value } = (req.body ?? {}) as { action?: string; value?: unknown };
        if (!action || typeof action !== "string" || !(action in OPS_FIELD_MAP)) {
          res.status(400).json({ error: `Unknown ops action: ${action}` });
          return;
        }
        const field = OPS_FIELD_MAP[action]!;

        const userRef = db.collection("users").doc(uid);
        const userSnap = await userRef.get();
        if (!userSnap.exists) { res.status(404).json({ error: "User not found" }); return; }
        const userData = userSnap.data() ?? {};

        const before = dottedRead(field, userData);

        const update: Record<string, unknown> = { [field]: value === undefined ? null : value };
        if (action === "setTier") update["tier"] = value;

        await userRef.update(update);

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
    },
  );

  return router;
}
