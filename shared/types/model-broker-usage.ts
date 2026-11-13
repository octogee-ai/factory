// Storage contract for the LLM egress broker's per-owner usage metering. Single
// source so the broker (octogee-api, write side) and the usage panel (gateway-edge,
// read side) can never drift on collection names or the window-key math.

export const MODEL_BROKER_USAGE_EVENTS_COLLECTION = "modelBrokerUsageEvents";
export const MODEL_BROKER_USAGE_ROLLUPS_COLLECTION = "modelBrokerUsageRollups";
export const MODEL_BROKER_USAGE_WINDOWS_COLLECTION = "modelBrokerUsageWindows";
export const MODEL_BROKER_WEEK_WINDOWS_COLLECTION = "modelBrokerWeekWindows";
export const MODEL_BROKER_RATE_WINDOWS_COLLECTION = "modelBrokerRateWindows";

export const MODEL_BROKER_TOKENS_COLLECTION = "modelBrokerTokens";
export const MODEL_BROKER_GATEWAY_POINTERS_COLLECTION = "modelBrokerGatewayTokens";

export const WINDOW_LENGTH_HOURS = 4;
export const MODEL_BROKER_USAGE_WINDOW_MS = WINDOW_LENGTH_HOURS * 60 * 60 * 1000;
// Epoch-aligned fixed weeks (epoch day 0 was a Thursday, so weeks reset
// Thursday 00:00 UTC) — same one-doc-read shape as the 4h windows, no
// trailing-sum scans or composite indexes.
export const MODEL_BROKER_WEEK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const MODEL_BROKER_RATE_WINDOW_MS = 60 * 1000;

// Counters key on the billing owner, not the gateway: a shared pool hosts N
// users behind one gatewayId, and ownerUid is null only for single-tenant
// user/operator pods where the gateway *is* the owner.
export function windowOwnerKey(input: { ownerUid?: string | null; gatewayId: string }): string {
  return input.ownerUid ?? input.gatewayId;
}

export function usageWindowStartMs(now: number): number {
  return Math.floor(now / MODEL_BROKER_USAGE_WINDOW_MS) * MODEL_BROKER_USAGE_WINDOW_MS;
}

export function weekWindowStartMs(now: number): number {
  return Math.floor(now / MODEL_BROKER_WEEK_WINDOW_MS) * MODEL_BROKER_WEEK_WINDOW_MS;
}

export function rateWindowStartMs(now: number): number {
  return Math.floor(now / MODEL_BROKER_RATE_WINDOW_MS) * MODEL_BROKER_RATE_WINDOW_MS;
}

export function modelBrokerWindowDocId(ownerKey: string, windowStartMs: number): string {
  return `${ownerKey}_${windowStartMs}`;
}

export type ModelAccess = "house_only" | "catalog";

export function spendWindowPercentUsed(costUsd: number, budgetUsd: number): number {
  if (budgetUsd <= 0) return 100;
  return Math.min(100, Math.round((costUsd / budgetUsd) * 100));
}

export type SpendBudgetWindow = "week" | "window";

export function exhaustedSpendBudget(input: {
  windowCostUsd: number;
  windowBudgetUsd: number;
  weekCostUsd: number;
  weekBudgetUsd: number;
}): SpendBudgetWindow | null {
  if (input.weekCostUsd >= input.weekBudgetUsd) return "week";
  if (input.windowCostUsd >= input.windowBudgetUsd) return "window";
  return null;
}

export interface SpendThrottleState {
  degraded: boolean;
  blocked: boolean;
  reason: string | null;
}
