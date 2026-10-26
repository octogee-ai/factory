import { raw, type Router, type Response } from "express";
import { Timestamp, type Transaction, type DocumentData } from "firebase-admin/firestore";
import { parseAgentId, workspaceCoachAgentId, projectAgentId } from "@octogee/shared/types/identity";
import { accountAllowsInteractiveAccess } from "@octogee/shared/types/account-lifecycle";
import { customerRuntimeMutationFenced } from "@octogee/shared/types/gateway-releases";
import type { AgentImportBrokerDeps, OwnerContext } from "./agent-import-broker.js";
import { agentExportApproval, type AgentExportRecord, type AgentExportSource } from "../../../gateway-edge/src/lib/agent-export-service.js";
import { exportDigest } from "../../../gateway-edge/src/lib/agent-export-snapshot.js";
const fail = (message: string): never => { throw Object.assign(new Error(message), { status: 409, code: "export_not_available" }); };
function sourceUserReady(data: DocumentData | undefined, owner: OwnerContext): boolean {
  const native = data?.provisioning?.openclaw;
  return accountAllowsInteractiveAccess(data) && native?.gatewayId === owner.gatewayId && native?.status === "complete" && native?.slug === owner.slug &&
    !customerRuntimeMutationFenced(data) && native.migration == null && native.nativeSharedContextRestore === undefined;
}
function sourcePlacementReady(placed: DocumentData | undefined, owner: OwnerContext): boolean {
  return placed?.state === "serving" && placed.slug === owner.slug && placed.gatewayId === owner.gatewayId && Number.isSafeInteger(placed.epoch) && placed.epoch >= 0;
}
function sourceGatewayReady(gateway: DocumentData | undefined, live: DocumentData | undefined): boolean {
  return !!gateway && gateway.desiredStatus === "running" && gateway.retirementClaim == null && gateway.runtimeRestartFence == null && live?.lifecycle === "serving";
}
function projectReady(project: DocumentData | undefined, owner: OwnerContext): boolean {
  return !!project && project.ownerUid === owner.uid && project.archivedAt == null && project.archived !== true && project.commercialLifecycle?.status !== "archived" && project.checkoutEnabled !== false && (project.provisioningState === undefined || project.provisioningState === "active");
}
function journalMatches(current: DocumentData, record: AgentExportRecord): boolean {
  return current.kind === record.kind && current.uid === record.uid && current.slug === record.slug && current.approvalHash === record.approvalHash &&
    (!current.expectedCommit || current.expectedCommit === record.expectedCommit) && (current.status !== "complete" || record.status === "complete");
}
export async function authorizeAgentExport(deps: AgentImportBrokerDeps, owner: OwnerContext, agentId: string, transaction?: Transaction): Promise<AgentExportSource> {
  const parsed = parseAgentId(agentId);
  if (parsed.kind === "unknown" || parsed.username !== owner.slug) fail("agent is outside the owned workspace");
  const read = (name: string) => transaction ? transaction.get(deps.db.doc(name)) : deps.db.doc(name).get();
  const [user, assignment, root, runtime, workspace] = await Promise.all([
    read(`users/${owner.uid}`), read(`gateways/${owner.gatewayId}/assignments/${owner.uid}`), read(`gateways/${owner.gatewayId}`), read(`glmGateways/${owner.gatewayId}`), read(`workspaces/${owner.slug}`),
  ]);
  const data = user.data(), placed = assignment.data(), gateway = root.data(), live = runtime.data();
  if (workspace.data()?.ownerUid !== owner.uid || workspace.data()?.ownerActive === false || !sourceUserReady(data, owner) || !sourcePlacementReady(placed, owner) || !sourceGatewayReady(gateway, live)) fail("workspace is not serving for export");
  if (parsed.kind === "project") {
    const project = (await read(`workspaces/${owner.slug}/projects/${parsed.project}`)).data();
    if (!projectReady(project, owner)) fail("project is not an active owned agent workspace");
  }
  return { uid: owner.uid, slug: owner.slug, gatewayId: owner.gatewayId, epoch: placed!.epoch, agentId, project: parsed.kind === "project" ? parsed.project : null };
}
export function registerAgentExportBrokerRoutes(router: Router, deps: AgentImportBrokerDeps, context: (res: Response) => OwnerContext): void {
  router.use("/exports", async (_req, res, next) => {
    try {
      const owner = context(res);
      const [user, workspace] = await Promise.all([deps.db.doc(`users/${owner.uid}`).get(), deps.db.doc(`workspaces/${owner.slug}`).get()]);
      if (!user.exists || !accountAllowsInteractiveAccess(user.data()) || workspace.data()?.ownerUid !== owner.uid || workspace.data()?.ownerActive === false) { res.status(403).json({ error: "forbidden" }); return; }
      const decision = await deps.featurePolicy?.evaluate("release-agent-export", { uid: owner.uid, isAdmin: owner.isAdmin, workspaceSlug: owner.slug, ...(owner.planTier ? { planTier: owner.planTier } : {}) }, "agent-export");
      if (!decision || decision.state !== "enabled") { res.status(decision?.state === "unavailable" ? 503 : 404).json({ error: "feature_unavailable" }); return; }
      next();
    } catch (error) { next(error); }
  });
  router.post("/exports/authorize", async (req, res, next) => {
    try { res.json(await deps.db.runTransaction(tx => authorizeAgentExport(deps, context(res), req.body?.agentId, tx))); } catch (error) { next(error); }
  });
  router.get("/exports/agents", async (_req, res, next) => {
    try {
      const owner = context(res);
      await deps.db.runTransaction(tx => authorizeAgentExport(deps, owner, workspaceCoachAgentId(owner.slug), tx));
      const identity = await deps.readIdentity(owner.uid);
      const projects = await deps.db.collection(`workspaces/${owner.slug}/projects`).where("ownerUid", "==", owner.uid).get();
      res.json({ agents: [{ id: workspaceCoachAgentId(owner.slug), label: identity.name || "Private coach" }, ...projects.docs.filter(doc => projectReady(doc.data(), owner)).map(doc => ({ id: projectAgentId(owner.slug, doc.id), label: doc.id }))] });
    } catch (error) { next(error); }
  });
  const id = (value: unknown): string => { if (typeof value !== "string" || !/^export-[a-z0-9-]{1,80}$/u.test(value)) { fail("invalid export id"); } return value as string; };
  const recordRef = (owner: OwnerContext, value: string) => deps.db.doc(`users/${owner.uid}/agentImports/${value}`);
  const owned = (value: unknown, owner: OwnerContext): value is AgentExportRecord => !!value && typeof value === "object" && "kind" in value && value.kind === "authored-agent-export" && "uid" in value && value.uid === owner.uid && "slug" in value && value.slug === owner.slug;
  router.put("/exports/records/:id", async (req, res, next) => {
    try {
      const owner = context(res), key = id(req.params.id), record = req.body as AgentExportRecord;
      if (!owned(record, owner) || record.id !== key || record.approvalHash !== agentExportApproval(record) || !["previewed", "publishing", "complete"].includes(record.status)) fail("invalid export record");
      await deps.db.runTransaction(async tx => {
        const ref = recordRef(owner, key), current = (await tx.get(ref)).data();
        if (record.status !== "complete") {
          const currentSource = await authorizeAgentExport(deps, owner, record.source.agentId, tx);
          if (record.gatewayId !== owner.gatewayId || exportDigest(currentSource) !== exportDigest(record.source)) fail("export source authority changed");
        } else if (!current?.expectedCommit || current.expectedCommit !== record.expectedCommit) fail("export publication receipt is missing");
        if (current && !journalMatches(current, record)) fail("export journal changed");
        if (!current && record.status !== "previewed") fail("export preview is missing");
        tx.set(ref, { ...record, cleanupAt: Timestamp.fromMillis(Date.parse(record.createdAt) + 25 * 60 * 60_000) });
        tx.set(deps.db.doc(`users/${owner.uid}/agentImportState/export-latest`), { id: key });
      });
      res.status(204).end();
    } catch (error) { next(error); }
  });
  router.get("/exports/records/:id", async (req, res, next) => {
    try {
      const owner = context(res);
      const key = req.params.id === "latest" ? (await deps.db.doc(`users/${owner.uid}/agentImportState/export-latest`).get()).data()?.id : req.params.id;
      if (!key) { res.json(null); return; }
      const record = (await recordRef(owner, id(key)).get()).data();
      if (!owned(record, owner)) { res.json(null); return; }
      res.json(record);
    } catch (error) { next(error); }
  });
  router.put("/exports/snapshots/:id", raw({ type: "application/octet-stream", limit: "180mb" }), async (req, res, next) => {
    try {
      const owner = context(res), key = id(req.params.id);
      if (!Buffer.isBuffer(req.body)) fail("invalid export snapshot");
      const existing = await recordRef(owner, key).get();
      if (!owned(existing.data(), owner) || existing.data()?.status !== "previewed") fail("export preview is missing");
      await deps.bucket.file(`agent-imports/${owner.uid}/${key}/export.json`).save(req.body, { contentType: "application/json", resumable: false, preconditionOpts: { ifGenerationMatch: 0 } });
      res.status(204).end();
    } catch (error) { next(error); }
  });
  router.get("/exports/snapshots/:id", async (req, res, next) => {
    try {
      const owner = context(res), key = id(req.params.id);
      const record = (await recordRef(owner, key).get()).data();
      if (!owned(record, owner)) fail("export record is unavailable");
      const [contents] = await deps.bucket.file(`agent-imports/${owner.uid}/${key}/export.json`).download();
      res.type("application/json").send(contents);
    } catch (error) { next(error); }
  });
}
