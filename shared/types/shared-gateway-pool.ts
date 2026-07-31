import {
  isOperatorManaged,
  isValidGatewayId,
  type GatewayDesiredStatus,
} from "./glm.js";

export const PRIMARY_SHARED_GATEWAY_ID = "shared-a";
export const STANDARD_SHARED_GATEWAY_IDS = [
  PRIMARY_SHARED_GATEWAY_ID,
  "shared-b",
  "shared-c",
  "shared-d",
] as const;
export const DEFAULT_SHARED_GATEWAY_MIN_HOT_MEMBERS = 2;
export const DEFAULT_SHARED_GATEWAY_TARGET_ASSIGNMENTS_PER_MEMBER = 4;
export const DEFAULT_SHARED_GATEWAY_AUTOSCALING_COOLDOWN_MS = 300_000;

export interface SharedGatewayAutoscalingConfig {
  minHotMembers: number;
  targetAssignmentsPerMember: number;
  cooldownMs: number;
}

export interface SharedGatewayAutoscalingMember {
  gatewayId: string;
  desiredStatus: GatewayDesiredStatus;
  assignmentCount: number;
  mountedCount: number;
  incomingMigrationCount: number;
  converged: boolean;
}

export interface SharedGatewayAutoscalingInput {
  config: SharedGatewayAutoscalingConfig;
  members: readonly SharedGatewayAutoscalingMember[];
  now: number;
  lastAutoscalingActionAt: number | null;
}

export type SharedGatewayAutoscalingDecision =
  | {
      kind: "hold";
      reason:
        | "steady"
        | "cooldown"
        | "converging"
        | "draining"
        | "minimum-hot-members"
        | "malformed-config"
        | "malformed-state";
    }
  | {
      kind: "resume-member";
      gatewayId: string;
      reason: "minimum-hot-members" | "scale-out" | "cancel-drain";
    }
  | { kind: "begin-drain"; gatewayId: string }
  | { kind: "pause-drained-member"; gatewayId: string }
  | { kind: "max-capacity"; assignmentCount: number; hotMemberCount: number };

export interface SharedGatewayPoolConfig {
  defaultGatewayId: string;
  sharedGatewayIds: readonly string[];
  sharedGatewayAutoscaling?: SharedGatewayAutoscalingConfig;
}

export interface SharedGatewayPoolCandidate {
  gatewayId: string;
  gatewayClass: string;
  desiredStatus: string;
  managedBy?: unknown;
  ready: boolean;
  serving: boolean;
  heartbeatFresh: boolean;
  liveReleaseReady: boolean;
  rosterComplete: boolean;
  incomingMigrationCount: number;
  assignmentCount: number;
}

export type SharedGatewaySelection =
  | {
      kind: "selected";
      gatewayId: string;
      load: number;
      retainedCurrent: boolean;
    }
  | { kind: "blocked"; reason: "no-accepting-shared-gateway" };

export interface SharedGatewayRebalance {
  fromGatewayId: string;
  toGatewayId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

export function parseSharedGatewayPoolConfig(value: unknown): SharedGatewayPoolConfig | null {
  if (!isRecord(value) || !isValidGatewayId(value.defaultGatewayId)) return null;
  const rawSharedGatewayIds = value.sharedGatewayIds;
  if (!Array.isArray(rawSharedGatewayIds) || rawSharedGatewayIds.length === 0) return null;
  if (
    rawSharedGatewayIds[0] !== value.defaultGatewayId ||
    !rawSharedGatewayIds.every(isValidGatewayId) ||
    new Set(rawSharedGatewayIds).size !== rawSharedGatewayIds.length
  ) {
    return null;
  }
  const sharedGatewayAutoscaling = value.sharedGatewayAutoscaling === undefined
    ? undefined
    : parseSharedGatewayAutoscalingConfig(
      value.sharedGatewayAutoscaling,
      rawSharedGatewayIds.length,
    );
  if (value.sharedGatewayAutoscaling !== undefined && sharedGatewayAutoscaling === null) {
    return null;
  }
  return {
    defaultGatewayId: value.defaultGatewayId,
    sharedGatewayIds: rawSharedGatewayIds,
    ...(sharedGatewayAutoscaling ? { sharedGatewayAutoscaling } : {}),
  };
}

function isValidMinHotMembers(value: unknown, memberCount: number): value is number {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= DEFAULT_SHARED_GATEWAY_MIN_HOT_MEMBERS &&
    value <= memberCount;
}

function isValidTargetAssignmentsPerMember(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 2;
}

function isValidAutoscalingCooldown(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function parseSharedGatewayAutoscalingConfig(
  value: unknown,
  memberCount: number,
): SharedGatewayAutoscalingConfig | null {
  if (!Number.isInteger(memberCount) || memberCount < DEFAULT_SHARED_GATEWAY_MIN_HOT_MEMBERS) {
    return null;
  }
  if (value !== undefined && !isRecord(value)) return null;
  const config = value ?? {};
  if (!isRecord(config)) return null;
  const minHotMembers = config.minHotMembers ?? DEFAULT_SHARED_GATEWAY_MIN_HOT_MEMBERS;
  const targetAssignmentsPerMember =
    config.targetAssignmentsPerMember ?? DEFAULT_SHARED_GATEWAY_TARGET_ASSIGNMENTS_PER_MEMBER;
  const cooldownMs = config.cooldownMs ?? DEFAULT_SHARED_GATEWAY_AUTOSCALING_COOLDOWN_MS;
  if (
    !isValidMinHotMembers(minHotMembers, memberCount) ||
    !isValidTargetAssignmentsPerMember(targetAssignmentsPerMember) ||
    !isValidAutoscalingCooldown(cooldownMs)
  ) {
    return null;
  }
  return { minHotMembers, targetAssignmentsPerMember, cooldownMs };
}

export function authoritativeSharedGatewayLoad(candidate: SharedGatewayPoolCandidate): number {
  return candidate.assignmentCount + candidate.incomingMigrationCount;
}

export function isAcceptingSharedGateway(
  config: SharedGatewayPoolConfig,
  candidate: SharedGatewayPoolCandidate,
): boolean {
  return (
    config.sharedGatewayIds.includes(candidate.gatewayId) &&
    candidate.gatewayClass === "shared" &&
    candidate.desiredStatus === "running" &&
    !isOperatorManaged(candidate.managedBy) &&
    candidate.ready &&
    candidate.serving &&
    candidate.heartbeatFresh &&
    candidate.liveReleaseReady &&
    candidate.rosterComplete &&
    isNonNegativeInteger(candidate.assignmentCount) &&
    isNonNegativeInteger(candidate.incomingMigrationCount)
  );
}

export function stableGatewayUidHash(uid: string): number {
  let hash = 2166136261;
  for (let index = 0; index < uid.length; index += 1) {
    hash ^= uid.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function leastLoadedGatewayForUid(
  uid: string,
  candidates: readonly SharedGatewayPoolCandidate[],
): SharedGatewayPoolCandidate {
  const leastLoad = Math.min(...candidates.map(authoritativeSharedGatewayLoad));
  const ties = candidates
    .filter((candidate) => authoritativeSharedGatewayLoad(candidate) === leastLoad)
    .slice()
    .sort((left, right) => left.gatewayId.localeCompare(right.gatewayId));
  return ties[stableGatewayUidHash(uid) % ties.length]!;
}

export function selectSharedGateway(input: {
  uid: string;
  config: SharedGatewayPoolConfig;
  candidates: readonly SharedGatewayPoolCandidate[];
  currentGatewayId?: string | null;
}): SharedGatewaySelection {
  const accepting = input.candidates.filter((candidate) =>
    isAcceptingSharedGateway(input.config, candidate));
  if (accepting.length === 0) return { kind: "blocked", reason: "no-accepting-shared-gateway" };

  const selected = leastLoadedGatewayForUid(input.uid, accepting);
  const current = input.currentGatewayId === undefined || input.currentGatewayId === null
    ? undefined
    : accepting.find((candidate) => candidate.gatewayId === input.currentGatewayId);
  if (
    current &&
    authoritativeSharedGatewayLoad(current) - authoritativeSharedGatewayLoad(selected) <= 1
  ) {
    return {
      kind: "selected",
      gatewayId: current.gatewayId,
      load: authoritativeSharedGatewayLoad(current),
      retainedCurrent: true,
    };
  }
  return {
    kind: "selected",
    gatewayId: selected.gatewayId,
    load: authoritativeSharedGatewayLoad(selected),
    retainedCurrent: false,
  };
}

export function planSharedGatewayRebalance(input: {
  config: SharedGatewayPoolConfig;
  candidates: readonly SharedGatewayPoolCandidate[];
}): SharedGatewayRebalance | null {
  const accepting = input.candidates
    .filter((candidate) => isAcceptingSharedGateway(input.config, candidate))
    .slice();
  if (accepting.length < 2) return null;
  accepting.sort((left, right) => {
    const loadDifference = authoritativeSharedGatewayLoad(left) - authoritativeSharedGatewayLoad(right);
    return loadDifference !== 0 ? loadDifference : left.gatewayId.localeCompare(right.gatewayId);
  });
  const to = accepting[0]!;
  const from = accepting[accepting.length - 1]!;
  return authoritativeSharedGatewayLoad(from) - authoritativeSharedGatewayLoad(to) >= 2
    ? { fromGatewayId: from.gatewayId, toGatewayId: to.gatewayId }
    : null;
}
