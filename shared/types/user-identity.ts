import { isValidGatewayId } from "./glm.js";
import { isValidUsername } from "./identity.js";

export const USER_IDENTITY_ROUTE = "/internal/fleet/builder-identity";

export type UserIdentityUnavailableReason = "retired" | "retiring" | "not-builder";

export interface ClaimedUserIdentity {
  gatewayId: string;
  state: "claimed";
  ownerUid: string;
  builderSlug: string;
  leaseId: string | null;
  generation: number | null;
  bootMode?: "prelaunch" | "normal" | "activating";
  activationMigrationId?: string;
}

export type UserIdentity =
  | ClaimedUserIdentity
  | { gatewayId: string; state: "unavailable"; reason: UserIdentityUnavailableReason };

const UNAVAILABLE_REASONS: ReadonlySet<string> = new Set(["retired", "retiring", "not-builder"]);
const OWNER_UID_MAX_LENGTH = 128;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isUserOwnerUid(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= OWNER_UID_MAX_LENGTH &&
    value.trim() === value && !value.includes("/");
}

function isNullableLeaseId(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.length > 0);
}

function isNullableGeneration(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value > 0);
}

function claimedIdentityFields(value: Record<string, unknown>): boolean {
  return isUserOwnerUid(value.ownerUid) && isValidUsername(value.builderSlug) &&
    isNullableLeaseId(value.leaseId) && isNullableGeneration(value.generation) &&
    (value.leaseId === null) === (value.generation === null);
}

function parseClaimedIdentity(value: Record<string, unknown>): ClaimedUserIdentity | null {
  if (value.state !== "claimed" || !claimedIdentityFields(value) ||
      (value.bootMode !== undefined && value.bootMode !== "prelaunch" && value.bootMode !== "normal" && value.bootMode !== "activating")) return null;
  if (value.bootMode === "activating" && (typeof value.activationMigrationId !== "string" || !value.activationMigrationId)) return null;
  return {
    gatewayId: value.gatewayId as string,
    state: "claimed",
    ownerUid: value.ownerUid as string,
    builderSlug: value.builderSlug as string,
    leaseId: value.leaseId as string | null,
    generation: value.generation as number | null,
    ...(value.bootMode !== undefined ? { bootMode: value.bootMode as "prelaunch" | "normal" | "activating" } : {}),
    ...(value.bootMode === "activating" ? { activationMigrationId: value.activationMigrationId as string } : {}),
  };
}

export function parseUserIdentity(value: unknown, expectedGatewayId: string): UserIdentity | null {
  if (!isRecord(value) || value.gatewayId !== expectedGatewayId || !isValidGatewayId(value.gatewayId)) return null;
  if (value.state === "unavailable" && typeof value.reason === "string" && UNAVAILABLE_REASONS.has(value.reason)) {
    return { gatewayId: value.gatewayId, state: "unavailable", reason: value.reason as UserIdentityUnavailableReason };
  }
  return parseClaimedIdentity(value);
}

export const USER_CLAIM_FILE = "builder-claim.json";

export interface UserClaimRecord {
  schemaVersion: 1;
  gatewayId: string;
  ownerUid: string;
  builderSlug: string;
  leaseId: string | null;
  generation: number | null;
  claimedAt: number;
  overlayAppliedAt: number | null;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function parseUserClaimRecord(value: unknown): UserClaimRecord | null {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isValidGatewayId(value.gatewayId)) return null;
  if (!claimedIdentityFields(value) || !isTimestamp(value.claimedAt)) return null;
  if (value.overlayAppliedAt !== null && !isTimestamp(value.overlayAppliedAt)) return null;
  return {
    schemaVersion: 1,
    gatewayId: value.gatewayId,
    ownerUid: value.ownerUid as string,
    builderSlug: value.builderSlug as string,
    leaseId: value.leaseId as string | null,
    generation: value.generation as number | null,
    claimedAt: value.claimedAt,
    overlayAppliedAt: value.overlayAppliedAt as number | null,
  };
}

export function userClaimFromIdentity(identity: ClaimedUserIdentity, claimedAt: number): UserClaimRecord {
  return {
    schemaVersion: 1,
    gatewayId: identity.gatewayId,
    ownerUid: identity.ownerUid,
    builderSlug: identity.builderSlug,
    leaseId: identity.leaseId,
    generation: identity.generation,
    claimedAt,
    overlayAppliedAt: null,
  };
}

export function sameUserOwner(
  left: Pick<UserClaimRecord, "gatewayId" | "ownerUid" | "builderSlug">,
  right: Pick<UserClaimRecord, "gatewayId" | "ownerUid" | "builderSlug">,
): boolean {
  return left.gatewayId === right.gatewayId && left.ownerUid === right.ownerUid &&
    left.builderSlug === right.builderSlug;
}
