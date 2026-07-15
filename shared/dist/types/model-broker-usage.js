import { WINDOW_LENGTH_HOURS } from "./billing.js";
// Storage contract for the LLM egress broker's per-owner usage metering. Single
// source so the broker (octogee-api, write side) and the usage panel (gateway-edge,
// read side) can never drift on collection names or the window-key math.
export const MODEL_BROKER_USAGE_EVENTS_COLLECTION = "modelBrokerUsageEvents";
export const MODEL_BROKER_USAGE_ROLLUPS_COLLECTION = "modelBrokerUsageRollups";
export const MODEL_BROKER_USAGE_WINDOWS_COLLECTION = "modelBrokerUsageWindows";
export const MODEL_BROKER_WEEK_WINDOWS_COLLECTION = "modelBrokerWeekWindows";
export const MODEL_BROKER_RATE_WINDOWS_COLLECTION = "modelBrokerRateWindows";
export const MODEL_BROKER_CREDITS_COLLECTION = "modelBrokerCredits";
export const MODEL_BROKER_CREDIT_TOPUPS_COLLECTION = "modelBrokerCreditTopups";
export const MODEL_BROKER_USAGE_WINDOW_MS = WINDOW_LENGTH_HOURS * 60 * 60 * 1000;
// Epoch-aligned fixed weeks (epoch day 0 was a Thursday, so weeks reset
// Thursday 00:00 UTC) — same one-doc-read shape as the 4h windows, no
// trailing-sum scans or composite indexes.
export const MODEL_BROKER_WEEK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const MODEL_BROKER_RATE_WINDOW_MS = 60 * 1000;
// Counters key on the billing owner, not the gateway: a shared pool hosts N
// builders behind one gatewayId, and ownerUid is null only for single-tenant
// builder/operator pods where the gateway *is* the owner.
export function windowOwnerKey(input) {
    return input.ownerUid ?? input.gatewayId;
}
export function usageWindowStartMs(now) {
    return Math.floor(now / MODEL_BROKER_USAGE_WINDOW_MS) * MODEL_BROKER_USAGE_WINDOW_MS;
}
export function weekWindowStartMs(now) {
    return Math.floor(now / MODEL_BROKER_WEEK_WINDOW_MS) * MODEL_BROKER_WEEK_WINDOW_MS;
}
export function rateWindowStartMs(now) {
    return Math.floor(now / MODEL_BROKER_RATE_WINDOW_MS) * MODEL_BROKER_RATE_WINDOW_MS;
}
export function modelBrokerWindowDocId(ownerKey, windowStartMs) {
    return `${ownerKey}_${windowStartMs}`;
}
