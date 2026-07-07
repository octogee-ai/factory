import { Router, Request, Response, NextFunction } from "express";
import { requireAuth } from "../middleware/auth.js";
import { db, FieldValue } from "../lib/db.js";
import { logger } from "../middleware/logging.js";
import { triggerGatewayModelCredentialSync } from "../lib/byot-sync-trigger.js";
import { byotSnapshotProjectionFromSystemConfig } from "@octogee/core/customer-snapshot-mapping";
import {
  agentIdBelongsToSlug,
  parseAgentModelSelection,
  parseAgentModelSelections,
  platformModelRefs,
  modelRefForCatalogEntry,
  type AgentModelSelection,
  type AgentModelSelections,
} from "@octogee/shared/types/agent-models";
import { MODEL_CATALOG } from "@octogee/shared/types/model-catalog";
import { pickPlanInputs, resolveBillingProfile } from "@octogee/shared/types/billing";

const router = Router();

function agentIdParam(req: Request): string {
  const value = req.params.agentId;
  return typeof value === "string" ? value : "";
}

function slugFromRequest(req: Request): string | null {
  const user = req.user as { username?: unknown; defaultWorkspaceId?: unknown } | undefined;
  const slug = user?.username ?? user?.defaultWorkspaceId;
  return typeof slug === "string" && slug.length > 0 ? slug : null;
}

function gatewayIdFromRequest(req: Request): string | null {
  const gatewayId = (req.user as { provisioning?: { openclaw?: { gatewayId?: unknown } } } | undefined)
    ?.provisioning?.openclaw?.gatewayId;
  return typeof gatewayId === "string" && gatewayId.length > 0 ? gatewayId : null;
}

async function readSystemConfig(uid: string): Promise<Record<string, unknown>> {
  const snap = await db.doc(`users/${uid}/system/config`).get();
  return snap.data() ?? {};
}

// BYOSUB = a live OAUTH subscription credential (claude-cli, codex). A static
// API key is also "active" but never unlocks free-form subscription-runtime
// refs — key traffic still resolves through the broker's catalog policy.
function hasActiveByosub(sysData: Record<string, unknown>): boolean {
  const credential = sysData.modelCredential as
    | { active?: unknown; mode?: unknown }
    | undefined;
  return credential?.active === true && credential?.mode === "oauth";
}

function catalogPayload() {
  return MODEL_CATALOG.map((entry) => ({
    ref: modelRefForCatalogEntry(entry),
    provider: entry.provider,
    id: entry.id,
    label: entry.label,
    ...(typeof entry.contextTokens === "number" ? { contextTokens: entry.contextTokens } : {}),
    reasoningEfforts: entry.reasoningEfforts,
    ...(entry.defaultReasoningEffort
      ? { defaultReasoningEffort: entry.defaultReasoningEffort }
      : {}),
  }));
}

// The picker's live-flip path: persist the pick, then push the FULL selection
// map (plus the credential projection) to the gateway so byot-sync re-asserts
// every agent — the same payload shape the boot re-assert derives from the
// mount snapshot.
function triggerAgentModelSync(args: {
  req: Request;
  uid: string;
  slug: string;
  sysData: Record<string, unknown>;
  agentModels: AgentModelSelections;
}): void {
  const gatewayId = gatewayIdFromRequest(args.req);
  if (!gatewayId) {
    logger.warn(`[agent-models] sync trigger skipped for ${args.slug}: missing gatewayId`);
    return;
  }
  const projection = byotSnapshotProjectionFromSystemConfig({
    ...args.sysData,
    agentModels: args.agentModels,
  });
  const user = args.req.user as {
    byotActive?: unknown;
    tier?: unknown;
    selectedTier?: unknown;
    subscription?: unknown;
    trialStartedAt?: unknown;
  };
  // The gateway re-runs resolveBillingProfile on this payload before applying the picks.
  // Every plan input travels: a trial user's catalog access hangs on trialStartedAt and a
  // builder's on builderSubscription — an omission silently degrades the sync to house_only
  // ("agent-model overrides deferred") while this PUT reports success (pickPlanInputs is the
  // single forwarding point that keeps that from recurring per-field).
  triggerGatewayModelCredentialSync({
    gatewayId,
    userData: {
      byotActive: projection.byotActive ?? user.byotActive === true,
      username: args.slug,
      provisioning: { openclaw: { status: "complete" } },
      ...(typeof user.tier === "string" ? { tier: user.tier } : {}),
      ...pickPlanInputs(user as Record<string, unknown>),
      systemConfig: projection.systemConfig,
    },
  });
}

router.get("/", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const uid = req.uid!;
    const sysData = await readSystemConfig(uid);
    const plan = resolveBillingProfile(req.user ?? {});
    const slug = slugFromRequest(req);
    res.json({
      modelAccess: plan.modelAccess,
      tier: plan.tier,
      ...(slug ? { coachAgentId: `octogee-${slug}-coach` } : {}),
      byosub: hasActiveByosub(sysData),
      catalog: catalogPayload(),
      selections: parseAgentModelSelections(sysData.agentModels),
    });
  } catch (e) { next(e); }
});

type SelectionGate =
  | { ok: true; slug: string; selection: AgentModelSelection | null; sysData: Record<string, unknown> }
  | { ok: false; status: number; error: string };

async function gateSelectionRequest(
  req: Request,
  opts: { requireSelection: boolean },
): Promise<SelectionGate> {
  const uid = req.uid!;
  const slug = slugFromRequest(req);
  if (!slug) return { ok: false, status: 409, error: "No workspace slug on account" };
  const agentId = agentIdParam(req);
  if (!agentIdBelongsToSlug(agentId, slug)) {
    return { ok: false, status: 403, error: `Agent ${agentId} is not yours` };
  }
  const plan = resolveBillingProfile(req.user ?? {});
  if (plan.modelAccess === "house_only") {
    return { ok: false, status: 402, error: "The model picker is available on paid plans" };
  }

  if (!opts.requireSelection) {
    return { ok: true, slug, selection: null, sysData: await readSystemConfig(uid) };
  }

  const selection = parseAgentModelSelection(req.body);
  if (!selection) {
    return { ok: false, status: 400, error: "primary (and optional fallbacks) must be valid model refs" };
  }
  const sysData = await readSystemConfig(uid);
  if (!hasActiveByosub(sysData)) {
    const allowed = new Set(platformModelRefs());
    const strangers = [selection.primary, ...selection.fallbacks].filter((ref) => !allowed.has(ref));
    if (strangers.length > 0) {
      return {
        ok: false,
        status: 400,
        error: `Not in the platform catalog: ${strangers.join(", ")}`,
      };
    }
  }
  return { ok: true, slug, selection, sysData };
}

router.put("/:agentId", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const uid = req.uid!;
    const agentId = agentIdParam(req);
    const gate = await gateSelectionRequest(req, { requireSelection: true });
    if (!gate.ok) { res.status(gate.status).json({ error: gate.error }); return; }
    const selection = gate.selection!;

    await db
      .doc(`users/${uid}/system/config`)
      .set({ agentModels: { [agentId]: selection } }, { merge: true });

    const merged = {
      ...parseAgentModelSelections(gate.sysData.agentModels),
      [agentId]: selection,
    };
    triggerAgentModelSync({ req, uid, slug: gate.slug, sysData: gate.sysData, agentModels: merged });
    logger.info(
      `[agent-models] ${gate.slug}: ${agentId} → ${selection.primary}` +
        (selection.fallbacks.length ? ` (fallback ${selection.fallbacks.join(", ")})` : ""),
    );

    res.json({ ok: true, agentId, selection });
  } catch (e) { next(e); }
});

router.delete("/:agentId", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const uid = req.uid!;
    const agentId = agentIdParam(req);
    const gate = await gateSelectionRequest(req, { requireSelection: false });
    if (!gate.ok) { res.status(gate.status).json({ error: gate.error }); return; }

    await db
      .doc(`users/${uid}/system/config`)
      .update({ [`agentModels.${agentId}`]: FieldValue.delete() });

    const remaining = parseAgentModelSelections(gate.sysData.agentModels);
    delete remaining[agentId];
    triggerAgentModelSync({ req, uid, slug: gate.slug, sysData: gate.sysData, agentModels: remaining });
    logger.info(
      `[agent-models] ${gate.slug}: ${agentId} pick removed — class default re-asserts on next sync`,
    );

    res.json({ ok: true, agentId });
  } catch (e) { next(e); }
});

export default router;
