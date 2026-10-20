import { isValidGatewayId } from "./glm.js";
import { isValidUsername } from "./identity.js";

export const BUILDER_IDENTITY_ROUTE = "/internal/fleet/builder-identity";
export const BUILDER_STANDBY_BOOT_ENV = "OCTOGEE_BUILDER_STANDBY_BOOT";

export type BuilderIdentityUnavailableReason = "retired" | "retiring" | "not-builder";

export interface ClaimedBuilderIdentity {
  gatewayId: string;
  state: "claimed";
  ownerUid: string;
  builderSlug: string;
  leaseId: string | null;
  generation: number | null;
}

export type BuilderIdentity =
  | { gatewayId: string; state: "standby" }
  | ClaimedBuilderIdentity
  | { gatewayId: string; state: "unavailable"; reason: BuilderIdentityUnavailableReason };

const UNAVAILABLE_REASONS: ReadonlySet<string> = new Set(["retired", "retiring", "not-builder"]);
const OWNER_UID_MAX_LENGTH = 128;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isBuilderOwnerUid(value: unknown): value is string {
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
  return isBuilderOwnerUid(value.ownerUid) && isValidUsername(value.builderSlug) &&
    isNullableLeaseId(value.leaseId) && isNullableGeneration(value.generation) &&
    (value.leaseId === null) === (value.generation === null);
}

export function parseBuilderIdentity(value: unknown, expectedGatewayId: string): BuilderIdentity | null {
  if (!isRecord(value) || value.gatewayId !== expectedGatewayId || !isValidGatewayId(value.gatewayId)) return null;
  if (value.state === "standby") return { gatewayId: value.gatewayId, state: "standby" };
  if (value.state === "unavailable" && typeof value.reason === "string" && UNAVAILABLE_REASONS.has(value.reason)) {
    return { gatewayId: value.gatewayId, state: "unavailable", reason: value.reason as BuilderIdentityUnavailableReason };
  }
  if (value.state !== "claimed" || !claimedIdentityFields(value)) return null;
  return {
    gatewayId: value.gatewayId,
    state: "claimed",
    ownerUid: value.ownerUid as string,
    builderSlug: value.builderSlug as string,
    leaseId: value.leaseId as string | null,
    generation: value.generation as number | null,
  };
}

export const BUILDER_CLAIM_FILE = "builder-claim.json";

export interface BuilderClaimRecord {
  schemaVersion: 1;
  gatewayId: string;
  ownerUid: string;
  builderSlug: string;
  leaseId: string | null;
  generation: number | null;
  claimedAt: number;
  adoptionPending: boolean;
  overlayAppliedAt: number | null;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function parseBuilderClaimRecord(value: unknown): BuilderClaimRecord | null {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isValidGatewayId(value.gatewayId)) return null;
  if (!claimedIdentityFields(value) || !isTimestamp(value.claimedAt)) return null;
  if (value.overlayAppliedAt !== null && !isTimestamp(value.overlayAppliedAt)) return null;
  if (value.adoptionPending !== undefined && typeof value.adoptionPending !== "boolean") return null;
  return {
    schemaVersion: 1,
    gatewayId: value.gatewayId,
    ownerUid: value.ownerUid as string,
    builderSlug: value.builderSlug as string,
    leaseId: value.leaseId as string | null,
    generation: value.generation as number | null,
    claimedAt: value.claimedAt,
    adoptionPending: value.adoptionPending === true,
    overlayAppliedAt: value.overlayAppliedAt as number | null,
  };
}

export function builderClaimFromIdentity(identity: ClaimedBuilderIdentity, claimedAt: number): BuilderClaimRecord {
  return {
    schemaVersion: 1,
    gatewayId: identity.gatewayId,
    ownerUid: identity.ownerUid,
    builderSlug: identity.builderSlug,
    leaseId: identity.leaseId,
    generation: identity.generation,
    claimedAt,
    adoptionPending: false,
    overlayAppliedAt: null,
  };
}

export function standbyClaimFromIdentity(identity: ClaimedBuilderIdentity, claimedAt: number): BuilderClaimRecord {
  return { ...builderClaimFromIdentity(identity, claimedAt), adoptionPending: true };
}

export function sameBuilderOwner(
  left: Pick<BuilderClaimRecord, "gatewayId" | "ownerUid" | "builderSlug">,
  right: Pick<BuilderClaimRecord, "gatewayId" | "ownerUid" | "builderSlug">,
): boolean {
  return left.gatewayId === right.gatewayId && left.ownerUid === right.ownerUid &&
    left.builderSlug === right.builderSlug;
}
