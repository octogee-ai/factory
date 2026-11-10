import { raw, type Router, type Response } from "express";
import {
  agentImportRecordFromPayload,
  type BuilderRecord,
  type FleetRegistryRecord,
  type GatewayAssignment,
  type GatewayRoot,
  type OpaqueMap,
  type PlatformStateRepositories,
  type Stored,
  type WorkspaceProject,
} from "@octogee/core/platform-state";
import { builderRuntimeMutationFenced } from "@octogee/core/gateway-retirement-claim";
import { parseAgentId, workspaceCoachAgentId, projectAgentId } from "@octogee/shared/types/identity";
import { accountAllowsInteractiveAccess } from "@octogee/shared/types/account-lifecycle";
import type { AgentImportBrokerDeps, OwnerContext } from "./agent-import-broker.js";
import { agentExportApproval, type AgentExportRecord, type AgentExportSource } from "../../../gateway-edge/src/lib/agent-export-service.js";
import { exportDigest } from "../../../gateway-edge/src/lib/agent-export-snapshot.js";
const EXPORT_RECORD_TTL_MS = 25 * 60 * 60_000;
const fail = (message: string): never => { throw Object.assign(new Error(message), { status: 409, code: "export_not_available" }); };
function interactiveBuilder(builder: BuilderRecord | null): builder is BuilderRecord {
  return builder !== null && accountAllowsInteractiveAccess({ accountLifecycle: builder.accountLifecycle ?? undefined });
}
function sourceUserReady(builder: Stored<BuilderRecord> | null, owner: OwnerContext): boolean {
  return interactiveBuilder(builder) && builder.gateway?.gatewayId === owner.gatewayId && builder.openclaw.status === "complete" && builder.slug === owner.slug &&
    !builderRuntimeMutationFenced(builder) && builder.fences.migration === undefined;
}
function sourcePlacementReady(placed: GatewayAssignment | null, owner: OwnerContext): placed is GatewayAssignment {
  return placed?.state === "serving" && placed.slug === owner.slug && placed.gatewayId === owner.gatewayId && Number.isSafeInteger(placed.epoch) && placed.epoch >= 0;
}
function sourceGatewayReady(gateway: GatewayRoot | null, live: FleetRegistryRecord | null): boolean {
  return gateway !== null && gateway.desiredStatus === "running" && gateway.retirementClaim == null && gateway.runtimeRestartFence == null && live?.lifecycle === "serving";
}
function projectReady(project: WorkspaceProject | null, owner: OwnerContext): boolean {
  return project !== null && project.ownerUid === owner.uid && project.archivedAt === null && project.archived !== true && project.commercialLifecycleStatus !== "archived" && project.checkoutEnabled !== false && (project.provisioningState === null || project.provisioningState === "active");
}
function journalMatches(current: OpaqueMap, record: AgentExportRecord): boolean {
  return current.kind === record.kind && current.uid === record.uid && current.slug === record.slug && current.approvalHash === record.approvalHash &&
    (!current.expectedCommit || current.expectedCommit === record.expectedCommit) && (current.status !== "complete" || record.status === "complete");
}
export async function authorizeAgentExport(state: PlatformStateRepositories, owner: OwnerContext, agentId: string): Promise<AgentExportSource> {
  const parsed = parseAgentId(agentId);
  if (parsed.kind === "unknown" || parsed.username !== owner.slug) fail("agent is outside the owned workspace");
  const [builder, placed, gateway, live, workspace] = await Promise.all([
    state.builders.records.get(owner.uid), state.gateways.assignments.get(owner.gatewayId, owner.uid), state.gateways.roots.get(owner.gatewayId), state.fleetRegistry.get(owner.gatewayId), state.workspaces.records.get(owner.slug),
  ]);
  if (workspace?.ownerUid !== owner.uid || workspace.ownerActive === false || !sourceUserReady(builder, owner) || !sourcePlacementReady(placed, owner) || !sourceGatewayReady(gateway, live)) fail("workspace is not serving for export");
  if (parsed.kind === "project" && !projectReady(await state.workspaces.projects.get(owner.slug, parsed.project), owner)) fail("project is not an active owned agent workspace");
  return { uid: owner.uid, slug: owner.slug, gatewayId: owner.gatewayId, epoch: placed!.epoch, agentId, project: parsed.kind === "project" ? parsed.project : null };
}
export function registerAgentExportBrokerRoutes(router: Router, deps: AgentImportBrokerDeps, context: (res: Response) => OwnerContext): void {
  router.use("/exports", async (_req, res, next) => {
    try {
      const owner = context(res);
      const [builder, workspace] = await Promise.all([deps.store.builders.records.get(owner.uid), deps.store.workspaces.records.get(owner.slug)]);
      if (!interactiveBuilder(builder) || workspace?.ownerUid !== owner.uid || workspace.ownerActive === false) { res.status(403).json({ error: "forbidden" }); return; }
      const decision = await deps.featurePolicy?.evaluate("release-agent-export", { uid: owner.uid, isAdmin: owner.isAdmin, workspaceSlug: owner.slug, ...(owner.planTier ? { planTier: owner.planTier } : {}) }, "agent-export");
      if (!decision || decision.state !== "enabled") { res.status(decision?.state === "unavailable" ? 503 : 404).json({ error: "feature_unavailable" }); return; }
      next();
    } catch (error) { next(error); }
  });
  router.post("/exports/authorize", async (req, res, next) => {
    try { res.json(await deps.store.transaction({ label: "agent-export.authorize", readOnly: true }, tx => authorizeAgentExport(tx, context(res), req.body?.agentId))); } catch (error) { next(error); }
  });
  router.get("/exports/agents", async (_req, res, next) => {
    try {
      const owner = context(res);
      await deps.store.transaction({ label: "agent-export.agents", readOnly: true }, tx => authorizeAgentExport(tx, owner, workspaceCoachAgentId(owner.slug)));
      const identity = await deps.readIdentity(owner.uid);
      const projects = await deps.store.workspaces.projects.listByOwner(owner.uid, owner.slug);
      res.json({ agents: [{ id: workspaceCoachAgentId(owner.slug), label: identity.name || "Private coach" }, ...projects.filter(project => projectReady(project, owner)).map(project => ({ id: projectAgentId(owner.slug, project.projectSlug), label: project.projectSlug }))] });
    } catch (error) { next(error); }
  });
  const id = (value: unknown): string => { if (typeof value !== "string" || !/^export-[a-z0-9-]{1,80}$/u.test(value)) { fail("invalid export id"); } return value as string; };
  const storedRecord = async (owner: OwnerContext, value: string) => (await deps.store.jobs.agentImports.get(owner.uid, value))?.record;
  const owned = (value: unknown, owner: OwnerContext): value is AgentExportRecord => !!value && typeof value === "object" && "kind" in value && value.kind === "authored-agent-export" && "uid" in value && value.uid === owner.uid && "slug" in value && value.slug === owner.slug;
  router.put("/exports/records/:id", async (req, res, next) => {
    try {
      const owner = context(res), key = id(req.params.id), record = req.body as AgentExportRecord;
      if (!owned(record, owner) || record.id !== key || record.approvalHash !== agentExportApproval(record) || !["previewed", "publishing", "complete"].includes(record.status)) fail("invalid export record");
      const { cleanupAt: _cleanupAt, ...payload } = record as AgentExportRecord & { cleanupAt?: unknown };
      const durable = agentImportRecordFromPayload(owner.uid, key, payload, Date.parse(record.createdAt) + EXPORT_RECORD_TTL_MS);
      await deps.store.transaction({ label: "agent-export.record" }, async tx => {
        const current = (await tx.jobs.agentImports.get(owner.uid, key))?.record;
        if (record.status !== "complete") {
          const currentSource = await authorizeAgentExport(tx, owner, record.source.agentId);
          if (record.gatewayId !== owner.gatewayId || exportDigest(currentSource) !== exportDigest(record.source)) fail("export source authority changed");
        } else if (!current?.expectedCommit || current.expectedCommit !== record.expectedCommit) fail("export publication receipt is missing");
        if (current && !journalMatches(current, record)) fail("export journal changed");
        if (!current && record.status !== "previewed") fail("export preview is missing");
        await tx.jobs.agentImports.put(durable);
        await tx.jobs.agentImports.putPointer(owner.uid, "export-latest", { importId: key, slug: null, updatedAt: null });
      });
      res.status(204).end();
    } catch (error) { next(error); }
  });
  router.get("/exports/records/:id", async (req, res, next) => {
    try {
      const owner = context(res);
      const key = req.params.id === "latest" ? (await deps.store.jobs.agentImports.getPointer(owner.uid, "export-latest"))?.importId : req.params.id;
      if (!key) { res.json(null); return; }
      const record = await storedRecord(owner, id(key));
      if (!owned(record, owner)) { res.json(null); return; }
      res.json(record);
    } catch (error) { next(error); }
  });
  router.put("/exports/snapshots/:id", raw({ type: "application/octet-stream", limit: "180mb" }), async (req, res, next) => {
    try {
      const owner = context(res), key = id(req.params.id);
      if (!Buffer.isBuffer(req.body)) fail("invalid export snapshot");
      const existing = await storedRecord(owner, key);
      if (!owned(existing, owner) || existing.status !== "previewed") fail("export preview is missing");
      const object = `agent-imports/${owner.uid}/${key}/export.json`;
      if (deps.exportBlobs) await deps.exportBlobs().save(object, req.body, { contentType: "application/json", ifGenerationMatch: 0 });
      else await deps.bucket.file(object).save(req.body, { contentType: "application/json", resumable: false, preconditionOpts: { ifGenerationMatch: 0 } });
      res.status(204).end();
    } catch (error) { next(error); }
  });
  router.get("/exports/snapshots/:id", async (req, res, next) => {
    try {
      const owner = context(res), key = id(req.params.id);
      if (!owned(await storedRecord(owner, key), owner)) fail("export record is unavailable");
      const object = `agent-imports/${owner.uid}/${key}/export.json`;
      const contents = deps.exportBlobs ? (await deps.exportBlobs().download(object))?.bytes : (await deps.bucket.file(object).download())[0];
      if (!contents) throw new Error("authored export snapshot is missing");
      res.type("application/json").send(contents);
    } catch (error) { next(error); }
  });
}
