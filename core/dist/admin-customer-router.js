import { buildCustomerSummary, toISODate, } from "./admin-shape.js";
import { getTierConfig } from "@octogee/shared/types/billing-tiers";
import { GATEWAYS_COLLECTION } from "@octogee/shared/types/fleet-controller";
import { isOperatorManaged, readBuilderParkedComputer } from "@octogee/shared/types/glm";
import { PLACEMENT_RECEIPTS_SUBCOLLECTION } from "@octogee/shared/types/placement-receipts";
import { readOwnerBrokerUsageSeries } from "./broker-usage-series.js";
import { MODEL_BROKER_USAGE_EVENTS_COLLECTION, MODEL_BROKER_USAGE_ROLLUPS_COLLECTION, MODEL_BROKER_USAGE_WINDOWS_COLLECTION, MODEL_BROKER_WEEK_WINDOWS_COLLECTION, modelBrokerWindowDocId, usageWindowStartMs, weekWindowStartMs, } from "@octogee/shared/types/model-broker-usage";
import { ANONYMOUS_OPERATIONAL_ARCHIVES_COLLECTION, anonymousOperationalEnvironment, anonymousOperationalGatewayClass, anonymousOperationalPlanTier, isAnonymousOperationalModelDimension, } from "@octogee/shared/types/account-lifecycle";
function financeNumber(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function operationalNumber(value) {
    return Math.max(0, financeNumber(value));
}
function archiveMonth(value) {
    return typeof value === "string" && /^\d{4}-\d{2}$/.test(value) ? value : null;
}
function projectAnonymousArchive(id, data) {
    const rawTotals = data.totals && typeof data.totals === "object" && !Array.isArray(data.totals)
        ? data.totals
        : {};
    const models = Array.isArray(data.models)
        ? data.models.flatMap((raw) => {
            if (!raw || typeof raw !== "object" || Array.isArray(raw))
                return [];
            const model = raw;
            if (!isAnonymousOperationalModelDimension(model.provider, model.model))
                return [];
            return [{
                    provider: model.provider,
                    model: model.model,
                    costUsd: operationalNumber(model.costUsd),
                    totalTokens: operationalNumber(model.totalTokens),
                    requestCount: operationalNumber(model.requestCount),
                }];
        })
        : [];
    return {
        id,
        schemaVersion: data.schemaVersion === 1 ? 1 : 0,
        archivedAt: operationalNumber(data.archivedAt),
        accountCreatedMonth: archiveMonth(data.accountCreatedMonth),
        deletionRequestedMonth: archiveMonth(data.deletionRequestedMonth),
        environment: anonymousOperationalEnvironment(data.environment),
        planTier: anonymousOperationalPlanTier(data.planTier),
        gatewayClass: anonymousOperationalGatewayClass(data.gatewayClass),
        totals: {
            costUsd: operationalNumber(rawTotals.costUsd),
            totalTokens: operationalNumber(rawTotals.totalTokens),
            requestCount: operationalNumber(rawTotals.requestCount),
        },
        models,
        cleanupOutcomeCodes: Array.isArray(data.cleanupOutcomeCodes)
            ? data.cleanupOutcomeCodes.filter((value) => value === "verified_erasure")
            : [],
    };
}
// Admin USD figures come exclusively from the broker ledger; one getAll pulls
// the current 4h window + week ledger + the all-time rollup per customer.
async function readBrokerCustomerUsage(db, uids, now) {
    const usage = new Map();
    if (uids.length === 0)
        return usage;
    const windowStartMs = usageWindowStartMs(now);
    const weekStartMs = weekWindowStartMs(now);
    const refs = uids.flatMap((uid) => [
        db
            .collection(MODEL_BROKER_USAGE_WINDOWS_COLLECTION)
            .doc(modelBrokerWindowDocId(uid, windowStartMs)),
        db
            .collection(MODEL_BROKER_WEEK_WINDOWS_COLLECTION)
            .doc(modelBrokerWindowDocId(uid, weekStartMs)),
        db.collection(MODEL_BROKER_USAGE_ROLLUPS_COLLECTION).doc(uid),
    ]);
    const snaps = await db.getAll(...refs);
    uids.forEach((uid, i) => {
        const windowData = snaps[i * 3]?.data() ?? {};
        const weekData = snaps[i * 3 + 1]?.data() ?? {};
        const rollupData = snaps[i * 3 + 2]?.data() ?? {};
        usage.set(uid, {
            windowCostUsd: financeNumber(windowData.costUsd),
            weekCostUsd: financeNumber(weekData.costUsd),
            totalCostUsd: financeNumber(rollupData.costUsd),
            totalTokens: financeNumber(rollupData.totalTokens),
            now,
        });
    });
    return usage;
}
// One admin detail view reads at most this many event docs (30d of history).
// ~20K calls/month/customer is far past current scale; when a customer crosses
// it the history truncates loudly (warn log) instead of reading unbounded —
// the fix at that scale is day-rollup docs, not a bigger limit.
const BROKER_DAILY_USAGE_EVENT_LIMIT = 20_000;
// Per-UTC-day broker cost series for the admin usage history — replaces the
// legacy usage_logs costUsd (openclaw-reported $0).
async function readBrokerDailyUsage(db, uid, sinceMs, logger) {
    const snap = await db
        .collection(MODEL_BROKER_USAGE_EVENTS_COLLECTION)
        .where("ownerUid", "==", uid)
        .where("createdAt", ">=", sinceMs)
        .limit(BROKER_DAILY_USAGE_EVENT_LIMIT)
        .get();
    if (snap.docs.length >= BROKER_DAILY_USAGE_EVENT_LIMIT) {
        logger?.warn("admin daily usage truncated at the broker event limit", {
            uid,
            limit: BROKER_DAILY_USAGE_EVENT_LIMIT,
        });
    }
    const days = new Map();
    for (const doc of snap.docs) {
        const data = doc.data();
        const createdAt = financeNumber(data.createdAt);
        if (!createdAt)
            continue;
        const date = new Date(createdAt).toISOString().slice(0, 10);
        const day = days.get(date) ?? { date, costUsd: 0, totalTokens: 0, requestCount: 0 };
        day.costUsd += financeNumber(data.costUsd);
        day.totalTokens += financeNumber(data.totalTokens);
        day.requestCount += 1;
        days.set(date, day);
    }
    return days;
}
// The "where did my window go" projection: cold turns show up as cache-write
// spikes, blue/green flips as token-name changes, model switches per day.
export function aggregateBrokerDiagnostics(events, recentLimit = 25) {
    const dayMap = new Map();
    const decomposition = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const sorted = [...events].sort((a, b) => financeNumber(b.createdAt) - financeNumber(a.createdAt));
    for (const data of sorted) {
        const createdAt = financeNumber(data.createdAt);
        if (!createdAt)
            continue;
        const model = typeof data.model === "string" ? data.model : "unknown";
        const date = new Date(createdAt).toISOString().slice(0, 10);
        const key = `${date}|${model}`;
        const breakdown = (data.costBreakdown ?? {});
        const day = dayMap.get(key) ?? {
            date,
            model,
            totalTokens: 0,
            requestCount: 0,
            costUsd: 0,
            cacheWriteUsd: 0,
        };
        day.totalTokens += financeNumber(data.totalTokens);
        day.requestCount += 1;
        day.costUsd += financeNumber(data.costUsd);
        day.cacheWriteUsd += financeNumber(breakdown.cacheWrite);
        dayMap.set(key, day);
        decomposition.input += financeNumber(breakdown.input);
        decomposition.output += financeNumber(breakdown.output);
        decomposition.cacheRead += financeNumber(breakdown.cacheRead);
        decomposition.cacheWrite += financeNumber(breakdown.cacheWrite);
    }
    const recentCalls = sorted.slice(0, recentLimit).map((data) => {
        const usage = (data.usage ?? {});
        return {
            at: financeNumber(data.createdAt),
            model: typeof data.model === "string" ? data.model : "unknown",
            inputTokens: financeNumber(usage.inputTokens),
            outputTokens: financeNumber(usage.outputTokens),
            cacheWriteTokens: financeNumber(usage.cacheCreationInputTokens),
            cacheReadTokens: financeNumber(usage.cacheReadInputTokens),
            costUsd: financeNumber(data.costUsd),
            degraded: data.degraded === true,
            brokerTokenSecretName: typeof data.brokerTokenSecretName === "string" ? data.brokerTokenSecretName : null,
        };
    });
    return {
        days: [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date)),
        decomposition,
        recentCalls,
    };
}
// Tokens/interactions come from the legacy tailer docs (they see byosub
// traffic the broker never does); costUsd comes only from the broker series.
// Broker-only days (e.g. logs write failed) still surface with their real cost.
export function mergeDailyUsage(legacyLogs, brokerDaily) {
    const merged = new Map();
    for (const log of legacyLogs) {
        const date = typeof log.date === "string" ? log.date : null;
        if (!date)
            continue;
        merged.set(date, {
            ...log,
            costUsd: brokerDaily.get(date)?.costUsd ?? 0,
            brokerTokens: brokerDaily.get(date)?.totalTokens ?? 0,
        });
    }
    for (const [date, day] of brokerDaily) {
        if (merged.has(date))
            continue;
        merged.set(date, {
            date,
            tokensUsed: day.totalTokens,
            interactions: day.requestCount,
            costUsd: day.costUsd,
            brokerTokens: day.totalTokens,
        });
    }
    return Array.from(merged.values()).sort((a, b) => String(b.date).localeCompare(String(a.date)));
}
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
function objectValue(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : null;
}
function stringValue(value) {
    return typeof value === "string" && value.length > 0 ? value : null;
}
function adminModelCredentialFromSystemConfig(config) {
    const credential = objectValue(config?.modelCredential);
    const provider = stringValue(credential?.provider);
    const mode = stringValue(credential?.mode);
    const status = stringValue(credential?.status);
    if (!credential || !provider || !mode || !status)
        return null;
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
function applyCustomerFilters(items, f) {
    let result = items;
    if (f.search) {
        const q = f.search;
        result = result.filter((c) => c.displayName.toLowerCase().includes(q) ||
            c.email.toLowerCase().includes(q) ||
            c.username.toLowerCase().includes(q));
    }
    if (f.throttleFilter === "degraded") {
        result = result.filter((c) => c.degraded);
    }
    else if (f.throttleFilter === "ok") {
        result = result.filter((c) => !c.degraded);
    }
    if (f.byotFilter !== "all") {
        result = result.filter((c) => c.byotActive === (f.byotFilter === "on"));
    }
    return result;
}
export function projectCustomerPlacement(openclaw) {
    const record = openclaw && typeof openclaw === "object" && !Array.isArray(openclaw)
        ? openclaw
        : {};
    return {
        managedBy: isOperatorManaged(record.managedBy) ? "operator" : "cowboy",
        gatewayId: typeof record.gatewayId === "string" ? record.gatewayId : null,
        gatewayProfile: typeof record.gatewayProfile === "string" ? record.gatewayProfile : null,
    };
}
const OPS_FIELD_MAP = {
    setTier: "selectedTier",
};
function dottedRead(path, src) {
    return path.split(".").reduce((acc, key) => {
        if (acc && typeof acc === "object" && key in acc) {
            return acc[key];
        }
        return undefined;
    }, src);
}
function finiteNumber(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function projectPlacementReceipt(id, data) {
    return {
        id,
        kind: stringValue(data.kind) ?? "unknown",
        at: finiteNumber(data.at),
        builderSlug: stringValue(data.builderSlug),
        leaseId: stringValue(data.leaseId),
        generation: finiteNumber(data.generation),
        cause: stringValue(data.cause),
        sizingTier: stringValue(data.sizingTier),
        gatewayId: stringValue(data.gatewayId),
        sharedGatewayId: stringValue(data.sharedGatewayId),
        wakeDurationMs: finiteNumber(data.wakeDurationMs),
        activeDurationMs: finiteNumber(data.activeDurationMs),
        operationId: stringValue(data.operationId),
        retirementOperationId: stringValue(data.retirementOperationId),
        operatorTerminated: data.operatorTerminated === true,
        error: stringValue(data.error),
    };
}
function activationLeaseSummary(userData) {
    const openclaw = objectValue(objectValue(userData.provisioning)?.openclaw);
    const lease = objectValue(openclaw?.activationLease);
    const generation = finiteNumber(lease?.generation);
    const leaseId = stringValue(lease?.leaseId);
    if (!lease || !leaseId || generation === null)
        return null;
    return {
        leaseId,
        generation,
        status: stringValue(lease.status),
        cause: stringValue(lease.cause),
        sizingTier: stringValue(lease.sizingTier),
        targetGatewayId: stringValue(lease.targetGatewayId),
        error: stringValue(objectValue(lease.lastError)?.message),
    };
}
function warnIfNoSlug(logger, slugs, uid) {
    if (slugs.length === 0) {
        logger.warn("no workspace slug resolved — workspace reads will return empty", { uid });
    }
    return slugs;
}
// eslint-disable-next-line max-lines-per-function -- factory mounts the customer routes; splitting it would scatter the contract
export function addAdminCustomerRoutes(router, deps) {
    const { db, logger, FieldValue } = deps;
    router.get("/customer-archives", async (_req, res, next) => {
        try {
            const snap = await db
                .collection(ANONYMOUS_OPERATIONAL_ARCHIVES_COLLECTION)
                .orderBy("archivedAt", "desc")
                .get();
            const archives = snap.docs.map((doc) => projectAnonymousArchive(doc.id, doc.data()));
            const summary = archives.reduce((total, archive) => ({
                archiveCount: total.archiveCount + 1,
                totalCostUsd: total.totalCostUsd + archive.totals.costUsd,
                totalTokens: total.totalTokens + archive.totals.totalTokens,
                requestCount: total.requestCount + archive.totals.requestCount,
            }), { archiveCount: 0, totalCostUsd: 0, totalTokens: 0, requestCount: 0 });
            res.json({ archives, summary, generatedAt: new Date().toISOString() });
        }
        catch (e) {
            next(e);
        }
    });
    router.get("/customers/:uid/broker-diagnostics", async (req, res, next) => {
        try {
            const uid = req.params.uid;
            const days = Math.min(30, Math.max(1, parseInt(req.query.days ?? "14", 10)));
            const now = Date.now();
            const sinceMs = now - days * 24 * 60 * 60 * 1000;
            // Window history by derived doc id — no composite index needed.
            const windowMs = 4 * 60 * 60 * 1000;
            const currentWindow = usageWindowStartMs(now);
            const windowRefs = Array.from({ length: 12 }, (_, i) => db
                .collection(MODEL_BROKER_USAGE_WINDOWS_COLLECTION)
                .doc(`${uid}_${currentWindow - i * windowMs}`));
            const [windowSnaps, eventsSnap] = await Promise.all([
                db.getAll(...windowRefs),
                db
                    .collection(MODEL_BROKER_USAGE_EVENTS_COLLECTION)
                    .where("ownerUid", "==", uid)
                    .where("createdAt", ">=", sinceMs)
                    .limit(BROKER_DAILY_USAGE_EVENT_LIMIT)
                    .get(),
            ]);
            const windows = windowSnaps
                .filter((snap) => snap.exists)
                .map((snap) => {
                const data = snap.data();
                return {
                    windowStartMs: financeNumber(data.windowStartMs),
                    totalTokens: financeNumber(data.totalTokens),
                    requestCount: financeNumber(data.requestCount),
                    costUsd: financeNumber(data.costUsd),
                };
            })
                .sort((a, b) => b.windowStartMs - a.windowStartMs);
            res.json({
                windows,
                ...aggregateBrokerDiagnostics(eventsSnap.docs.map((doc) => doc.data())),
            });
        }
        catch (e) {
            next(e);
        }
    });
    router.get("/customers", async (req, res, next) => {
        try {
            const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(req.query.pageSize ?? `${DEFAULT_PAGE_SIZE}`, 10)));
            const cursor = req.query.cursor || null;
            const sort = (req.query.sort ?? "createdAt");
            const filters = {
                search: (req.query.search ?? "").trim().toLowerCase(),
                throttleFilter: req.query.throttle ?? "all",
                byotFilter: req.query.byot ?? "all",
            };
            let q = db
                .collection("users")
                .orderBy(sort === "lastActive" ? "usage.lastUpdated" : "createdAt", "desc")
                .limit(pageSize + 1);
            if (cursor) {
                const cursorDoc = await db.collection("users").doc(cursor).get();
                if (cursorDoc.exists)
                    q = q.startAfter(cursorDoc);
            }
            const snap = await q.get();
            const docs = snap.docs;
            const hasMore = docs.length > pageSize;
            const pageDocs = hasMore ? docs.slice(0, pageSize) : docs;
            const brokerUsage = await readBrokerCustomerUsage(db, pageDocs.map((d) => d.id), Date.now());
            const items = applyCustomerFilters(pageDocs.map((d) => buildCustomerSummary(d.id, d.data(), brokerUsage.get(d.id) ?? {})), filters);
            const statsSnap = await db.doc("system/stats").get();
            const total = statsSnap.data()?.totalCustomers ?? null;
            res.json({
                items,
                nextCursor: hasMore ? pageDocs[pageDocs.length - 1].id : null,
                hasMore,
                total,
                generatedAt: new Date().toISOString(),
            });
        }
        catch (e) {
            next(e);
        }
    });
    router.get("/customers/stats", async (_req, res, next) => {
        try {
            const usersSnap = await db.collection("users").orderBy("createdAt", "desc").get();
            const brokerUsage = await readBrokerCustomerUsage(db, usersSnap.docs.map((doc) => doc.id), Date.now());
            let totalCustomers = 0;
            let incompleteProvisioning = 0;
            let mrrUsd = 0;
            let totalCostUsd = 0;
            let needsAttention = 0;
            for (const doc of usersSnap.docs) {
                const summary = buildCustomerSummary(doc.id, doc.data(), brokerUsage.get(doc.id) ?? {});
                totalCustomers++;
                if (summary.provisioningStatus !== "complete")
                    incompleteProvisioning++;
                mrrUsd += summary.revenueUsd;
                totalCostUsd += summary.costUsd;
                if (summary.degraded || summary.percentUsed > 80)
                    needsAttention++;
            }
            res.json({
                totalCustomers,
                incompleteProvisioning,
                mrrUsd: Math.round(mrrUsd * 100) / 100,
                totalCostUsd: Math.round(totalCostUsd * 100) / 100,
                needsAttention,
                generatedAt: new Date().toISOString(),
            });
        }
        catch (e) {
            next(e);
        }
    });
    router.get("/customer/:uid", 
    // eslint-disable-next-line complexity -- response-shape builder; cyclomatic count tracks customer schema's optional-field depth, not branching logic. Splitting into sub-builders would scatter the response contract.
    async (req, res, next) => {
        try {
            const uid = req.params.uid;
            if (!uid) {
                res.status(400).json({ error: "uid required" });
                return;
            }
            const userDoc = await db.collection("users").doc(uid).get();
            if (!userDoc.exists) {
                res.status(404).json({ error: "User not found" });
                return;
            }
            const d = userDoc.data();
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
            const tier = subscription.tier || "trial";
            const tierConfig = getTierConfig(tier);
            const now = Date.now();
            const [brokerUsage, brokerDaily, brokerRollupSnap] = await Promise.all([
                readBrokerCustomerUsage(db, [uid], now),
                readBrokerDailyUsage(db, uid, thirtyDaysAgo.getTime(), logger),
                db.collection(MODEL_BROKER_USAGE_ROLLUPS_COLLECTION).doc(uid).get(),
            ]);
            const summary = buildCustomerSummary(uid, d, brokerUsage.get(uid) ?? { now });
            const mmContext = await deps.getWorkspaceMmContext(uid, d);
            const slugs = warnIfNoSlug(logger, deps.workspaceSlugsForUser(d), uid);
            // Workspace usage_models carry token telemetry for ALL traffic (byosub
            // included) but openclaw-$0 costs; the broker rollup carries the real USD
            // per platform model. Broker figures win per model; workspace-only models
            // (byosub) keep their token counts at $0 platform cost.
            const modelCosts = {};
            for (const slug of slugs) {
                const modelsSnap = await db.collection(`workspaces/${slug}/usage_models`).get();
                for (const modelDoc of modelsSnap.docs) {
                    const md = modelDoc.data();
                    const model = md.model || modelDoc.id.split("_")[0];
                    if (!modelCosts[model])
                        modelCosts[model] = { tokens: 0, costUsd: 0, lastUsedAt: null };
                    modelCosts[model].tokens += md.tokens || 0;
                    modelCosts[model].costUsd = 0;
                    const lastUsed = toISODate(md.lastUsedAt);
                    if (lastUsed &&
                        (!modelCosts[model].lastUsedAt || lastUsed > modelCosts[model].lastUsedAt)) {
                        modelCosts[model].lastUsedAt = lastUsed;
                    }
                }
            }
            const rollupModels = (brokerRollupSnap.data()?.models ?? {});
            for (const value of Object.values(rollupModels)) {
                const model = typeof value.model === "string" ? value.model.replace(/-\d{8}$/, "") : null;
                if (!model)
                    continue;
                const existing = modelCosts[model] ?? { tokens: 0, costUsd: 0, lastUsedAt: null };
                existing.tokens = Math.max(existing.tokens, financeNumber(value.totalTokens));
                existing.costUsd = financeNumber(value.costUsd);
                modelCosts[model] = existing;
            }
            res.json({
                summary,
                accountLifecycle: d.accountLifecycle ?? { status: "active" },
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
                },
                usage: {
                    totalTokensUsed: usage.totalTokensUsed || 0,
                    brokerTotalTokens: summary.brokerTotalTokens,
                    costUsd: summary.costUsd,
                    nextRefillAt: summary.nextRefillAt,
                    degraded: summary.degraded,
                    percentUsed: summary.percentUsed,
                    interactionCount: usage.interactionCount || 0,
                    lastUpdated: toISODate(usage.lastUpdated),
                    windowCostUsd: summary.windowCostUsd,
                    windowBudgetUsd: summary.windowBudgetUsd,
                    weekCostUsd: summary.weekCostUsd,
                    weekBudgetUsd: summary.weekBudgetUsd,
                    weekPercentUsed: summary.weekPercentUsed,
                    weekResetAt: summary.weekResetAt,
                },
                modelCredential,
                byot: { active: customerCredentialActive },
                provisioning: {
                    status: provisioning.openclaw?.status || provisioning.status || "unknown",
                    slug: provisioning.openclaw?.slug || d.username || "",
                    activatedAgents: provisioning.openclaw?.activatedAgents || [],
                    provisionedAt: toISODate(provisioning.openclaw?.provisionedAt),
                },
                placement: projectCustomerPlacement(provisioning.openclaw),
                computer: readBuilderParkedComputer(d),
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
                // Daily history: token/interaction telemetry from the legacy tailer
                // (covers byosub traffic), USD strictly from the broker ledger.
                usageLogs: mergeDailyUsage(logsSnap.docs.map((doc) => doc.data()), brokerDaily),
                modelCosts,
                createdAt: toISODate(d.createdAt),
            });
        }
        catch (e) {
            next(e);
        }
    });
    router.get("/customer/:uid/usage", async (req, res, next) => {
        try {
            const uid = req.params.uid;
            const days = Math.max(1, Math.min(365, parseInt(req.query.days ?? "30", 10)));
            const userDoc = await db.collection("users").doc(uid).get();
            if (!userDoc.exists) {
                res.status(404).json({ error: "User not found" });
                return;
            }
            const userData = userDoc.data();
            const cutoff = new Date();
            cutoff.setDate(cutoff.getDate() - days);
            const slugs = warnIfNoSlug(logger, deps.workspaceSlugsForUser(userData), uid);
            // Cost is the billing truth from the broker's per-owner event stream —
            // the self-report ledger (usage_models) records openclaw's $0-for-GLM
            // cost. The broker meters per OWNER, so the platform usage/cost belongs
            // to the account: attribute it to the primary workspace and leave any
            // additional cards empty so a multi-workspace owner is never
            // double-counted. Owner-credential (BYOSUB) traffic never reaches the
            // broker and carries $0 platform cost — correct for a cost panel.
            const series = await readOwnerBrokerUsageSeries(db, uid, cutoff.getTime(), logger);
            const displayName = userData.displayName || userData.username || "";
            const workspaces = slugs.map((slug, i) => {
                const s = i === 0 ? series : null;
                return {
                    workspaceId: slug,
                    displayName: displayName || slug,
                    summary: {
                        totalTokens: s?.totalTokens ?? 0,
                        totalCostUsd: s?.totalCostUsd ?? 0,
                        totalInteractions: s?.totalCalls ?? 0,
                        lastUpdated: null,
                        modelCosts: Object.fromEntries((s?.models ?? []).map((m) => [m.model.replace(/\//g, "_"), m.costUsd])),
                    },
                    sessions: (s?.sessions ?? []).map((d) => ({
                        date: d.date,
                        tokensUsed: d.tokens,
                        costUsd: d.costUsd,
                        interactions: d.calls,
                        roles: {},
                    })),
                    models: (s?.models ?? []).map((m) => ({
                        id: m.model,
                        date: "",
                        model: m.model,
                        tokens: m.tokens,
                        cost_usd: m.costUsd,
                        interaction_count: m.calls,
                        role: "platform",
                        lastUsedAt: m.lastUsedAt ? new Date(m.lastUsedAt).toISOString() : null,
                    })),
                };
            });
            const noSessions = workspaces.every((w) => w.summary.totalTokens === 0 && w.sessions.length === 0);
            let diagnostic;
            if (slugs.length === 0) {
                diagnostic = { kind: "no-slug", message: "User has no workspace slug. Check users/{uid}.username." };
            }
            else if (noSessions) {
                diagnostic = { kind: "no-data", message: "Workspace exists but no sessions logged yet." };
            }
            else {
                diagnostic = { kind: "ok", message: null };
            }
            res.json({ uid, workspaces, diagnostic, generatedAt: new Date().toISOString() });
        }
        catch (e) {
            next(e);
        }
    });
    router.get("/customer/:uid/placements", async (req, res, next) => {
        try {
            const uid = req.params.uid;
            const userDoc = await db.collection("users").doc(uid).get();
            if (!userDoc.exists) {
                res.status(404).json({ error: "User not found" });
                return;
            }
            const limit = Math.max(1, Math.min(200, parseInt(req.query.limit ?? "50", 10) || 50));
            const snap = await db
                .collection(`users/${uid}/${PLACEMENT_RECEIPTS_SUBCOLLECTION}`)
                .orderBy("at", "desc")
                .limit(limit + 1)
                .get();
            const sorted = snap.docs
                .map((doc) => projectPlacementReceipt(doc.id, doc.data()))
                .sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
            const items = sorted.slice(0, limit);
            const hasMore = sorted.length > limit;
            const lease = activationLeaseSummary(userDoc.data());
            let retryAvailable = false;
            if (lease?.status === "failed") {
                retryAvailable = lease.targetGatewayId === null
                    ? true
                    : !(await db.collection(GATEWAYS_COLLECTION).doc(lease.targetGatewayId).get()).exists;
            }
            res.json({ items, hasMore, lease, retryAvailable, generatedAt: new Date().toISOString() });
        }
        catch (e) {
            next(e);
        }
    });
    router.get("/customer/:uid/audit", async (req, res, next) => {
        try {
            const uid = req.params.uid;
            const limit = Math.max(1, Math.min(200, parseInt(req.query.limit ?? "50", 10)));
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
        }
        catch (e) {
            next(e);
        }
    });
    router.post("/customer/:uid/ops", async (req, res, next) => {
        try {
            const uid = req.params.uid;
            const { action, value } = (req.body ?? {});
            if (!action || typeof action !== "string" || !(action in OPS_FIELD_MAP)) {
                res.status(400).json({ error: `Unknown ops action: ${action}` });
                return;
            }
            const field = OPS_FIELD_MAP[action];
            const userRef = db.collection("users").doc(uid);
            const userSnap = await userRef.get();
            if (!userSnap.exists) {
                res.status(404).json({ error: "User not found" });
                return;
            }
            const userData = userSnap.data() ?? {};
            const before = dottedRead(field, userData);
            const update = { [field]: value === undefined ? null : value };
            if (action === "setTier")
                update["tier"] = value;
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
        }
        catch (e) {
            next(e);
        }
    });
    return router;
}
