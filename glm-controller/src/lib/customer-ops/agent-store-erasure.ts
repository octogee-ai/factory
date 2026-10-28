import { isDeepStrictEqual } from "node:util";
import type { DocumentData, Firestore, Transaction } from "firebase-admin/firestore";
import { CUSTOMER_DELETION_JOBS_COLLECTION } from "@octogee/shared/types/account-lifecycle";
import type { Operation } from "@octogee/shared/types/glm";
import type { AgentStoreErasureCustody, AgentStoreErasureTarget } from "@octogee/core/agent-store-credentials";
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
  db: Firestore;
  now(): number;
  eraseStores(cleanup: CustomerCleanupContext, custody: AgentStoreErasureCustody): Promise<void>;
  sharedGatewayRetired(gatewayId: string): Promise<boolean>;
  runtimeAbsent(gatewayId: string, runtime: "cluster" | "gce-vm"): Promise<boolean>;
  ownerHomeAbsent(uid: string): Promise<boolean>;
  eraseComputer?: (uid: string) => Promise<unknown>;
  readSharedSource(gatewayId: string): Promise<SharedAgentErasureSource | null>;
  unmountSharedCustomer(cleanup: CustomerCleanupContext, coverage: AgentStoreUnmountCoverage, operation: Operation): Promise<void>;
}

function validRetirementProof(value: DocumentData): value is CustomerGatewayRetirementProof {
  return typeof value.gatewayId === "string" && typeof value.operationId === "string" &&
    Number.isSafeInteger(value.version) && value.version > 0 &&
    typeof value.completedAt === "number" && Number.isFinite(value.completedAt) &&
    (value.runtime === "cluster" || value.runtime === "gce-vm");
}

function retirementProofs(job: DocumentData): CustomerGatewayRetirementProof[] {
  const values = Object.values(job.retiredGatewayProofs ?? {});
  if (!values.every(value => value && typeof value === "object" && validRetirementProof(value))) {
    throw new Error("Customer deletion retirement proof is malformed");
  }
  return values as CustomerGatewayRetirementProof[];
}

export async function preserveCustomerGatewayRetirement(db: Firestore, uid: string, deletionId: string, proof: CustomerGatewayRetirementProof): Promise<void> {
  const ref = db.collection(CUSTOMER_DELETION_JOBS_COLLECTION).doc(deletionId);
  await db.runTransaction(async tx => {
    const job = (await tx.get(ref)).data();
    if (!job || job.uid !== uid || !["suspending", "hibernating"].includes(job.status) ||
        typeof job.requestedBy !== "string" || !validRetirementProof(proof)) {
      throw new Error("Customer deletion does not own the gateway retirement proof");
    }
    const prior = job.retiredGatewayProofs?.[proof.gatewayId];
    if (prior && !isDeepStrictEqual(prior, proof)) throw new Error("Customer deletion gateway retirement changed");
    tx.update(ref, { [`retiredGatewayProofs.${proof.gatewayId}`]: proof });
  });
}

function customerAuthorityMatches(user: DocumentData | undefined, cleanup: CustomerCleanupContext, deletionId: string, eraseAfter: number): boolean {
  if (!user) return true;
  const state = user.provisioning?.openclaw ?? {};
  return user.username === cleanup.slug && user.accountLifecycle?.deletionId === deletionId &&
    user.accountLifecycle.eraseAfter === eraseAfter &&
    ["deletion_scheduled", "erasing"].includes(user.accountLifecycle?.status) &&
    !["gatewayId", "migration", "restoreFence", "sourceTransferFence", "runtimeRestartFence"]
      .some(key => state[key] != null);
}

function operationConflicts(data: DocumentData, uid: string, gateways: Set<string>): boolean {
  return data.inputUid === uid || data.input?.uid === uid ||
    [data.gatewayId, data.input?.gatewayId, data.input?.fromGatewayId, data.input?.toGatewayId].some(id => gateways.has(id));
}

function deletionIdentityMatches(job: DocumentData, cleanup: CustomerCleanupContext, operation: Operation): boolean {
  return job.version === 1 && job.uid === cleanup.uid && job.slug === cleanup.slug &&
    job.currentGatewayId === cleanup.currentGatewayId && job.erasureOperationId === operation.id &&
    job.status === "hibernating" && isDeepStrictEqual(job.cleanupContext, cleanup);
}

function deletionConsentIsDue(job: DocumentData, now: number): boolean {
  return typeof job.requestedBy === "string" && job.requestedBy.length > 0 &&
    typeof job.requestedAt === "number" && Number.isFinite(job.requestedAt) &&
    typeof job.eraseAfter === "number" && Number.isFinite(job.eraseAfter) && now >= job.eraseAfter;
}

async function assertDeletionAuthority(
  deps: CustomerAgentStoreErasureDeps,
  tx: Transaction,
  cleanup: CustomerCleanupContext,
  deletionId: string,
  operation: Operation,
): Promise<DocumentData> {
  const [jobSnap, user, current, assignments, operations, roots, transfers] = await Promise.all([
    tx.get(deps.db.collection(CUSTOMER_DELETION_JOBS_COLLECTION).doc(deletionId)),
    tx.get(deps.db.collection("users").doc(cleanup.uid)),
    tx.get(deps.db.collection("glmOperations").doc(operation.id)),
    tx.get(deps.db.collectionGroup("assignments").where("uid", "==", cleanup.uid)),
    tx.get(deps.db.collection("glmOperations").where("status", "in", ["pending", "running"])),
    tx.get(deps.db.collection("gateways").where("ownerUid", "==", cleanup.uid)),
    tx.get(deps.db.collection("glmMigrationTransferTasks").where("status", "==", "running")),
  ]);
  const job = jobSnap.data();
  const currentOperation = current.exists ? current.data() as Operation : null;
  assertActiveOperationClaim(operation, currentOperation);
  if (operation.kind !== "erase-customer" || operation.input.uid !== cleanup.uid || operation.input.deletionId !== deletionId ||
      !job || !deletionIdentityMatches(job, cleanup, operation) || !deletionConsentIsDue(job, deps.now()) ||
      currentOperation?.input.deletionId !== deletionId ||
      !customerAuthorityMatches(user.data(), cleanup, deletionId, job.eraseAfter) || !assignments.empty) {
    throw new Error("Customer PostgreSQL erasure no longer owns its due deletion job");
  }
  const gateways = new Set([cleanup.currentGatewayId, ...retirementProofs(job).map(proof => proof.gatewayId)].filter((id): id is string => typeof id === "string"));
  if (operations.docs.some(doc => doc.id !== operation.id && operationConflicts(doc.data(), cleanup.uid, gateways)) ||
      transfers.docs.some(doc => operationConflicts(doc.data(), cleanup.uid, gateways)) ||
      roots.docs.some(doc => doc.data().desiredStatus !== "retired" || doc.data().runtimeRestartFence != null)) {
    throw new Error("Customer PostgreSQL erasure has conflicting runtime work");
  }
  return job;
}

function retiredRootMatches(state: DocumentData | undefined, proof: CustomerGatewayRetirementProof, uid: string): boolean {
  return !state || (state.ownerUid === uid && state.gatewayClass === "builder" && state.desiredStatus === "retired" &&
    state.retirementVersion === proof.version && state.retirementClaim?.operationId === proof.operationId);
}

async function assertBuilderRetirementAbsent(deps: CustomerAgentStoreErasureDeps, cleanup: CustomerCleanupContext, proof: CustomerGatewayRetirementProof): Promise<void> {
  const [root, runtime, assignments, users, operations] = await Promise.all([
    deps.db.collection("gateways").doc(proof.gatewayId).get(),
    deps.db.collection("glmGateways").doc(proof.gatewayId).get(),
    deps.db.collection("gateways").doc(proof.gatewayId).collection("assignments").get(),
    deps.db.collection("users").where("provisioning.openclaw.gatewayId", "==", proof.gatewayId).get(),
    deps.db.collection("glmOperations").where("gatewayId", "==", proof.gatewayId).get(),
  ]);
  if (!retiredRootMatches(root.data(), proof, cleanup.uid) || runtime.exists || !assignments.empty || !users.empty ||
      operations.docs.some(doc => doc.data().kind === "add-gateway" &&
        (typeof doc.data().createdAt !== "number" || doc.data().createdAt >= proof.completedAt)) ||
      !await deps.runtimeAbsent(proof.gatewayId, proof.runtime)) {
    throw new Error("Customer PostgreSQL erasure retained a gateway runtime or changed retirement");
  }
}

async function assertRetiredCustomerWriters(deps: CustomerAgentStoreErasureDeps, cleanup: CustomerCleanupContext, job: DocumentData): Promise<void> {
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
  const ref = deps.db.collection(CUSTOMER_DELETION_JOBS_COLLECTION).doc(deletionId);
  const complete = await deps.db.runTransaction(async tx => {
    const job = await assertDeletionAuthority(deps, tx, cleanup, deletionId, operation);
    const suspensionId = job.suspensionOperationId;
    if (typeof suspensionId !== "string") throw new Error("Customer PostgreSQL erasure lacks completed suspension cleanup");
    const suspension = (await tx.get(deps.db.collection("glmOperations").doc(suspensionId))).data();
    if (!suspensionCleanupMatches(suspension, cleanup.uid, deletionId)) {
      throw new Error("Customer PostgreSQL erasure lacks completed suspension cleanup");
    }
    const prior = job.sharedAgentStoreCleanup;
    if (prior !== undefined) {
      if (typeof prior.complete !== "boolean" || !Number.isFinite(prior.claimStartedAt) ||
          !isDeepStrictEqual(prior, { ...identity, complete: prior.complete, claimStartedAt: prior.claimStartedAt })) {
        throw new Error("Customer PostgreSQL erasure Shared source or agent coverage changed");
      }
      if (!prior.complete) tx.update(ref, { "sharedAgentStoreCleanup.claimStartedAt": operation.startedAt });
      return prior.complete;
    }
    tx.update(ref, { sharedAgentStoreCleanup: { ...identity, complete: false, claimStartedAt: operation.startedAt } });
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
  if (!complete) await deps.db.runTransaction(async tx => {
    const job = await assertDeletionAuthority(deps, tx, cleanup, deletionId, operation);
    if (!isDeepStrictEqual(job.sharedAgentStoreCleanup, { ...identity, complete: false, claimStartedAt: operation.startedAt })) {
      throw new Error("Customer PostgreSQL erasure Shared cleanup admission changed");
    }
    tx.update(ref, { "sharedAgentStoreCleanup.complete": true });
  });
}

function suspensionCleanupMatches(suspension: DocumentData | undefined, uid: string, deletionId: string): boolean {
  return suspension?.kind === "suspend-customer" && suspension.status === "succeeded" &&
    suspension.input?.uid === uid && suspension.input?.deletionId === deletionId &&
    Array.isArray(suspension.steps) && suspension.steps.some((step: DocumentData) => step.name === "unmount-gateway" && step.status === "done");
}

export function createCustomerAgentStoreErasure(deps: CustomerAgentStoreErasureDeps) {
  return async (cleanup: CustomerCleanupContext, deletionId: string, operation: Operation, assertActiveClaim: (() => Promise<void>) | undefined): Promise<void> => {
    if (!assertActiveClaim) throw new Error("Customer PostgreSQL erasure requires its active operation claim");
    const readAuthority = () => deps.db.runTransaction(tx => assertDeletionAuthority(deps, tx, cleanup, deletionId, operation));
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
      bindTargets: targets => deps.db.runTransaction(async tx => {
        const job = await assertDeletionAuthority(deps, tx, cleanup, deletionId, operation);
        if (job.postgresAgentStoreTargets !== undefined) {
          if (!Array.isArray(job.postgresAgentStoreTargets)) throw new Error("Customer PostgreSQL erasure targets are malformed");
          return job.postgresAgentStoreTargets as AgentStoreErasureTarget[];
        }
        tx.update(deps.db.collection(CUSTOMER_DELETION_JOBS_COLLECTION).doc(deletionId), { postgresAgentStoreTargets: [...targets] });
        return targets;
      }),
    });
  };
}
