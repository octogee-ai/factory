import { type SharedPoolReplacement } from "@octogee/shared/types/shared-gateway-pool";
import type { SharedPoolScalerState } from "../controller-state.js";
import { type RecordKey } from "../errors.js";
import type { OpaqueMap } from "../store.js";
export declare const SCALER_KEY: RecordKey;
export declare function isNonNegativeInteger(value: unknown): value is number;
export declare function isPlainMap(value: unknown): value is OpaqueMap;
export declare function parseReplacements(value: unknown): SharedPoolReplacement[];
export declare function parseSharedPoolScalerState(data: Readonly<Record<string, unknown>>): SharedPoolScalerState;
