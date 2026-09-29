import type { Firestore } from "firebase-admin/firestore";
import { userAssignmentMatchesGateway } from "@octogee/core/assigned-roster";
import { GATEWAY_UNREACHABLE_AFTER_MS } from "@octogee/shared/types/fleet-controller";
import { GATEWAYS_COLLECTION } from "@octogee/shared/types/fleet-controller";
import { customerRestoreFencePresent, GATEWAY_ASSIGNMENTS_SUBCOLLECTION } from "@octogee/shared/types/gateway-releases";
import {
  GLM_GATEWAYS_COLLECTION,
  GLM_OPERATIONS_COLLECTION,
} from "@octogee/shared/types/glm";
import type { SurgeAssignment } from "./surge-customer-handoff.js";

type AssignedUser = { uid: string; slug: string };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function millis(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const timestamp = record(value);
  if (typeof timestamp?.seconds === "number") {
    return timestamp.seconds * 1_000 +
      (typeof timestamp.nanoseconds === "number" ? timestamp.nanoseconds / 1_000_000 : 0);
  }
  if (value && typeof value === "object" && "toMillis" in value) {
    try {
      const result = (value as { toMillis: () => unknown }).toMillis();
      return typeof result === "number" && Number.isFinite(result) ? result : null;
    } catch {
      return null;
    }
  }
  return null;
}

function runtimeProvesAbsent(
  value: unknown,
  gatewayId: string,
  slug: string,
  now: number,
): boolean {
  const runtime = record(value);
  const heartbeat = record(runtime?.heartbeat);
  const mounted = heartbeat?.mountedCustomers;
  const observedAt = millis(heartbeat?.lastHeartbeatAt);
  return runtime?.gatewayId === gatewayId &&
    heartbeat?.status === "ready" &&
    Array.isArray(mounted) &&
    mounted.every((item) => typeof item === "string") &&
    !mounted.includes(slug) &&
    observedAt !== null &&
    observedAt <= now &&
    now - observedAt <= GATEWAY_UNREACHABLE_AFTER_MS;
}

function operationId(gatewayId: string, assignment: SurgeAssignment): string {
  return `surge-prune-orphan-${gatewayId}-${assignment.uid}-${assignment.epoch}`;
}

async function pruneOne(input: {
  db: Firestore;
  gatewayId: string;
  assignment: SurgeAssignment;
  now: number;
}): Promise<boolean | "restore-fenced"> {
  const { db, gatewayId, assignment, now } = input;
  const assignmentRef = db
    .collection(GATEWAYS_COLLECTION)
    .doc(gatewayId)
    .collection(GATEWAY_ASSIGNMENTS_SUBCOLLECTION)
    .doc(assignment.uid);
  const userRef = db.collection("users").doc(assignment.uid);
  const runtimeRef = db.collection(GLM_GATEWAYS_COLLECTION).doc(gatewayId);
  const id = operationId(gatewayId, assignment);
  const operationRef = db.collection(GLM_OPERATIONS_COLLECTION).doc(id);
  return db.runTransaction(async (transaction) => {
    const [assignmentSnapshot, userSnapshot, runtimeSnapshot, operationSnapshot] =
      await Promise.all([
        transaction.get(assignmentRef),
        transaction.get(userRef),
        transaction.get(runtimeRef),
        transaction.get(operationRef),
      ]);
    if (!assignmentSnapshot.exists) return true;
    if (customerRestoreFencePresent(userSnapshot.data())) return "restore-fenced";
    const stored = record(assignmentSnapshot.data());
    if (
      !stored ||
      stored.slug !== assignment.slug ||
      stored.gatewayId !== gatewayId ||
      stored.epoch !== assignment.epoch
    ) {
      return false;
    }
    if (
      userSnapshot.exists &&
      userAssignmentMatchesGateway(
        userSnapshot.data() as Record<string, unknown> | undefined,
        gatewayId,
        assignment.slug,
      )
    ) {
      return false;
    }
    if (!runtimeProvesAbsent(runtimeSnapshot.data(), gatewayId, assignment.slug, now)) {
      return false;
    }
    if (operationSnapshot.exists) {
      throw new Error(`orphan assignment repair journal ${id} already exists while assignment remains`);
    }
    transaction.delete(assignmentRef);
    transaction.set(operationRef, {
      kind: "deprovision-customer",
      status: "succeeded",
      origin: "automatic",
      createdBy: "surge-handoff-orphan-repair",
      createdAt: now,
      startedAt: now,
      completedAt: now,
      lastProgressAt: now,
      input: {
        uid: assignment.uid,
        slug: assignment.slug,
        gatewayId,
        epoch: assignment.epoch,
        reason: "user-not-authoritative-runtime-unmounted",
      },
      output: { assignmentDeleted: true },
      steps: [],
    });
    return true;
  });
}

export async function pruneSurgeOrphanAssignments(input: {
  db: Firestore;
  gatewayId: string;
  assignments: readonly SurgeAssignment[];
  users: readonly AssignedUser[];
  now: number;
  log: (message: string) => void;
}): Promise<SurgeAssignment[]> {
  const usersByUid = new Map(input.users.map((user) => [user.uid, user.slug]));
  const retained: SurgeAssignment[] = [];
  for (const assignment of input.assignments) {
    if (usersByUid.get(assignment.uid) === assignment.slug) {
      retained.push(assignment);
      continue;
    }
    const removed = await pruneOne({
      db: input.db,
      gatewayId: input.gatewayId,
      assignment,
      now: input.now,
    });
    if (removed === "restore-fenced") {
      input.log(`[surge-handoff] orphan assignment retained during unresolved restore gateway=${input.gatewayId} uid=${assignment.uid}`);
    }
    if (removed !== true) {
      retained.push(assignment);
      continue;
    }
    input.log(
      `[surge-handoff] pruned orphan assignment gateway=${input.gatewayId} ` +
      `uid=${assignment.uid} slug=${assignment.slug}`,
    );
  }
  return retained;
}
