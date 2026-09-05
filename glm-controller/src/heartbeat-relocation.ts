import { isGatewayDesiredDoc } from "@octogee/shared/types/gateway-releases";
import { GATEWAY_HEARTBEAT_INTERVAL_MS } from "@octogee/shared/types/fleet-controller";

export const HEARTBEAT_FIELD = "heartbeat";

// The dual-written flat heartbeat fields on gateways/{id}. Cleared (not deleted)
// when the doc is a durable GatewayDoc that retire must preserve.
export const LEGACY_HEARTBEAT_FIELDS = [
  "status",
  "version",
  "openclawVersion",
  "internalUrl",
  "startedAt",
  "mountedCustomers",
  "lastHeartbeatAt",
  "lastError",
] as const;

// Retire teardown decision for gateways/{id}: a durable GatewayDoc (holds the
// release subcollection) must be PRESERVED — only its dual-written heartbeat
// fields are cleared. A legacy heartbeat-only doc is deleted outright. This is
// the P0 guard: retire must never delete the GatewayDoc + release history.
export function heartbeatTeardownAction(data: unknown): "clear" | "delete" {
  return isGatewayDesiredDoc(data) ? "clear" : "delete";
}

export interface PollerHeartbeatRecord {
  status: string;
  mountedCustomers: string[];
  startedAt?: number;
  version?: string;
  openclawVersion?: string;
}

// glmGateways/{id} merge payload for the poller's live telemetry.
export function revisionHeartbeatMerge(
  record: PollerHeartbeatRecord,
  lastHeartbeatAt: unknown,
): { heartbeat: Record<string, unknown> } {
  const heartbeat: Record<string, unknown> = {
    status: record.status,
    mountedCustomers: record.mountedCustomers,
    lastHeartbeatAt,
  };
  if (typeof record.startedAt === "number") heartbeat.startedAt = record.startedAt;
  if (typeof record.version === "string") heartbeat.version = record.version;
  if (typeof record.openclawVersion === "string") {
    heartbeat.openclawVersion = record.openclawVersion;
  }
  return { [HEARTBEAT_FIELD]: heartbeat };
}

// Must stay a poll interval inside the OpenClaw control readiness window.
export const HEARTBEAT_REFRESH_MS = GATEWAY_HEARTBEAT_INTERVAL_MS * 3;

function plainRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function withoutPollerStamps(heartbeat: Record<string, unknown>): Record<string, unknown> {
  const comparable: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(heartbeat)) {
    if (field === "lastHeartbeatAt") continue;
    comparable[field] = value;
  }
  return comparable;
}

function alreadyStored(stored: unknown, candidate: unknown): boolean {
  if (Array.isArray(candidate)) {
    return Array.isArray(stored) &&
      stored.length === candidate.length &&
      candidate.every((item, index) => alreadyStored(stored[index], item));
  }
  const candidateRecord = plainRecord(candidate);
  if (!candidateRecord) return Object.is(stored, candidate);
  const storedRecord = plainRecord(stored);
  return storedRecord !== null &&
    Object.entries(candidateRecord).every(
      ([field, value]) => alreadyStored(storedRecord[field], value),
    );
}

export function heartbeatMergeIsRedundant(
  stored: unknown,
  candidate: Record<string, unknown>,
  now: number,
): boolean {
  const current = plainRecord(stored);
  if (!current) return false;
  const lastHeartbeatAt = coerceMillis(current.lastHeartbeatAt);
  if (lastHeartbeatAt === null) return false;
  if (lastHeartbeatAt > now || now - lastHeartbeatAt >= HEARTBEAT_REFRESH_MS) return false;
  return alreadyStored(withoutPollerStamps(current), withoutPollerStamps(candidate));
}

function heartbeatSubDoc(glmData: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const hb = glmData?.[HEARTBEAT_FIELD];
  return hb && typeof hb === "object" && !Array.isArray(hb) ? (hb as Record<string, unknown>) : undefined;
}

export function readHeartbeatLiveness(
  glmData: Record<string, unknown> | undefined,
): { lastHeartbeatAt: number; version?: string | null } | null {
  const source = heartbeatSubDoc(glmData);
  if (!source) return null;
  const ms = coerceMillis(source.lastHeartbeatAt);
  if (ms == null) return null;
  return {
    lastHeartbeatAt: ms,
    version: typeof source.version === "string" ? source.version : null,
  };
}

export function readMountedCustomers(
  glmData: Record<string, unknown> | undefined,
): string[] {
  const source = heartbeatSubDoc(glmData);
  const raw = source?.mountedCustomers;
  return Array.isArray(raw) ? raw.filter((s): s is string => typeof s === "string") : [];
}

function coerceMillis(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw === "number") return raw;
  if (raw instanceof Date) return raw.getTime();
  if (typeof (raw as { toMillis?: () => number }).toMillis === "function") {
    return (raw as { toMillis: () => number }).toMillis();
  }
  return null;
}
