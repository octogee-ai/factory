// Heartbeat/readiness telemetry relocation (GATEWAY-RELEASES-SPEC cutover step 2).
//
// The live heartbeat/readiness telemetry now lives at `glmGateways/{id}.heartbeat`
// (keyed by the current instance id until revision docs exist). This is the
// collision fix that frees `gateways/{id}` to become the desired-doc collection.
//
// During expand, writers dual-write the legacy `gateways/{id}` flat doc so
// out-of-lane readers (octogee-api broker, gateway-edge billing) keep working
// until PR4/PR5 migrate them; readers here prefer the new location and fall back
// to the legacy flat doc.

import { isGatewayDesiredDoc } from "@octogee/shared/types/gateway-releases";
import type { GatewayConfigStatus } from "@octogee/shared/types/fleet-controller";

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
  configStatus?: GatewayConfigStatus;
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
  if (record.configStatus) {
    heartbeat.configStatus = { ...record.configStatus, observedAt: lastHeartbeatAt };
  }
  return { [HEARTBEAT_FIELD]: heartbeat };
}

function heartbeatSubDoc(glmData: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const hb = glmData?.[HEARTBEAT_FIELD];
  return hb && typeof hb === "object" && !Array.isArray(hb) ? (hb as Record<string, unknown>) : undefined;
}

// Reads lastHeartbeatAt (+ version) preferring glmGateways/{id}.heartbeat and
// falling back to the legacy flat gateways/{id} doc during expand.
export function readHeartbeatLiveness(
  glmData: Record<string, unknown> | undefined,
  legacyData: Record<string, unknown> | undefined,
): { lastHeartbeatAt: number; version?: string | null } | null {
  const source = heartbeatSubDoc(glmData) ?? legacyData;
  if (!source) return null;
  const ms = coerceMillis(source.lastHeartbeatAt);
  if (ms == null) return null;
  return {
    lastHeartbeatAt: ms,
    version: typeof source.version === "string" ? source.version : null,
  };
}

// Reads the mounted-customer set preferring glmGateways/{id}.heartbeat and
// falling back to the legacy flat gateways/{id} doc during expand.
export function readMountedCustomers(
  glmData: Record<string, unknown> | undefined,
  legacyData: Record<string, unknown> | undefined,
): string[] {
  const source = heartbeatSubDoc(glmData) ?? legacyData;
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
