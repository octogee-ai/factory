import { createHash } from "node:crypto";

import {
  buildAgentImportApprovalInput,
  buildAgentImportConfigArtifacts,
  planAgentImportConfig,
  validateAgentImportConfigArtifacts,
  type AgentImportConfigArtifacts,
  type AgentImportConfigPlan,
  type AgentImportDoctorOutcome,
} from "@octogee/shared/types/agent-import";
import type {
  AgentImportRepositoryInspection,
} from "./agent-import-git.js";
import type {
  ExtractedAgentImportSource,
} from "./agent-import-source.js";

type JsonObject = Record<string, unknown>;

export interface AgentImportDoctorResult {
  outcome: AgentImportDoctorOutcome;
  doctorVersion: string;
  changedPaths: string[];
  diagnostics: string[];
  repairedCandidate?: JsonObject;
}

export type AgentImportSource =
  | { kind: "github"; owner: string; repo: string; branch: string; head: string }
  | { kind: "local"; head: string; archiveDigest: string; hadGit: boolean; uncommittedFileCount: number };

export interface AgentImportPreview {
  id: string;
  source: AgentImportSource;
  destinationHead: string;
  workspace: {
    commitCount: number;
    fileCount: number;
    totalBytes: number;
    workspaceDigest: string;
    historyPreserved: boolean;
    conflicts: string[];
  };
  doctor: AgentImportDoctorResult;
  config: AgentImportConfigPlan;
  approvalHash: string;
}

export type AgentImportStatus =
  | "previewed"
  | "workspace"
  | "identity"
  | "config"
  | "verifying"
  | "complete"
  | "failed"
  | "rolling_back"
  | "rollback_failed"
  | "rolled_back";

export interface AgentImportRecord {
  id: string;
  uid: string;
  slug: string;
  gatewayId: string;
  status: AgentImportStatus;
  source: AgentImportSource;
  destinationHead: string;
  approvalHash: string;
  preview: AgentImportPreview;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  importCommit?: string;
  rollbackCommit?: string;
  configOutcome?: "applied" | "safe_baseline";
  warnings: string[];
  previousIdentity?: AgentImportIdentity;
  previousRuntime?: JsonObject;
  error?: { code: string; message: string };
}

export interface StoredAgentImportPlan {
  uid: string;
  slug: string;
  gatewayId: string;
  source: AgentImportSource;
  destinationHead: string;
  approvalHash: string;
  artifacts: AgentImportConfigArtifacts;
  config: AgentImportConfigPlan;
}

export interface AgentImportIdentity {
  name?: string;
  persona?: string;
  emoji?: string;
}

export interface AgentImportServiceDeps {
  newId(): string;
  now(): Date;
  readGithubToken(uid: string): Promise<string | null>;
  cloneGithubSource(input: {
    owner: string;
    repo: string;
    branch: string;
    token: string;
  }): { repoDir: string; sourceHead: string; cleanup(): void };
  extractLocalSource(archive: Buffer): Promise<ExtractedAgentImportSource>;
  inspectSource(repoDir: string): Promise<AgentImportRepositoryInspection>;
  workspaceState(slug: string): { targetDir: string; head: string; clean: boolean };
  runDoctor(candidate: JsonObject): Promise<AgentImportDoctorResult>;
  putRecord(record: AgentImportRecord): Promise<void>;
  getRecord(id: string): Promise<AgentImportRecord | null>;
  putPlan(id: string, plan: StoredAgentImportPlan): Promise<void>;
  getPlan(id: string): Promise<StoredAgentImportPlan | null>;
  putArchive(id: string, archive: Buffer): Promise<void>;
  getArchive(id: string): Promise<Buffer | null>;
  deleteStaging(id: string): Promise<void>;
  applyRepository(input: {
    sourceDir: string;
    sourceHead: string;
    targetDir: string;
    destinationHead: string;
    importId: string;
    slug: string;
  }): Promise<{ importCommit: string; sourceRef: string }>;
  rollbackRepository(input: {
    targetDir: string;
    importCommit: string;
    destinationHead: string;
    importId: string;
  }): Promise<{ rollbackCommit: string }>;
  readIdentity(uid: string): Promise<AgentImportIdentity>;
  syncIdentity(uid: string, identity: AgentImportIdentity): Promise<void>;
  withConfigLock<T>(work: () => Promise<T>): Promise<T>;
  invokeOpenClaw(method: string, params: Record<string, unknown>): Promise<unknown>;
}

export class AgentImportServiceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "AgentImportServiceError";
  }
}

function record(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function sha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function configDigest(artifacts: AgentImportConfigArtifacts): string {
  return sha256(buildAgentImportApprovalInput({
    source: { kind: "config" },
    destinationHead: "",
    workspaceDigest: "",
    configDigest: sha256(JSON.stringify(artifacts)),
    resolutions: {},
  }));
}

function approvalHash(input: {
  source: AgentImportSource;
  destinationHead: string;
  workspaceDigest: string;
  artifacts: AgentImportConfigArtifacts;
}): string {
  const source = Object.fromEntries(
    Object.entries(input.source).map(([key, value]) => [key, String(value)]),
  );
  return sha256(buildAgentImportApprovalInput({
    source,
    destinationHead: input.destinationHead,
    workspaceDigest: input.workspaceDigest,
    configDigest: configDigest(input.artifacts),
    resolutions: {},
  }));
}

function adaptedArtifacts(
  original: AgentImportConfigArtifacts,
  doctor: AgentImportDoctorResult,
): { artifacts: AgentImportConfigArtifacts; outcome: AgentImportDoctorOutcome } {
  if (
    (doctor.outcome !== "migrated" && doctor.outcome !== "unchanged") ||
    !doctor.repairedCandidate
  ) {
    return { artifacts: original, outcome: doctor.outcome };
  }
  try {
    const repaired = buildAgentImportConfigArtifacts(
      doctor.repairedCandidate,
      original.portableAgent.sourceAgentId,
    );
    return {
      artifacts: validateAgentImportConfigArtifacts({
        ...repaired,
        configInventory: original.configInventory,
      }),
      outcome: doctor.outcome,
    };
  } catch {
    return { artifacts: original, outcome: "failed" };
  }
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

function configGet(value: unknown): { config: JsonObject; hash: string } {
  const result = record(value);
  const config = record(result?.config);
  const hash = result?.hash;
  if (!config || typeof hash !== "string" || !hash) {
    throw new AgentImportServiceError("config_get_failed", "OpenClaw returned no config hash");
  }
  return { config, hash };
}

function coachFromConfig(config: JsonObject, coachId: string): JsonObject {
  const agents = record(config.agents);
  const list = agents?.list;
  if (!Array.isArray(list)) {
    throw new AgentImportServiceError("coach_config_missing", "OpenClaw config has no agent list");
  }
  const matches = list.flatMap((entry) => {
    const agent = record(entry);
    return agent?.id === coachId ? [agent] : [];
  });
  if (matches.length !== 1) {
    throw new AgentImportServiceError("coach_config_missing", "Octogee coach config is missing or ambiguous");
  }
  return matches[0];
}

function previousRuntime(coach: JsonObject, patch: JsonObject): JsonObject {
  return Object.fromEntries(Object.keys(patch).map((key) => [
    key,
    Object.prototype.hasOwnProperty.call(coach, key) ? cloneValue(coach[key]) : null,
  ]));
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertRuntimeApplied(config: JsonObject, coachId: string, patch: JsonObject): void {
  const coach = coachFromConfig(config, coachId);
  for (const [key, value] of Object.entries(patch)) {
    if (!deepEqual(coach[key], value)) {
      throw new AgentImportServiceError("config_readback_failed", `OpenClaw did not retain ${key}`);
    }
  }
}

function assertRuntimeRestored(config: JsonObject, coachId: string, previous: JsonObject): void {
  const coach = coachFromConfig(config, coachId);
  for (const [key, value] of Object.entries(previous)) {
    const present = Object.prototype.hasOwnProperty.call(coach, key);
    if (value === null ? present && coach[key] !== null : !deepEqual(coach[key], value)) {
      throw new AgentImportServiceError("config_readback_failed", `OpenClaw did not restore ${key}`);
    }
  }
}

export class AgentImportService {
  private readonly activeApplies = new Map<string, Promise<AgentImportRecord>>();
  private readonly activeRollbacks = new Map<string, Promise<AgentImportRecord>>();

  constructor(private readonly deps: AgentImportServiceDeps) {}

  async previewGithub(input: {
    uid: string;
    slug: string;
    gatewayId: string;
    owner: string;
    repo: string;
    branch: string;
    artifacts: AgentImportConfigArtifacts;
  }): Promise<AgentImportPreview> {
    const artifacts = validateAgentImportConfigArtifacts(input.artifacts);
    const token = await this.deps.readGithubToken(input.uid);
    if (!token) throw new AgentImportServiceError("github_not_connected", "GitHub is not connected");
    const source = this.deps.cloneGithubSource({
      owner: input.owner,
      repo: input.repo,
      branch: input.branch,
      token,
    });
    try {
      const inspected = await this.deps.inspectSource(source.repoDir);
      if (inspected.head !== source.sourceHead) {
        throw new AgentImportServiceError("source_changed", "GitHub source changed during preview");
      }
      return await this.persistPreview({
        uid: input.uid,
        slug: input.slug,
        gatewayId: input.gatewayId,
        artifacts,
        inspected,
        source: {
          kind: "github",
          owner: input.owner,
          repo: input.repo,
          branch: input.branch,
          head: source.sourceHead,
        },
      });
    } finally {
      source.cleanup();
    }
  }

  async previewLocal(input: {
    uid: string;
    slug: string;
    gatewayId: string;
    archive: Buffer;
  }): Promise<AgentImportPreview> {
    const extracted = await this.deps.extractLocalSource(input.archive);
    try {
      const inspected = await this.deps.inspectSource(extracted.repoDir);
      if (inspected.head !== extracted.sourceHead) {
        throw new AgentImportServiceError("source_changed", "local source changed during preview");
      }
      const preview = await this.persistPreview({
        uid: input.uid,
        slug: input.slug,
        gatewayId: input.gatewayId,
        artifacts: extracted.artifacts,
        inspected,
        source: {
          kind: "local",
          head: extracted.sourceHead,
          archiveDigest: sha256(input.archive),
          hadGit: extracted.manifest.hadGit,
          uncommittedFileCount: extracted.manifest.uncommittedFileCount,
        },
        archive: input.archive,
      });
      return preview;
    } finally {
      extracted.cleanup();
    }
  }

  private async persistPreview(input: {
    uid: string;
    slug: string;
    gatewayId: string;
    artifacts: AgentImportConfigArtifacts;
    inspected: AgentImportRepositoryInspection;
    source: AgentImportSource;
    archive?: Buffer;
  }): Promise<AgentImportPreview> {
    const destination = this.deps.workspaceState(input.slug);
    if (!destination.clean) {
      throw new AgentImportServiceError("destination_dirty", "commit or discard Octogee workspace changes before import");
    }
    let doctor: AgentImportDoctorResult;
    try {
      doctor = await this.deps.runDoctor(input.artifacts.doctorCandidate);
    } catch {
      doctor = {
        outcome: "failed",
        doctorVersion: "unavailable",
        changedPaths: [],
        diagnostics: ["doctor_unavailable"],
      };
    }
    const adapted = adaptedArtifacts(input.artifacts, doctor);
    const config = planAgentImportConfig(adapted.artifacts, { doctorOutcome: adapted.outcome });
    const id = this.deps.newId();
    const hash = approvalHash({
      source: input.source,
      destinationHead: destination.head,
      workspaceDigest: input.inspected.workspaceDigest,
      artifacts: adapted.artifacts,
    });
    const preview: AgentImportPreview = {
      id,
      source: input.source,
      destinationHead: destination.head,
      workspace: {
        commitCount: input.inspected.commitCount,
        fileCount: input.inspected.fileCount,
        totalBytes: input.inspected.totalBytes,
        workspaceDigest: input.inspected.workspaceDigest,
        historyPreserved: input.inspected.commitCount > 0,
        conflicts: [],
      },
      doctor: { ...doctor, ...(adapted.outcome !== doctor.outcome ? { outcome: adapted.outcome } : {}) },
      config,
      approvalHash: hash,
    };
    const timestamp = this.deps.now().toISOString();
    try {
      await this.deps.putPlan(id, {
        uid: input.uid,
        slug: input.slug,
        gatewayId: input.gatewayId,
        source: input.source,
        destinationHead: destination.head,
        approvalHash: hash,
        artifacts: adapted.artifacts,
        config,
      });
      if (input.archive) await this.deps.putArchive(id, input.archive);
      await this.deps.putRecord({
        id,
        uid: input.uid,
        slug: input.slug,
        gatewayId: input.gatewayId,
        status: "previewed",
        source: input.source,
        destinationHead: destination.head,
        approvalHash: hash,
        preview,
        createdAt: timestamp,
        updatedAt: timestamp,
        completedAt: null,
        warnings: [],
      });
    } catch (error) {
      await this.deps.deleteStaging(id);
      throw error;
    }
    return preview;
  }

  async apply(input: { uid: string; importId: string; approvalHash: string }): Promise<AgentImportRecord> {
    const key = `${input.uid}\0${input.importId}\0${input.approvalHash}`;
    const active = this.activeApplies.get(key);
    if (active) return active;
    const work = this.applyOnce(input);
    this.activeApplies.set(key, work);
    try {
      return await work;
    } finally {
      if (this.activeApplies.get(key) === work) this.activeApplies.delete(key);
    }
  }

  private async applyOnce(input: { uid: string; importId: string; approvalHash: string }): Promise<AgentImportRecord> {
    let current = await this.ownedRecord(input.importId, input.uid);
    if (current.status === "complete") return current;
    if (current.status !== "previewed" && current.status !== "workspace" && current.status !== "identity" && current.status !== "config" && current.status !== "verifying" && current.status !== "failed") {
      throw new AgentImportServiceError("invalid_import_state", `cannot apply import in ${current.status}`);
    }
    if (current.approvalHash !== input.approvalHash) {
      throw new AgentImportServiceError("approval_mismatch", "approval hash does not match the preview");
    }
    const plan = await this.deps.getPlan(input.importId);
    if (!plan || plan.uid !== input.uid || plan.approvalHash !== input.approvalHash) {
      throw new AgentImportServiceError("import_plan_missing", "approved import plan is unavailable");
    }
    try {
      if (!current.importCommit) {
        const source = await this.sourceForPlan(plan, input.importId);
        try {
          const inspected = await this.deps.inspectSource(source.repoDir);
          if (inspected.head !== plan.source.head) {
            throw new AgentImportServiceError("source_changed", "source changed after preview");
          }
          const destination = this.deps.workspaceState(plan.slug);
          if (!destination.clean) {
            throw new AgentImportServiceError("destination_changed", "Octogee workspace changed after preview");
          }
          current = await this.update(current, { status: "workspace" });
          const applied = await this.deps.applyRepository({
            sourceDir: source.repoDir,
            sourceHead: plan.source.head,
            targetDir: destination.targetDir,
            destinationHead: plan.destinationHead,
            importId: input.importId,
            slug: plan.slug,
          });
          current = await this.update(current, { importCommit: applied.importCommit });
        } finally {
          source.cleanup();
        }
      }
      if (!current.previousIdentity) {
        current = await this.update(current, {
          status: "identity",
          previousIdentity: await this.deps.readIdentity(plan.uid),
        });
      }
      await this.deps.syncIdentity(plan.uid, plan.config.identity);
      current = await this.update(current, {
        status: "config",
      });
      const configured = await this.applyRuntimeConfig(
        plan.slug,
        plan.config.runtimePatch,
        current.previousRuntime,
        async (previous) => {
          current = await this.update(current, { status: "config", previousRuntime: previous });
        },
      );
      const warnings = configured.outcome === "safe_baseline"
        ? [...new Set([...current.warnings, "config_delta_rejected"])]
        : current.warnings;
      current = await this.update(current, {
        status: "verifying",
        configOutcome: configured.outcome,
        previousRuntime: configured.previous,
        warnings,
      });
      const completedAt = this.deps.now().toISOString();
      current = await this.update(current, {
        status: "complete",
        completedAt,
      });
      try {
        await this.deps.deleteStaging(input.importId);
      } catch {
        current = await this.update(current, {
          warnings: [...new Set([...current.warnings, "staging_cleanup_pending"])],
        });
      }
      return current;
    } catch (error) {
      await this.update(current, {
        status: "failed",
        error: {
          code: error instanceof AgentImportServiceError ? error.code : "agent_import_failed",
          message: error instanceof Error ? error.message : String(error),
        },
      });
      throw error;
    }
  }

  async rollback(input: { uid: string; importId: string }): Promise<AgentImportRecord> {
    const key = `${input.uid}\0${input.importId}`;
    const active = this.activeRollbacks.get(key);
    if (active) return active;
    const work = this.rollbackOnce(input);
    this.activeRollbacks.set(key, work);
    try {
      return await work;
    } finally {
      if (this.activeRollbacks.get(key) === work) this.activeRollbacks.delete(key);
    }
  }

  private async rollbackOnce(input: { uid: string; importId: string }): Promise<AgentImportRecord> {
    let current = await this.ownedRecord(input.importId, input.uid);
    if (current.status === "rolled_back") return current;
    if (!["complete", "rolling_back", "rollback_failed"].includes(current.status) || !current.importCommit) {
      throw new AgentImportServiceError("rollback_window_closed", "only a completed unchanged import can be rolled back");
    }
    if (!current.completedAt || this.deps.now().getTime() - Date.parse(current.completedAt) > 7 * 24 * 60 * 60 * 1_000) {
      throw new AgentImportServiceError("rollback_window_closed", "the seven-day rollback window has closed");
    }
    try {
      if (!current.rollbackCommit) {
        const target = this.deps.workspaceState(current.slug);
        const result = await this.deps.rollbackRepository({
          targetDir: target.targetDir,
          importCommit: current.importCommit,
          destinationHead: current.destinationHead,
          importId: current.id,
        });
        current = await this.update(current, {
          status: "rolling_back",
          rollbackCommit: result.rollbackCommit,
        });
      }
      if (current.previousIdentity) await this.deps.syncIdentity(current.uid, current.previousIdentity);
      if (current.previousRuntime && Object.keys(current.previousRuntime).length > 0) {
        await this.patchRuntime(current.slug, current.previousRuntime);
      }
      current = await this.update(current, {
        status: "rolled_back",
      });
      return current;
    } catch (error) {
      await this.update(current, {
        status: "rollback_failed",
        error: {
          code: error instanceof AgentImportServiceError ? error.code : "agent_import_rollback_failed",
          message: error instanceof Error ? error.message : String(error),
        },
      });
      throw error;
    }
  }

  async get(input: { uid: string; importId: string }): Promise<AgentImportRecord> {
    return this.ownedRecord(input.importId, input.uid);
  }

  private async sourceForPlan(
    plan: StoredAgentImportPlan,
    importId: string,
  ): Promise<{ repoDir: string; sourceHead: string; cleanup(): void }> {
    if (plan.source.kind === "github") {
      const token = await this.deps.readGithubToken(plan.uid);
      if (!token) throw new AgentImportServiceError("github_not_connected", "GitHub was disconnected after preview");
      return this.deps.cloneGithubSource({
        owner: plan.source.owner,
        repo: plan.source.repo,
        branch: plan.source.branch,
        token,
      });
    }
    const archive = await this.deps.getArchive(importId);
    if (!archive || sha256(archive) !== plan.source.archiveDigest) {
      throw new AgentImportServiceError("local_archive_missing", "local import archive is missing or changed");
    }
    return this.deps.extractLocalSource(archive);
  }

  private async applyRuntimeConfig(
    slug: string,
    runtimePatch: JsonObject,
    checkpointedPrevious: JsonObject | undefined,
    checkpoint: (previous: JsonObject) => Promise<void>,
  ): Promise<{ outcome: "applied" | "safe_baseline"; previous: JsonObject }> {
    if (Object.keys(runtimePatch).length === 0) {
      if (!checkpointedPrevious) await checkpoint({});
      return { outcome: "safe_baseline", previous: checkpointedPrevious ?? {} };
    }
    const coachId = `octogee-${slug}-coach`;
    return this.deps.withConfigLock(async () => {
      const before = configGet(await this.deps.invokeOpenClaw("config.get", {}));
      const previous = checkpointedPrevious ?? previousRuntime(coachFromConfig(before.config, coachId), runtimePatch);
      if (!checkpointedPrevious) await checkpoint(previous);
      try {
        await this.deps.invokeOpenClaw("config.patch", {
          raw: JSON.stringify({ agents: { list: [{ id: coachId, ...runtimePatch }] } }),
          baseHash: before.hash,
        });
        const after = configGet(await this.deps.invokeOpenClaw("config.get", {}));
        assertRuntimeApplied(after.config, coachId, runtimePatch);
        await this.deps.invokeOpenClaw("health", {});
        return { outcome: "applied", previous };
      } catch {
        const rollbackBase = configGet(await this.deps.invokeOpenClaw("config.get", {}));
        await this.deps.invokeOpenClaw("config.patch", {
          raw: JSON.stringify({ agents: { list: [{ id: coachId, ...previous }] } }),
          baseHash: rollbackBase.hash,
        });
        const restored = configGet(await this.deps.invokeOpenClaw("config.get", {}));
        assertRuntimeRestored(restored.config, coachId, previous);
        await this.deps.invokeOpenClaw("health", {});
        return { outcome: "safe_baseline", previous };
      }
    });
  }

  private async patchRuntime(slug: string, patch: JsonObject): Promise<void> {
    if (Object.keys(patch).length === 0) return;
    const coachId = `octogee-${slug}-coach`;
    await this.deps.withConfigLock(async () => {
      const before = configGet(await this.deps.invokeOpenClaw("config.get", {}));
      await this.deps.invokeOpenClaw("config.patch", {
        raw: JSON.stringify({ agents: { list: [{ id: coachId, ...patch }] } }),
        baseHash: before.hash,
      });
      const after = configGet(await this.deps.invokeOpenClaw("config.get", {}));
      assertRuntimeRestored(after.config, coachId, patch);
      await this.deps.invokeOpenClaw("health", {});
    });
  }

  private async ownedRecord(importId: string, uid: string): Promise<AgentImportRecord> {
    const record = await this.deps.getRecord(importId);
    if (!record) throw new AgentImportServiceError("import_not_found", "agent import was not found");
    if (record.uid !== uid) throw new AgentImportServiceError("forbidden", "agent import belongs to another builder");
    return record;
  }

  private async update(
    current: AgentImportRecord,
    patch: Partial<AgentImportRecord>,
  ): Promise<AgentImportRecord> {
    const next: AgentImportRecord = {
      ...current,
      ...cloneValue(patch),
      updatedAt: this.deps.now().toISOString(),
    };
    if (patch.status && patch.status !== "failed") delete next.error;
    await this.deps.putRecord(next);
    return next;
  }
}
