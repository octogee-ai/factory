import { isDeepStrictEqual } from "node:util";
import type { Operation } from "@octogee/shared/types/glm";
import type { AgentStoreErasureCustody, AgentStoreErasureTarget } from "@octogee/core/agent-store-credentials";
import type {
  BuilderRecord,
  CustomerDeletionJob,
  GatewayRoot,
  MigrationTransferTask,
  OperationRecord,
  PlatformStateStore,
  PlatformStateTransaction,
  Stored,
} from "@octogee/core/platform-state";
import type { CustomerCleanupContext } from "../../handlers/deprovision-customer.js";
import { assertActiveOperationClaim } from "../../operation-context.js";
import type { CustomerGatewayRetirementProof } from "./customer-gateway-retirement.js";
import { agentIdBelongsToSlug } from "@octogee/shared/types/agent-models";
import type { AgentStoreUnmountCoverage } from "@octogee/shared/types/fleet-controller";

export interface SharedAgentErasureSource {
  gatewayId: string;
  podUid: string;
  startedAt: number;
  status: string;
  customers: string[];
  migratingIn: string[];
}

export interface CustomerAgentStoreErasureDeps {
  store: PlatformStateStore;
  now(): number;
  eraseStores(cleanup: CustomerCleanupContext, custody: AgentStoreErasureCustody): Promise<void>;
  sharedGatewayRetired(gatewayId: string): Promise<boolean>;
  runtimeAbsent(gatewayId: string, runtime: "cluster" | "gce-vm"): Promise<boolean>;
  ownerHomeAbsent(uid: string): Promise<boolean>;
  eraseComputer?: (uid: string) => Promise<unknown>;
  readSharedSource(gatewayId: string): Promise<SharedAgentErasureSource | null>;
  unmountSharedCustomer(cleanup: CustomerCleanupContext, coverage: AgentStoreUnmountCoverage, operation: Operation): Promise<void>;
}

function isMap(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validRetirementProof(value: unknown): value is CustomerGatewayRetirementProof {
  return isMap(value) && typeof value.gatewayId === "string" && typeof value.operationId === "string" &&
    Number.isSafeInteger(value.version) && (value.version as number) > 0 &&
    typeof value.completedAt === "number" && Number.isFinite(value.completedAt) &&
    (value.runtime === "cluster" || value.runtime === "gce-vm");
}

function retirementProofs(job: CustomerDeletionJob): CustomerGatewayRetirementProof[] {
  const values: unknown[] = Object.values(job.retiredGatewayProofs ?? {});
  if (!values.every(validRetirementProof)) {
    throw new Error("Customer deletion retirement proof is malformed");
  }
  return values;
}

export async function preserveCustomerGatewayRetirement(
  store: PlatformStateStore,
  uid: string,
  deletionId: string,
  proof: CustomerGatewayRetirementProof,
): Promise<void> {
  await store.transaction({ label: "customer-deletion.preserve-gateway-retirement" }, async (transaction) => {
    const job = await transaction.jobs.deletions.get(deletionId);
    if (job === null || job.uid !== uid || !["suspending", "hibernating"].includes(job.status) ||
        typeof job.requestedBy !== "string" || !validRetirementProof(proof)) {
      throw new Error("Customer deletion does not own the gateway retirement proof");
    }
    const prior = job.retiredGatewayProofs?.[proof.gatewayId];
    if (prior && !isDeepStrictEqual(prior, proof)) throw new Error("Customer deletion gateway retirement changed");
    await transaction.jobs.deletions.recordRetiredGatewayProof(deletionId, proof.gatewayId, { ...proof });
  });
}

function customerAuthorityMatches(builder: BuilderRecord | null, cleanup: CustomerCleanupContext, deletionId: string, eraseAfter: number): boolean {
  if (builder === null) return true;
  const lifecycle = builder.accountLifecycle;
  return builder.slug === cleanup.slug && lifecycle?.deletionId === deletionId &&
    lifecycle.eraseAfter === eraseAfter && ["deletion_scheduled", "erasing"].includes(lifecycle.status) &&
    builder.gateway === null && builder.fences.migration === undefined &&
    builder.fences.restoreFence === undefined && builder.fences.sourceTransferFence === undefined;
}

function operationConflicts(operation: OperationRecord, uid: string, gateways: Set<string>): boolean {
  const input = operation.input as Record<string, unknown> | undefined;
  return operation.inputUid === uid || input?.uid === uid ||
    [operation.gatewayId, input?.gatewayId, input?.fromGatewayId, input?.toGatewayId]
      .some(id => typeof id === "string" && gateways.has(id));
}

function transferConflicts(task: MigrationTransferTask, slug: string, gateways: Set<string>): boolean {
  return task.slug === slug || gateways.has(task.sourceGatewayId) || gateways.has(task.targetGatewayId);
}

function deletionIdentityMatches(job: CustomerDeletionJob, cleanup: CustomerCleanupContext, operation: Operation): boolean {
  return job.version === 1 && job.uid === cleanup.uid && job.slug === cleanup.slug &&
    job.currentGatewayId === cleanup.currentGatewayId && job.erasureOperationId === operation.id &&
    job.status === "hibernating" && isDeepStrictEqual(job.cleanupContext, cleanup);
}

function deletionConsentIsDue(job: CustomerDeletionJob, now: number): boolean {
  return typeof job.requestedBy === "string" && job.requestedBy.length > 0 &&
    Number.isFinite(job.requestedAt) && Number.isFinite(job.eraseAfter) && now >= job.eraseAfter;
}

async function assertDeletionAuthority(
  deps: CustomerAgentStoreErasureDeps,
  transaction: PlatformStateTransaction,
  cleanup: CustomerCleanupContext,
  deletionId: string,
  operation: Operation,
): Promise<Stored<CustomerDeletionJob>> {
  const [job, builder, currentOperation, assignments, operations, roots, transfers] = await Promise.all([
    transaction.jobs.deletions.get(deletionId),
    transaction.builders.records.get(cleanup.uid),
    transaction.journal.operations.get(operation.id),
    transaction.gateways.assignments.listForUid(cleanup.uid),
    transaction.journal.operations.listByStatus(["pending", "running"]),
    transaction.gateways.roots.list({ ownerUid: cleanup.uid }),
    transaction.migrationTasks.listByStatus(["running"]),
  ]);
  assertActiveOperationClaim(operation, currentOperation);
  if (operation.kind !== "erase-customer" || operation.input.uid !== cleanup.uid || operation.input.deletionId !== deletionId ||
      job === null || !deletionIdentityMatches(job, cleanup, operation) || !deletionConsentIsDue(job, deps.now()) ||
      currentOperation?.input.deletionId !== deletionId ||
      !customerAuthorityMatches(builder, cleanup, deletionId, job.eraseAfter) || assignments.length > 0) {
    throw new Error("Customer PostgreSQL erasure no longer owns its due deletion job");
  }
  const gateways = new Set([cleanup.currentGatewayId, ...retirementProofs(job).map(proof => proof.gatewayId)].filter((id): id is string => typeof id === "string"));
  if (operations.some(candidate => candidate.id !== operation.id && operationConflicts(candidate, cleanup.uid, gateways)) ||
      transfers.some(task => transferConflicts(task, cleanup.slug, gateways)) ||
      roots.some(root => root.desiredStatus !== "retired" || root.runtimeRestartFence != null)) {
    throw new Error("Customer PostgreSQL erasure has conflicting runtime work");
  }
  return job;
}

function retiredRootMatches(root: GatewayRoot | null, proof: CustomerGatewayRetirementProof, uid: string): boolean {
  return root === null || (root.ownerUid === uid && root.gatewayClass === "builder" && root.desiredStatus === "retired" &&
    root.retirementVersion === proof.version && root.retirementClaim?.operationId === proof.operationId);
}

async function assertBuilderRetirementAbsent(deps: CustomerAgentStoreErasureDeps, cleanup: CustomerCleanupContext, proof: CustomerGatewayRetirementProof): Promise<void> {
  const [root, runtime, assignmentsEmpty, builders, operations] = await Promise.all([
    deps.store.gateways.roots.get(proof.gatewayId),
    deps.store.fleetRegistry.get(proof.gatewayId),
    deps.store.gateways.assignments.isEmpty(proof.gatewayId),
    deps.store.builders.records.listByGateway(proof.gatewayId, { limit: 1 }),
    deps.store.journal.operations.listByGateway(proof.gatewayId),
  ]);
  if (!retiredRootMatches(root, proof, cleanup.uid) || runtime !== null || !assignmentsEmpty || builders.length > 0 ||
      operations.some(candidate => candidate.kind === "add-gateway" &&
        (typeof candidate.createdAt !== "number" || candidate.createdAt >= proof.completedAt)) ||
      !await deps.runtimeAbsent(proof.gatewayId, proof.runtime)) {
    throw new Error("Customer PostgreSQL erasure retained a gateway runtime or changed retirement");
  }
}

async function assertRetiredCustomerWriters(deps: CustomerAgentStoreErasureDeps, cleanup: CustomerCleanupContext, job: CustomerDeletionJob): Promise<void> {
  const proofs = retirementProofs(job);
  if (!cleanup.currentGatewayId) throw new Error("Customer PostgreSQL erasure lacks its captured source gateway");
  if (!cleanup.currentGatewayId.startsWith("shared-") && !proofs.some(proof => proof.gatewayId === cleanup.currentGatewayId)) {
    throw new Error("Customer PostgreSQL erasure lacks its captured Builder retirement proof");
  }
  for (const proof of proofs) await assertBuilderRetirementAbsent(deps, cleanup, proof);
}

function sharedSourceAvailable(source: SharedAgentErasureSource | null, gatewayId: string): source is SharedAgentErasureSource {
  return source?.gatewayId === gatewayId && source.status === "ready" && typeof source.podUid === "string" &&
    source.podUid.length > 0 && typeof source.startedAt === "number" && Number.isFinite(source.startedAt) && source.startedAt > 0 &&
    Array.isArray(source.customers) && source.customers.every(id => typeof id === "string") &&
    Array.isArray(source.migratingIn) && source.migratingIn.every(id => typeof id === "string");
}

async function assertSharedCustomerStopped(
  deps: CustomerAgentStoreErasureDeps, cleanup: CustomerCleanupContext,
  input: { deletionId: string; operation: Operation; targets: readonly AgentStoreErasureTarget[]; assertCurrent(): Promise<void> },
): Promise<void> {
  const { deletionId, operation, targets, assertCurrent } = input;
  const gatewayId = cleanup.currentGatewayId!;
  if (await deps.sharedGatewayRetired(gatewayId)) return;
  const source = await deps.readSharedSource(gatewayId);
  if (!sharedSourceAvailable(source, gatewayId) || source.migratingIn.includes(cleanup.slug)) {
    throw new Error("Customer PostgreSQL erasure awaits captured Shared retirement or confirmed Native customer cleanup");
  }
  const agentIds = [...new Set(targets.flatMap(target => target.family === "agent" && agentIdBelongsToSlug(target.agentId, cleanup.slug) ? [target.agentId] : []))].sort();
  const identity = { gatewayId, podUid: source.podUid, startedAt: source.startedAt, agentIds, operationId: operation.id };
  const complete = await deps.store.transaction({ label: "customer-deletion.shared-agent-store-cleanup.claim" }, async (transaction) => {
    const job = await assertDeletionAuthority(deps, transaction, cleanup, deletionId, operation);
    const suspensionId = job.suspensionOperationId;
    if (suspensionId === undefined) throw new Error("Customer PostgreSQL erasure lacks completed suspension cleanup");
    const suspension = await transaction.journal.operations.get(suspensionId);
    if (!suspensionCleanupMatches(suspension, cleanup.uid, deletionId)) {
      throw new Error("Customer PostgreSQL erasure lacks completed suspension cleanup");
    }
    const prior = job.sharedAgentStoreCleanup;
    if (prior !== undefined) {
      if (typeof prior.complete !== "boolean" || !Number.isFinite(prior.claimStartedAt) ||
          !isDeepStrictEqual(prior, { ...identity, complete: prior.complete, claimStartedAt: prior.claimStartedAt })) {
        throw new Error("Customer PostgreSQL erasure Shared source or agent coverage changed");
      }
      if (!prior.complete) {
        await transaction.jobs.deletions.patch(deletionId,
          { sharedAgentStoreCleanup: { ...prior, claimStartedAt: operation.startedAt } }, { revision: job.revision });
      }
      return prior.complete;
    }
    await transaction.jobs.deletions.patch(deletionId,
      { sharedAgentStoreCleanup: { ...identity, complete: false, claimStartedAt: operation.startedAt } }, { revision: job.revision });
    return false;
  });
  if (!complete) {
    await assertCurrent();
    await deps.unmountSharedCustomer(cleanup, { podUid: source.podUid, agentIds }, operation);
    await assertCurrent();
  }
  const current = complete ? source : await deps.readSharedSource(gatewayId);
  if (!sharedSourceAvailable(current, gatewayId) || current.podUid !== source.podUid || current.startedAt !== source.startedAt ||
      current.customers.includes(cleanup.slug) || current.migratingIn.includes(cleanup.slug)) {
    throw new Error("Customer PostgreSQL erasure Shared runtime changed or retained the customer");
  }
  if (!complete) {
    await deps.store.transaction({ label: "customer-deletion.shared-agent-store-cleanup.complete" }, async (transaction) => {
      const job = await assertDeletionAuthority(deps, transaction, cleanup, deletionId, operation);
      const claimed = { ...identity, complete: false, claimStartedAt: operation.startedAt };
      if (!isDeepStrictEqual(job.sharedAgentStoreCleanup, claimed)) {
        throw new Error("Customer PostgreSQL erasure Shared cleanup admission changed");
      }
      await transaction.jobs.deletions.patch(deletionId,
        { sharedAgentStoreCleanup: { ...claimed, complete: true } }, { revision: job.revision });
    });
  }
}

function suspensionCleanupMatches(suspension: OperationRecord | null, uid: string, deletionId: string): boolean {
  return suspension?.kind === "suspend-customer" && suspension.status === "succeeded" &&
    suspension.input?.uid === uid && suspension.input?.deletionId === deletionId &&
    Array.isArray(suspension.steps) && suspension.steps.some(step => step.name === "unmount-gateway" && step.status === "done");
}

export function createCustomerAgentStoreErasure(deps: CustomerAgentStoreErasureDeps) {
  return async (cleanup: CustomerCleanupContext, deletionId: string, operation: Operation, assertActiveClaim: (() => Promise<void>) | undefined): Promise<void> => {
    if (!assertActiveClaim) throw new Error("Customer PostgreSQL erasure requires its active operation claim");
    const readAuthority = () => deps.store.transaction(
      { label: "customer-deletion.agent-store-erasure.authority", readOnly: true },
      transaction => assertDeletionAuthority(deps, transaction, cleanup, deletionId, operation),
    );
    const assertCurrent = async () => { await assertActiveClaim(); await readAuthority(); };
    await assertCurrent();
    await deps.eraseStores(cleanup, {
      assertCurrent,
      assertWritersStopped: async targets => {
        const job = await readAuthority();
        await assertRetiredCustomerWriters(deps, cleanup, job);
        if (cleanup.currentGatewayId!.startsWith("shared-")) {
          await assertSharedCustomerStopped(deps, cleanup, { deletionId, operation, targets, assertCurrent });
        }
        if (!await deps.ownerHomeAbsent(cleanup.uid)) {
          await assertCurrent();
          if (!deps.eraseComputer) throw new Error("Customer PostgreSQL erasure retained a Builder computer or home");
          await deps.eraseComputer(cleanup.uid);
          await assertCurrent();
          if (!await deps.ownerHomeAbsent(cleanup.uid)) throw new Error("Customer PostgreSQL erasure retained a Builder computer or home");
        }
        await assertCurrent();
        return [cleanup.currentGatewayId!, ...retirementProofs(job).map(proof => proof.gatewayId)];
      },
      bindTargets: targets => deps.store.transaction({ label: "customer-deletion.agent-store-erasure.bind-targets" }, async (transaction) => {
        const job = await assertDeletionAuthority(deps, transaction, cleanup, deletionId, operation);
        if (job.postgresAgentStoreTargets !== undefined) {
          return job.postgresAgentStoreTargets as unknown as readonly AgentStoreErasureTarget[];
        }
        await transaction.jobs.deletions.patch(deletionId,
          { postgresAgentStoreTargets: targets.map(target => ({ ...target })) }, { revision: job.revision });
        return targets;
      }),
    });
  };
}
