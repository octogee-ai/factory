import { type SharedPoolReplacement, parseSharedPoolReplacements } from "@octogee/shared/types/shared-gateway-pool";
import type { SharedPoolScalerState } from "../controller-state.js";
import { MalformedRecordError, type RecordKey } from "../errors.js";
import type { OpaqueMap } from "../store.js";

export const SCALER_KEY: RecordKey = { aggregate: "shared-pool-scaler", key: "sharedPoolScaler" };
export function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isPlainMap(value: unknown): value is OpaqueMap {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseReplacements(value: unknown): SharedPoolReplacement[] {
  try {
    return parseSharedPoolReplacements(value);
  } catch (error) {
    throw new MalformedRecordError(SCALER_KEY, error instanceof Error ? error.message : String(error));
  }
}

export function parseSharedPoolScalerState(data: Readonly<Record<string, unknown>>): SharedPoolScalerState {
  const { schemaVersion, actionSequence, lastActionAt, lastAction, updatedAt } = data;
  if (schemaVersion !== 1) throw new MalformedRecordError(SCALER_KEY, `schemaVersion is ${JSON.stringify(schemaVersion)}`);
  if (!isNonNegativeInteger(actionSequence)) throw new MalformedRecordError(SCALER_KEY, "actionSequence is not a nonnegative integer");
  if (lastActionAt !== null && !isNonNegativeInteger(lastActionAt)) {
    throw new MalformedRecordError(SCALER_KEY, "lastActionAt is neither null nor a nonnegative integer");
  }
  if (lastAction !== undefined && lastAction !== null && !isPlainMap(lastAction)) {
    throw new MalformedRecordError(SCALER_KEY, "lastAction is not a map");
  }
  if (updatedAt !== undefined && !isNonNegativeInteger(updatedAt)) {
    throw new MalformedRecordError(SCALER_KEY, "updatedAt is not a nonnegative integer");
  }
  return {
    schemaVersion,
    actionSequence,
    lastActionAt,
    replacements: parseReplacements(data.replacements),
    ...(lastAction === undefined ? {} : { lastAction }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
  };
}
